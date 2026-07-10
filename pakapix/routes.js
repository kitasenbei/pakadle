// Pakapix routes, mounted by the Pakadle server under /pakapix.
// Daily "guess the pixelated Umamusume" game. Shares the visitor cookie and the
// SQLite handle with Pakadle, but uses its own tables (pix_*) and its own data.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

module.exports = function pakapix(db) {
    const ROOT = __dirname; // umagent/pakapix
    const MAX_GUESSES = 6;
    const DAILY_EPOCH = "2026-01-01";
    const WORDS = new Function(
        fs.readFileSync(path.join(ROOT, "words.js"), "utf8") +
            "\nreturn UMA_WORDS;",
    )();

    // PAKAPIX_TEST=1 -> random uma on every page load, ephemeral, no daily lock (local playtesting)
    const TEST = process.env.PAKAPIX_TEST === "1";
    const sessions = new Map(); // pid -> { idx, guesses, finished, won }

    db.exec(`
    CREATE TABLE IF NOT EXISTS pix_puzzles (date TEXT PRIMARY KEY, number INTEGER NOT NULL, idx INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_plays (
      pid TEXT NOT NULL, date TEXT NOT NULL, guesses TEXT NOT NULL DEFAULT '[]',
      finished INTEGER NOT NULL DEFAULT 0, won INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, PRIMARY KEY (pid, date)
    );
  `);

    const todayStr = () => new Date().toISOString().slice(0, 10);
    const dayNumber = (d) =>
        Math.floor(
            (Date.parse(d + "T00:00:00Z") -
                Date.parse(DAILY_EPOCH + "T00:00:00Z")) /
                86400000,
        );
    function secondsUntilRollover() {
        const n = new Date();
        const nx = Date.UTC(
            n.getUTCFullYear(),
            n.getUTCMonth(),
            n.getUTCDate() + 1,
            0,
            0,
            0,
        );
        return Math.max(0, Math.floor((nx - n.getTime()) / 1000));
    }
    function puzzleForDate(d) {
        let r = db
            .prepare("SELECT date, number, idx FROM pix_puzzles WHERE date = ?")
            .get(d);
        if (!r) {
            const number = dayNumber(d);
            const idx =
                (((number * 7 + 3) % WORDS.length) + WORDS.length) %
                WORDS.length; // different stride than Pakadle
            db.prepare(
                "INSERT INTO pix_puzzles (date, number, idx) VALUES (?, ?, ?)",
            ).run(d, number, idx);
            r = { date: d, number, idx };
        }
        return r;
    }
    const norm = (s) =>
        String(s)
            .toLowerCase()
            .replace(/[^a-z]/g, "");
    const isCorrect = (g, e) => {
        const n = norm(g);
        return !!n && (n === norm(e.word) || n === norm(e.name));
    };
    function getPlay(pid, date) {
        const r = db
            .prepare(
                "SELECT guesses, finished, won FROM pix_plays WHERE pid = ? AND date = ?",
            )
            .get(pid, date);
        return {
            guesses: r ? JSON.parse(r.guesses) : [],
            finished: r ? !!r.finished : false,
            won: r ? !!r.won : false,
        };
    }
    const revealLevel = (p) => (p.finished ? 6 : Math.min(p.guesses.length, 5));
    function computeStats(pid) {
        const rows = db
            .prepare(
                "SELECT date, won, guesses FROM pix_plays WHERE pid = ? AND finished = 1 ORDER BY date",
            )
            .all(pid);
        const played = rows.length;
        const wins = rows.filter((r) => r.won).length;
        const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
        rows.forEach((r) => {
            if (r.won) {
                const n = JSON.parse(r.guesses).length;
                if (dist[n] !== undefined) dist[n]++;
            }
        });
        let streak = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
            if (!rows[i].won) break;
            if (i === rows.length - 1) streak = 1;
            else if (
                dayNumber(rows[i + 1].date) - dayNumber(rows[i].date) ===
                1
            )
                streak++;
            else break;
        }
        return {
            played,
            wins,
            winRate: played ? Math.round((wins / played) * 100) : 0,
            streak,
            dist,
        };
    }
    function ensurePid(req, res) {
        const m = (req.headers.cookie || "").match(
            /(?:^|;\s*)pid=([A-Za-z0-9-]+)/,
        );
        if (m) return m[1];
        const pid = crypto.randomUUID();
        const secure =
            req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.setHeader(
            "Set-Cookie",
            `pid=${pid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
        );
        return pid;
    }
    function sendJson(res, obj, code = 200) {
        res.writeHead(code, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(obj));
    }
    function readBody(req, cb) {
        let d = "";
        req.on("data", (c) => {
            d += c;
            if (d.length > 1e6) req.destroy();
        });
        req.on("end", () => cb(d));
    }

    const MIME = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
    };
    function serveFile(res, name) {
        fs.readFile(path.join(ROOT, name), (err, buf) => {
            if (err) {
                res.writeHead(404);
                return res.end("not found");
            }
            res.writeHead(200, {
                "Content-Type":
                    MIME[path.extname(name)] || "application/octet-stream",
            });
            res.end(buf);
        });
    }

    return {
        handle(req, res, url) {
            const pid = ensurePid(req, res);
            const sub = url.pathname.slice("/pakapix".length); // "", "/", "/api/daily", "/style.css", ...

            if (sub === "" || sub === "/") return serveFile(res, "index.html");
            if (sub === "/style.css" || sub === "/game.js")
                return serveFile(res, sub.slice(1));

            if (sub === "/api/names" && req.method === "GET") {
                return sendJson(
                    res,
                    WORDS.map((e) => ({ name: e.name, word: e.word })).sort(
                        (a, b) => a.name.localeCompare(b.name),
                    ),
                );
            }

            if (sub === "/api/daily" && req.method === "GET") {
                if (TEST) {
                    const idx = Math.floor(Math.random() * WORDS.length);
                    sessions.set(pid, {
                        idx,
                        guesses: [],
                        finished: false,
                        won: false,
                    });
                    return sendJson(res, {
                        test: true,
                        number: 0,
                        maxGuesses: MAX_GUESSES,
                        guesses: [],
                        level: 0,
                        finished: false,
                        won: false,
                        secondsUntilRollover: 0,
                        stats: {
                            played: 0,
                            wins: 0,
                            winRate: 0,
                            streak: 0,
                            dist: {},
                        },
                    });
                }
                const date = todayStr();
                const p = puzzleForDate(date);
                const play = getPlay(pid, date);
                const out = {
                    date,
                    number: p.number,
                    maxGuesses: MAX_GUESSES,
                    guesses: play.guesses,
                    level: revealLevel(play),
                    finished: play.finished,
                    won: play.won,
                    secondsUntilRollover: secondsUntilRollover(),
                    stats: computeStats(pid),
                };
                if (play.finished) {
                    const e = WORDS[p.idx];
                    out.reveal = { word: e.word, name: e.name, quote: e.quote };
                }
                return sendJson(res, out);
            }

            if (sub === "/api/portrait" && req.method === "GET") {
                if (TEST) {
                    const s = sessions.get(pid);
                    if (!s) {
                        res.writeHead(404);
                        return res.end("no session");
                    }
                    const lvl = s.finished ? 6 : Math.min(s.guesses.length, 5);
                    return fs.readFile(
                        path.join(
                            ROOT,
                            "assets",
                            "p",
                            String(s.idx),
                            `l${lvl}.png`,
                        ),
                        (err, buf) => {
                            if (err) {
                                res.writeHead(404);
                                return res.end("not found");
                            }
                            res.writeHead(200, {
                                "Content-Type": "image/png",
                                "Cache-Control": "no-store",
                            });
                            res.end(buf);
                        },
                    );
                }
                const date = todayStr();
                const p = puzzleForDate(date);
                const play = getPlay(pid, date);
                const lvl = revealLevel(play);
                return fs.readFile(
                    path.join(
                        ROOT,
                        "assets",
                        "p",
                        String(p.idx),
                        `l${lvl}.png`,
                    ),
                    (err, buf) => {
                        if (err) {
                            res.writeHead(404);
                            return res.end("not found");
                        }
                        res.writeHead(200, {
                            "Content-Type": "image/png",
                            "Cache-Control": "no-store",
                        });
                        res.end(buf);
                    },
                );
            }

            if (sub === "/api/guess" && req.method === "POST") {
                return readBody(req, (body) => {
                    let data;
                    try {
                        data = JSON.parse(body);
                    } catch {
                        return sendJson(res, { error: "bad json" }, 400);
                    }
                    if (TEST) {
                        const s = sessions.get(pid);
                        if (!s)
                            return sendJson(res, { error: "no session" }, 409);
                        if (s.finished)
                            return sendJson(
                                res,
                                { error: "already finished" },
                                409,
                            );
                        const raw = String(data.guess || "")
                            .trim()
                            .slice(0, 40);
                        if (!raw) return sendJson(res, { error: "empty" }, 400);
                        const e = WORDS[s.idx];
                        const correct = isCorrect(raw, e);
                        s.guesses.push(raw);
                        const won = correct;
                        const finished = won || s.guesses.length >= MAX_GUESSES;
                        s.finished = finished;
                        s.won = won;
                        const out = {
                            correct,
                            guess: raw,
                            guessesMade: s.guesses.length,
                            level: finished ? 6 : Math.min(s.guesses.length, 5),
                            finished,
                            won,
                        };
                        if (finished) {
                            out.reveal = {
                                word: e.word,
                                name: e.name,
                                quote: e.quote,
                            };
                            out.stats = {
                                played: 0,
                                wins: 0,
                                winRate: 0,
                                streak: 0,
                                dist: {},
                            };
                        }
                        return sendJson(res, out);
                    }
                    const date = todayStr();
                    const p = puzzleForDate(date);
                    const e = WORDS[p.idx];
                    const play = getPlay(pid, date);
                    if (play.finished)
                        return sendJson(
                            res,
                            { error: "already finished" },
                            409,
                        );
                    if (play.guesses.length >= MAX_GUESSES)
                        return sendJson(res, { error: "no guesses left" }, 409);
                    const raw = String(data.guess || "")
                        .trim()
                        .slice(0, 40);
                    if (!raw) return sendJson(res, { error: "empty" }, 400);
                    const correct = isCorrect(raw, e);
                    const guesses = play.guesses.concat(raw);
                    const won = correct;
                    const finished = won || guesses.length >= MAX_GUESSES;
                    db.prepare(
                        `INSERT INTO pix_plays (pid, date, guesses, finished, won, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(pid, date) DO UPDATE SET guesses=excluded.guesses, finished=excluded.finished, won=excluded.won, updated_at=excluded.updated_at`,
                    ).run(
                        pid,
                        date,
                        JSON.stringify(guesses),
                        finished ? 1 : 0,
                        won ? 1 : 0,
                        new Date().toISOString(),
                    );
                    const out = {
                        correct,
                        guess: raw,
                        guessesMade: guesses.length,
                        level: finished ? 6 : Math.min(guesses.length, 5),
                        finished,
                        won,
                    };
                    if (finished) {
                        out.reveal = {
                            word: e.word,
                            name: e.name,
                            quote: e.quote,
                        };
                        out.stats = computeStats(pid);
                    }
                    return sendJson(res, out);
                });
            }

            res.writeHead(404);
            res.end("not found");
        },
    };
};
