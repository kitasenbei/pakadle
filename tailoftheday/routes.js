"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

module.exports = function tailoftheday(db) {
    const ROOT = __dirname;

    const MAX_GUESSES = 6;
    const DAILY_EPOCH = "2026-01-01";

    const CROPPED_DIR = path.join(ROOT, "cropped_horse");

    const UMA_WORDS = new Function(
        fs.readFileSync(path.join(ROOT, "words.js"), "utf8") +
            "\nreturn UMA_WORDS;",
    )();

    const WORDS = UMA_WORDS.map((u) => ({
        id: u.word.toLowerCase(),
        word: u.word,
        name: u.name,
    }));
    const INFINITE_MODE = process.env.PAKAPIX_TEST === "1";

    const sessions = new Map();

    const norm = (s) =>
        String(s)
            .toLowerCase()
            .replace(/[^a-z]/g, "");

    const isCorrect = (guess, horse) => {
        const g = norm(guess);
        return g === norm(horse.word) || g === norm(horse.name);
    };
    db.exec(`
    CREATE TABLE IF NOT EXISTS tail_puzzles (
        date TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        horse_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tail_plays (
        pid TEXT NOT NULL,
        date TEXT NOT NULL,
        guesses TEXT NOT NULL DEFAULT '[]',
        finished INTEGER NOT NULL DEFAULT 0,
        won INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,

        PRIMARY KEY(pid, date)
    );
    `);

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function dayNumber(d) {
        return Math.floor(
            (Date.parse(d + "T00:00:00Z") -
                Date.parse(DAILY_EPOCH + "T00:00:00Z")) /
                86400000,
        );
    }

    function secondsUntilRollover() {
        const now = new Date();

        const next = Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0,
            0,
            0,
        );

        return Math.max(0, Math.floor((next - now.getTime()) / 1000));
    }

    function puzzleForDate(date) {
        let row = db
            .prepare(
                `
            SELECT date, number, horse_id
            FROM tail_puzzles
            WHERE date = ?
        `,
            )
            .get(date);

        if (!row) {
            const number = dayNumber(date);

            const idx =
                (((number * 7 + 3) % WORDS.length) + WORDS.length) %
                WORDS.length;

            const horse = WORDS[idx];

            db.prepare(
                `
            INSERT INTO tail_puzzles
            (date, number, horse_id)
            VALUES (?, ?, ?)
        `,
            ).run(date, number, horse.id);

            row = {
                date,
                number,
                horse_id: horse.id,
            };
        }

        return row;
    }

    function ensurePid(req, res) {
        const cookie = req.headers.cookie || "";

        const match = cookie.match(/(?:^|;\s*)pid=([A-Za-z0-9-]+)/);

        if (match) return match[1];

        const pid = crypto.randomUUID();

        res.setHeader(
            "Set-Cookie",
            `pid=${pid}; Path=/; SameSite=Lax; Max-Age=31536000`,
        );

        return pid;
    }

    function getPlay(pid, date) {
        const row = db
            .prepare(
                `
                SELECT guesses,finished,won
                FROM tail_plays
                WHERE pid=? AND date=?
                `,
            )
            .get(pid, date);

        return {
            guesses: row ? JSON.parse(row.guesses) : [],
            finished: row ? !!row.finished : false,
            won: row ? !!row.won : false,
        };
    }

    function savePlay(pid, date, guesses, finished, won) {
        db.prepare(
            `
            INSERT INTO tail_plays
            (
                pid,
                date,
                guesses,
                finished,
                won,
                updated_at
            )
            VALUES (?,?,?,?,?,?)

            ON CONFLICT(pid,date)
            DO UPDATE SET
                guesses=excluded.guesses,
                finished=excluded.finished,
                won=excluded.won,
                updated_at=excluded.updated_at
            `,
        ).run(
            pid,
            date,
            JSON.stringify(guesses),
            finished ? 1 : 0,
            won ? 1 : 0,
            new Date().toISOString(),
        );
    }
    function computeStats(pid) {
        const rows = db
            .prepare(
                `
            SELECT date, won, guesses
            FROM tail_plays
            WHERE pid=?
            AND finished=1
            ORDER BY date
            `,
            )
            .all(pid);

        const played = rows.length;
        const wins = rows.filter((r) => r.won).length;

        let streak = 0;

        for (let i = rows.length - 1; i >= 0; i--) {
            if (!rows[i].won) break;

            if (i === rows.length - 1) {
                streak = 1;
            } else if (
                dayNumber(rows[i + 1].date) - dayNumber(rows[i].date) ===
                1
            ) {
                streak++;
            } else {
                break;
            }
        }

        return {
            played,
            wins,
            winRate: played ? Math.round((wins / played) * 100) : 0,
            streak,
        };
    }
    function sendJson(res, obj, code = 200) {
        res.writeHead(code, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        });

        res.end(JSON.stringify(obj));
    }

    const MIME = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
    };

    function serveFile(res, file) {
        fs.readFile(path.join(ROOT, file), (err, buf) => {
            if (err) {
                res.writeHead(404);
                return res.end("not found");
            }

            res.writeHead(200, {
                "Content-Type":
                    MIME[path.extname(file)] || "application/octet-stream",
            });

            res.end(buf);
        });
    }

    function serveHorseImage(res, word) {
        const safe = word.toLowerCase().replace(/[^a-z0-9]/g, "");

        const file = path.join(CROPPED_DIR, `${safe}.png`);

        fs.readFile(file, (err, buf) => {
            if (err) {
                res.writeHead(404);
                return res.end("horse image missing");
            }

            res.writeHead(200, {
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
            });

            res.end(buf);
        });
    }

    return {
        handle(req, res, url) {
            const pid = ensurePid(req, res);

            const sub = url.pathname.slice("/tailoftheday".length);

            if (sub === "" || sub === "/") {
                return serveFile(res, "index.html");
            }

            if (sub === "/style.css" || sub === "/game.js") {
                return serveFile(res, sub.slice(1));
            }

            /*
             * autocomplete names
             */
            if (sub === "/api/names" && req.method === "GET") {
                return sendJson(
                    res,
                    WORDS.map((w) => ({
                        name: w.name,
                        word: w.word,
                    })).sort((a, b) => a.name.localeCompare(b.name)),
                );
            }

            /*
             * get full horse image
             *
             * /api/horse/specialweek
             */
            if (sub.startsWith("/api/horse/")) {
                const id = sub.slice("/api/horse/".length);

                return serveHorseImage(res, id);
            }

            /*
             * daily puzzle
             */
            if (sub === "/api/daily" && req.method === "GET") {
                if (INFINITE_MODE) {
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
                        guesses: [],
                        maxGuesses: MAX_GUESSES,
                        level: 0,
                        finished: false,
                        won: false,
                        secondsUntilRollover: 0,
                        stats: {
                            played: 0,
                            wins: 0,
                            winRate: 0,
                            streak: 0,
                        },
                    });
                }

                const date = todayStr();

                const puzzle = puzzleForDate(date);

                const play = getPlay(pid, date);

                const out = {
                    number: puzzle.number,
                    guesses: play.guesses,
                    finished: play.finished,
                    won: play.won,
                    maxGuesses: MAX_GUESSES,
                    secondsUntilRollover: secondsUntilRollover(),
                    stats: computeStats(pid),
                };

                if (play.finished) {
                    const horse = WORDS.find(
                        (h) => h.id === puzzle.horse_id,
                    );

                    out.reveal = {
                        id: puzzle.horse_id,
                        name: horse.name,
                        word: horse.word,
                        image: `/tailoftheday/api/horse/${horse.word}`,
                    };
                }

                return sendJson(res, out);
            }

            /*
             * portrait/tail
             */
            if (sub === "/api/portrait" && req.method === "GET") {
                let horse;

                if (INFINITE_MODE) {
                    const session = sessions.get(pid);

                    if (!session) {
                        res.writeHead(404);
                        return res.end("no session");
                    }

                    horse = WORDS[session.idx];
                } else {
                    const puzzle = puzzleForDate(todayStr());

                    horse = WORDS.find((h) => h.id === puzzle.horse_id);
                }

                return serveHorseImage(res, horse.word);
            }

            /*
             * guess
             */
            if (sub === "/api/guess" && req.method === "POST") {
                let body = "";

                req.on("data", (c) => (body += c));

                req.on("end", () => {
                    let data;

                    try {
                        data = JSON.parse(body);
                    } catch {
                        return sendJson(
                            res,
                            {
                                error: "bad json",
                            },
                            400,
                        );
                    }

                    let horse;
                    let guesses;
                    let finished;
                    let won;

                    if (INFINITE_MODE) {
                        const session = sessions.get(pid);

                        if (!session)
                            return sendJson(
                                res,
                                {
                                    error: "no session",
                                },
                                409,
                            );

                        horse = WORDS[session.idx];

                        guesses = session.guesses;
                    } else {
                        const date = todayStr();

                        const puzzle = puzzleForDate(date);

                        horse = WORDS.find((h) => h.id === puzzle.horse_id);

                        const play = getPlay(pid, date);

                        guesses = play.guesses;
                    }

                    const guess = String(data.guess || "")
                        .trim()
                        .slice(0, 40);
                    if (guesses.includes(guess)) {
                        return sendJson(
                            res,
                            {
                                error: "already guessed",
                            },
                            409,
                        );
                    }
                    const correct = isCorrect(guess, horse);

                    guesses = guesses.concat(guess);

                    won = correct;

                    finished = won || guesses.length >= MAX_GUESSES;

                    if (INFINITE_MODE) {
                        const session = sessions.get(pid);

                        session.guesses = guesses;

                        session.finished = finished;

                        session.won = won;
                    } else {
                        savePlay(pid, todayStr(), guesses, finished, won);
                    }

                    const out = {
                        correct,
                        guess,
                        guessesMade: guesses.length,
                        finished,
                        won,
                    };

                    if (finished) {
                        out.reveal = {
                            name: horse.name,
                            word: horse.word,
                            image: `/tailoftheday/api/horse/${horse.word}`,
                        };

                        out.stats = INFINITE_MODE
                            ? {
                                  played: 0,
                                  wins: 0,
                                  winRate: 0,
                                  streak: 0,
                              }
                            : computeStats(pid);
                    }

                    return sendJson(res, out);
                });

                return;
            }

            res.writeHead(404);
            res.end("uma not found");
        },
    };
};
