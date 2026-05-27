// Pakadle backend — zero-dependency: Node's built-in HTTP server + node:sqlite.
// Per-user daily play with server-side guess validation (the answer never ships
// to the browser until the player finishes).
//
//   run:  node server.js     (then open http://localhost:3000)
//
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const MAX_GUESSES = 6;

// Puzzle #0 lands on this date (UTC). Each later UTC day advances one puzzle.
const DAILY_EPOCH = "2026-01-01";

// ---- word data: single source of truth lives in words.js (server-side only) ----
function loadWords() {
  const src = fs.readFileSync(path.join(ROOT, "words.js"), "utf8");
  return new Function(src + "\nreturn UMA_WORDS;")();
}
const WORDS = loadWords();

// ---- database ----
const DB_FILE = process.env.PAKADLE_DB || path.join(ROOT, "pakadle.db");
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS puzzles (
    date   TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    idx    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plays (
    pid        TEXT NOT NULL,
    date       TEXT NOT NULL,
    grid       TEXT NOT NULL DEFAULT '[]',
    finished   INTEGER NOT NULL DEFAULT 0,
    won        INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (pid, date)
  );
`);

// Pakapix (bundled sibling game) mounted under /pakapix, sharing this DB handle.
const pakapix = require("./pakapix/routes.js")(db);

// Pakachess online multiplayer (server-authoritative, over WebSockets).
const pakachessWs = require("./pakachess/ws.js");
const pakachessOnline = require("./pakachess/online.js");

// ---- UTC day helpers (server and client agree on a single rollover) ----
function todayStr() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}
function dayNumber(dateStr) {
  const epoch = Date.parse(DAILY_EPOCH + "T00:00:00Z");
  return Math.floor((Date.parse(dateStr + "T00:00:00Z") - epoch) / 86400000);
}
function secondsUntilRollover() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(0, Math.floor((next - now.getTime()) / 1000));
}

function puzzleForDate(dateStr) {
  let row = db.prepare("SELECT date, number, idx FROM puzzles WHERE date = ?").get(dateStr);
  if (!row) {
    const number = dayNumber(dateStr);
    const idx = ((number % WORDS.length) + WORDS.length) % WORDS.length;
    db.prepare("INSERT INTO puzzles (date, number, idx) VALUES (?, ?, ?)").run(dateStr, number, idx);
    row = { date: dateStr, number, idx };
  }
  return row;
}

// two-pass evaluation (handles duplicate letters), server-side now
function evaluate(guess, answer) {
  const n = answer.length;
  const states = new Array(n).fill("absent");
  const counts = {};
  for (const c of answer) counts[c] = (counts[c] || 0) + 1;
  for (let i = 0; i < n; i++) {
    if (guess[i] === answer[i]) {
      states[i] = "correct";
      counts[guess[i]]--;
    }
  }
  for (let i = 0; i < n; i++) {
    if (states[i] === "correct") continue;
    const c = guess[i];
    if (counts[c] > 0) {
      states[i] = "present";
      counts[c]--;
    }
  }
  return states;
}

function rowsWithStates(grid, answer) {
  return grid.map((g) => ({ guess: g, states: evaluate(g, answer) }));
}

function computeStats(pid) {
  const rows = db
    .prepare("SELECT date, won, grid FROM plays WHERE pid = ? AND finished = 1 ORDER BY date")
    .all(pid);
  const played = rows.length;
  const wins = rows.filter((r) => r.won).length;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  rows.forEach((r) => {
    if (r.won) {
      const n = JSON.parse(r.grid).length;
      if (dist[n] !== undefined) dist[n]++;
    }
  });

  let maxStreak = 0;
  let run = 0;
  let prev = null;
  for (const r of rows) {
    if (r.won) {
      run = prev && dayNumber(r.date) - dayNumber(prev) === 1 ? run + 1 : 1;
      maxStreak = Math.max(maxStreak, run);
    } else {
      run = 0;
    }
    prev = r.date;
  }

  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].won) break;
    if (i === rows.length - 1) streak = 1;
    else if (dayNumber(rows[i + 1].date) - dayNumber(rows[i].date) === 1) streak++;
    else break;
  }

  return { played, wins, winRate: played ? Math.round((wins / played) * 100) : 0, streak, maxStreak, dist };
}

function getPlay(pid, date) {
  const row = db.prepare("SELECT grid, finished, won FROM plays WHERE pid = ? AND date = ?").get(pid, date);
  return {
    grid: row ? JSON.parse(row.grid) : [],
    finished: row ? !!row.finished : false,
    won: row ? !!row.won : false,
  };
}

// ---- cookies / anonymous identity ----
function getPid(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)pid=([A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}
function ensurePid(req, res) {
  let pid = getPid(req);
  if (!pid) {
    pid = crypto.randomUUID();
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `pid=${pid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`
    );
  }
  return pid;
}

// ---- tiny http helpers ----
function sendJson(res, obj, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let data = "";
  req.on("data", (c) => {
    data += c;
    if (data.length > 1e6) req.destroy();
  });
  req.on("end", () => cb(data));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
const BLOCKED = new Set(["words.js", "server.js", "pakadle.db", "package.json"]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- Pakapix (bundled game) ----
  if (url.pathname === "/pakapix" || url.pathname.startsWith("/pakapix/")) {
    return pakapix.handle(req, res, url);
  }

  // ---- Pakachess (bundled static game, no API) ----
  if (url.pathname === "/pakachess" || url.pathname.startsWith("/pakachess/")) {
    let sub = url.pathname.slice("/pakachess".length);
    if (sub === "" || sub === "/") sub = "/index.html";
    const baseDir = path.join(ROOT, "pakachess");
    const fp = path.normalize(path.join(baseDir, sub));
    if (!fp.startsWith(baseDir)) { res.writeHead(403); return res.end("forbidden"); }
    return fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(buf);
    });
  }

  // ---- API ----
  if (url.pathname === "/api/daily" && req.method === "GET") {
    const pid = ensurePid(req, res);
    const date = todayStr();
    const p = puzzleForDate(date);
    const e = WORDS[p.idx];
    const answer = e.word.toUpperCase();
    const play = getPlay(pid, date);
    const out = {
      date,
      number: p.number,
      length: answer.length,
      secondsUntilRollover: secondsUntilRollover(),
      rows: rowsWithStates(play.grid, answer),
      finished: play.finished,
      won: play.won,
      stats: computeStats(pid),
    };
    // only reveal the character once the player is done
    if (play.finished) out.reveal = { word: e.word, name: e.name, quote: e.quote, img: e.img };
    return sendJson(res, out);
  }

  if (url.pathname === "/api/guess" && req.method === "POST") {
    const pid = ensurePid(req, res);
    return readBody(req, (body) => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return sendJson(res, { error: "bad json" }, 400);
      }
      const date = todayStr();
      const p = puzzleForDate(date);
      const e = WORDS[p.idx];
      const answer = e.word.toUpperCase();
      const play = getPlay(pid, date);

      if (play.finished) return sendJson(res, { error: "already finished" }, 409);
      if (play.grid.length >= MAX_GUESSES) return sendJson(res, { error: "no guesses left" }, 409);

      const guess = String(data.guess || "").toUpperCase();
      if (!/^[A-Z]+$/.test(guess) || guess.length !== answer.length) {
        return sendJson(res, { error: "invalid guess" }, 400);
      }

      const states = evaluate(guess, answer);
      const grid = play.grid.concat(guess);
      const won = guess === answer;
      const finished = won || grid.length >= MAX_GUESSES;

      db.prepare(
        `INSERT INTO plays (pid, date, grid, finished, won, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pid, date) DO UPDATE SET
           grid = excluded.grid, finished = excluded.finished,
           won = excluded.won, updated_at = excluded.updated_at`
      ).run(pid, date, JSON.stringify(grid), finished ? 1 : 0, won ? 1 : 0, new Date().toISOString());

      const out = { states, row: grid.length - 1, finished, won };
      if (finished) {
        out.reveal = { word: e.word, name: e.name, quote: e.quote, img: e.img };
        out.stats = computeStats(pid);
      }
      return sendJson(res, out);
    });
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    const pid = ensurePid(req, res);
    return sendJson(res, computeStats(pid));
  }

  // ---- static files ----
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const name = path.basename(rel);
  if (BLOCKED.has(name)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
});

// Pakachess WebSocket endpoint (/pakachess/ws), server-authoritative games.
pakachessOnline.init(server, pakachessWs, () => crypto.randomUUID());

server.listen(PORT, () => {
  console.log(`Pakadle running → http://localhost:${PORT}  (${WORDS.length} uma in the pool)`);
});
