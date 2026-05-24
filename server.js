// Pakadle backend — zero-dependency: Node's built-in HTTP server + node:sqlite.
// Serves the static front-end and a small daily-puzzle API.
//
//   run:  node server.js     (then open http://localhost:3000)
//
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

// Puzzle #0 lands on this date; each later day advances one puzzle.
const DAILY_EPOCH = "2026-01-01";

// ---- word data: single source of truth lives in words.js (server-side only) ----
function loadWords() {
  const src = fs.readFileSync(path.join(ROOT, "words.js"), "utf8");
  // words.js declares `const UMA_WORDS = [...]`; evaluate it and hand the array back.
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
  CREATE TABLE IF NOT EXISTS results (
    date      TEXT PRIMARY KEY,
    won       INTEGER NOT NULL,
    guesses   INTEGER NOT NULL,
    grid      TEXT NOT NULL,
    played_at TEXT NOT NULL
  );
`);

// ---- date helpers (server-local day) ----
function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dayNumber(dateStr) {
  const epoch = Date.parse(DAILY_EPOCH + "T00:00:00");
  const day = Date.parse(dateStr + "T00:00:00");
  return Math.floor((day - epoch) / 86400000);
}

// today's puzzle, locked in the DB the first time it's requested
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

function computeStats() {
  const rows = db.prepare("SELECT date, won, guesses FROM results ORDER BY date").all();
  const played = rows.length;
  const wins = rows.filter((r) => r.won).length;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  rows.forEach((r) => {
    if (r.won && dist[r.guesses] !== undefined) dist[r.guesses]++;
  });

  // longest run of consecutive calendar-day wins
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

  // current streak: consecutive-day wins ending at the most recently played day
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].won) break;
    if (i === rows.length - 1) streak = 1;
    else if (dayNumber(rows[i + 1].date) - dayNumber(rows[i].date) === 1) streak++;
    else break;
  }

  return { played, wins, winRate: played ? Math.round((wins / played) * 100) : 0, streak, maxStreak, dist };
}

// ---- tiny http helpers ----
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req, cb) {
  let data = "";
  req.on("data", (c) => {
    data += c;
    if (data.length > 1e6) req.destroy(); // basic guard
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
};
// never expose these over static serving (answers / db / source)
const BLOCKED = new Set(["words.js", "server.js", "pakadle.db", "package.json"]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- API ----
  if (url.pathname === "/api/daily" && req.method === "GET") {
    const date = todayStr();
    const p = puzzleForDate(date);
    const e = WORDS[p.idx];
    const r = db.prepare("SELECT won, guesses, grid FROM results WHERE date = ?").get(date);
    return sendJson(res, {
      date,
      number: p.number,
      length: e.word.length,
      word: e.word,
      name: e.name,
      quote: e.quote,
      img: e.img,
      result: r ? { won: !!r.won, guesses: r.guesses, grid: JSON.parse(r.grid) } : null,
      stats: computeStats(),
    });
  }

  if (url.pathname === "/api/result" && req.method === "POST") {
    return readBody(req, (body) => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return sendJson(res, { error: "bad json" }, 400);
      }
      const date = todayStr();
      const grid = Array.isArray(data.grid) ? data.grid.map(String) : [];
      // INSERT OR IGNORE → one result per day; first submission wins.
      db.prepare(
        "INSERT OR IGNORE INTO results (date, won, guesses, grid, played_at) VALUES (?, ?, ?, ?, ?)"
      ).run(date, data.won ? 1 : 0, grid.length, JSON.stringify(grid), new Date().toISOString());
      return sendJson(res, computeStats());
    });
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    return sendJson(res, computeStats());
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

server.listen(PORT, () => {
  console.log(`Pakadle running → http://localhost:${PORT}  (${WORDS.length} uma in the pool)`);
});
