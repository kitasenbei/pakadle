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
const MAX_GUESSES = 6;

// Puzzle #0 lands on this date (UTC). Each later UTC day advances one puzzle.
const DAILY_EPOCH = "2026-01-01";

// ---- word data: single source of truth lives in words.js (server-side only) ----
function loadWords() {
  const src = fs.readFileSync(path.join(ROOT, "words.js"), "utf8");
  return new Function(src + "\nreturn UMA_WORDS;")();
}

// ---- UTC day helpers (server and client agree on a single rollover) ----
function dayNumber(dateStr) {
  const epoch = Date.parse(DAILY_EPOCH + "T00:00:00Z");
  return Math.floor((Date.parse(dateStr + "T00:00:00Z") - epoch) / 86400000);
}
function secondsUntilRollover(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(0, Math.floor((next - now.getTime()) / 1000));
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

function createApp(options = {}) {
  const words = options.words || loadWords();
  // Set of allowed guesses (uppercase). Includes each uma's curated answer AND
  // every subword of their full name, so "WEEK" is accepted on a Special Week
  // day even though the canonical answer is SPECIAL. Length-mismatched tokens
  // (e.g. "O", "TM") are inert: the length check in /api/guess rejects them.
  const wordSet = new Set();
  for (const w of words) {
    wordSet.add(String(w.word).toUpperCase());
    for (const tok of String(w.name).toUpperCase().split(/\s+/)) {
      const clean = tok.replace(/[^A-Z]/g, "");
      if (clean) wordSet.add(clean);
    }
  }
  // Test seam: a callable that returns the current UTC date as YYYY-MM-DD.
  // Tests pass a fixed function so the day-rotated answer is deterministic.
  const todayStr = options.todayStr || (() => new Date().toISOString().slice(0, 10));
  const dbFile = options.dbFile || process.env.PAKADLE_DB || path.join(ROOT, "pakadle.db");
  const db = new DatabaseSync(dbFile);
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
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Pakadle Duel accounts: a name + salted/hashed password, plus an Elo ladder.
    CREATE TABLE IF NOT EXISTS accounts (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      name_lower TEXT NOT NULL UNIQUE,
      salt       TEXT NOT NULL,
      hash       TEXT NOT NULL,
      rating     INTEGER NOT NULL DEFAULT 1000,
      wins       INTEGER NOT NULL DEFAULT 0,
      losses     INTEGER NOT NULL DEFAULT 0,
      draws      INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // when this pid first loaded today's puzzle, so we can measure time-to-first-guess.
  // (ALTER throws if the column already exists; harmless on an up-to-date DB.)
  try { db.exec("ALTER TABLE plays ADD COLUMN started_at TEXT"); } catch {}

  // ---- daily-answer secret ----------------------------------------------
  // words.js is public (it's in the repo), so the old "idx = dayNumber % N"
  // formula leaked tomorrow's answer to anyone who could clone the repo.
  // We pick the daily index with HMAC-SHA256(seed, date) instead, where seed
  // is a per-deployment value that never enters git. Resolution order:
  //   options.dailySeed > PAKADLE_DAILY_SEED env > meta.daily_seed in the DB
  //   > generate 32 random bytes and persist into meta.
  let dailySeed = options.dailySeed || process.env.PAKADLE_DAILY_SEED;
  if (!dailySeed) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'daily_seed'").get();
    if (row) dailySeed = row.value;
    else {
      dailySeed = crypto.randomBytes(32).toString("hex");
      db.prepare("INSERT INTO meta (key, value) VALUES ('daily_seed', ?)").run(dailySeed);
    }
  }
  const puzzleIdxFor =
    options.puzzleIdxFor ||
    ((dateStr) => {
      const digest = crypto.createHmac("sha256", dailySeed).update(dateStr).digest();
      return digest.readUInt32BE(0) % words.length;
    });

  // Pakapix (bundled sibling game) mounted under /pakapix, sharing this DB handle.
  const pakapix = require("./pakapix/routes.js")(db);

  // Pakachess online multiplayer (server-authoritative, over WebSockets).
  const pakachessWs = require("./pakachess/ws.js");
  const pakachessOnline = require("./pakachess/online.js");

  // Pakadle Duel: realtime head-to-head racing, shares the same tiny WS server.
  const duelOnline = require("./duel/online.js");

  // Pakeiba: realtime multiplayer horse racing (rooms + bots), same WS server.
  // Not finished yet (targeting 2026-07-06); keep the code but gate public access.
  // Flip on for local dev with PAKEIBA=1.
  const PAKEIBA_ENABLED = process.env.PAKEIBA === "1" || process.env.PAKEIBA === "true";
  const pakeibaOnline = require("./pakeiba/online.js");

  function puzzleForDate(dateStr) {
    let row = db.prepare("SELECT date, number, idx FROM puzzles WHERE date = ?").get(dateStr);
    if (!row) {
      const number = dayNumber(dateStr); // public "Pakadle #N" identifier
      const idx = puzzleIdxFor(dateStr); // secret-keyed answer pick
      db.prepare("INSERT INTO puzzles (date, number, idx) VALUES (?, ?, ?)").run(dateStr, number, idx);
      row = { date: dateStr, number, idx };
    }
    return row;
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
    const row = db.prepare("SELECT grid, finished, won, started_at FROM plays WHERE pid = ? AND date = ?").get(pid, date);
    return {
      grid: row ? JSON.parse(row.grid) : [],
      finished: row ? !!row.finished : false,
      won: row ? !!row.won : false,
      startedAt: row ? row.started_at : null,
    };
  }

  // ---- accounts: salted password hashing (scrypt) + sessions ------------
  function makeSalt() { return crypto.randomBytes(16).toString("hex"); }
  function hashPassword(password, salt) { return crypto.scryptSync(String(password), salt, 64).toString("hex"); }
  function verifyPassword(password, salt, expectedHex) {
    const got = crypto.scryptSync(String(password), salt, 64);
    const exp = Buffer.from(expectedHex, "hex");
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  }
  function sessionToken(req) {
    const m = (req.headers.cookie || "").match(/(?:^|;\s*)sid=([A-Fa-f0-9]+)/);
    return m ? m[1] : null;
  }
  function setSessionCookie(req, res, token) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  }
  function clearSessionCookie(req, res) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  }
  function publicAccount(a) {
    if (!a) return null;
    return { id: a.id, name: a.name, rating: a.rating, wins: a.wins, losses: a.losses, draws: a.draws };
  }
  // resolve the logged-in account from a request's session cookie (or null)
  function accountFromReq(req) {
    const token = sessionToken(req);
    if (!token) return null;
    const s = db.prepare("SELECT account_id FROM sessions WHERE token = ?").get(token);
    if (!s) return null;
    return db.prepare("SELECT id, name, rating, wins, losses, draws FROM accounts WHERE id = ?").get(s.account_id) || null;
  }

  // ---- PakaDB QA access gate (temporary, standalone; NOT tied to Duel accounts) --
  // Testers live in pakadb/qa-access.json as salted scrypt hashes (safe to commit,
  // no plaintext — generate with `node pakadb/qa-seed.js`). The cookie-signing
  // secret is a per-deployment meta value, exactly like daily_seed. The gate below
  // covers the app entry AND every /pakadb/* asset, so the app cannot be reached by
  // pasting a URL. Lift it by deleting qa-access.json; set PAKADB_QA_OPEN=1 to
  // bypass in local dev.
  function loadQaAccess() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "pakadb", "qa-access.json"), "utf8"));
      if (!raw || !Array.isArray(raw.testers) || !raw.testers.length) return null;
      const m = new Map();
      for (const t of raw.testers) if (t && t.id) m.set(String(t.id), { salt: String(t.salt), hash: String(t.hash) });
      return m.size ? m : null;
    } catch { return null; }   // missing/invalid file => gate off (open)
  }
  let qaTesters = (process.env.PAKADB_QA_OPEN === "1" || options.qaOpen) ? null : loadQaAccess();
  let qaSecret = options.qaSecret || process.env.PAKADB_QA_SECRET;
  if (!qaSecret) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'pakadb_qa_secret'").get();
    if (row) qaSecret = row.value;
    else { qaSecret = crypto.randomBytes(32).toString("hex"); db.prepare("INSERT INTO meta (key, value) VALUES ('pakadb_qa_secret', ?)").run(qaSecret); }
  }
  function qaSign(id) { return crypto.createHmac("sha256", qaSecret).update(String(id)).digest("hex"); }
  function qaVerify(id, password) {
    const rec = qaTesters && qaTesters.get(String(id));
    if (!rec) return false;
    const got = crypto.scryptSync(String(password), rec.salt, 64);
    const exp = Buffer.from(rec.hash, "hex");
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  }
  function qaAuthed(req) {
    if (!qaTesters) return true;   // gate disabled (no access file / dev bypass)
    const m = (req.headers.cookie || "").match(/(?:^|;\s*)pdqa=([^;]+)/);
    if (!m) return false;
    let val; try { val = decodeURIComponent(m[1]); } catch { return false; }
    const dot = val.lastIndexOf(".");
    if (dot < 1) return false;
    const id = val.slice(0, dot), sig = val.slice(dot + 1);
    if (!qaTesters.has(id)) return false;
    const good = qaSign(id);
    return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
  }
  function setQaCookie(req, res, id) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    const val = encodeURIComponent(id + "." + qaSign(id));
    res.setHeader("Set-Cookie", `pdqa=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600${secure}`);   // 14 days
  }
  function clearQaCookie(req, res) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `pdqa=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  }
  // which kind of PakaDB URL is this (after normalizing away // and ../ tricks)?
  // Collapse backslashes and repeated slashes first — path.posix.normalize keeps a
  // leading "//", which would otherwise dodge the /pakadb/ prefix test.
  function qaPathKind(url) {
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { rel = url.pathname; }
    const norm = path.posix.normalize(rel.replace(/\\/g, "/").replace(/\/{2,}/g, "/"));
    if (norm === "/pakadb" || norm === "/pakadb/") return "entry";
    if (norm.startsWith("/pakadb/")) return "asset";
    return null;
  }
  function qaLoginHtml(err) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>PakaDB — private testing</title>
<style>
  :root { --turf:#4CA62E; --turf-dark:#2f6a1a; --sakura:#E85D8B; --ink:#3A2E39; --panel:#fff; --bg:#FBF6EE; }
  * { box-sizing: border-box; } body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background: var(--bg); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding:20px; }
  .card { width: 100%; max-width: 340px; background: var(--panel); border: 2px solid var(--turf-dark); border-radius: 16px;
    box-shadow: 0 14px 30px rgba(58,46,57,.22); padding: 22px 20px; }
  h1 { margin: 0 0 4px; font-size: 18px; color: var(--turf-dark); letter-spacing: .3px; }
  p.sub { margin: 0 0 16px; font-size: 12.5px; color: #8b7f88; }
  label { display:block; font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing:.4px; color:#8b7f88; margin: 10px 0 4px; }
  input { width: 100%; height: 40px; padding: 0 12px; font-size: 14px; font-family: inherit; color: var(--ink);
    background: var(--bg); border: 2px solid #e4dccf; border-radius: 10px; }
  input:focus { outline: none; border-color: var(--turf); }
  button { width: 100%; height: 42px; margin-top: 16px; font-family: inherit; font-size: 13px; font-weight: 800; letter-spacing:.4px;
    text-transform: uppercase; color:#fff; background: var(--turf); border: none; border-radius: 10px; cursor: pointer; box-shadow: 0 3px 0 var(--turf-dark); }
  button:hover { background: var(--turf-dark); }
  .err { margin-top: 12px; min-height: 16px; font-size: 12px; font-weight: 700; color: var(--sakura); }
</style></head><body>
  <form class="card" id="f" autocomplete="off">
    <h1>PakaDB · private testing</h1>
    <p class="sub">Enter the identifier and password sent to you.</p>
    <label for="id">Identifier</label>
    <input id="id" name="id" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="paka-tester-01" />
    <label for="pw">Password</label>
    <input id="pw" name="pw" type="password" placeholder="••••••••••" />
    <button type="submit">Enter</button>
    <div class="err" id="err">${err ? String(err).replace(/[<&]/g, "") : ""}</div>
  </form>
<script>
  var f = document.getElementById("f"), err = document.getElementById("err");
  f.addEventListener("submit", function (e) {
    e.preventDefault();
    err.textContent = "";
    fetch("/api/pakadb/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: f.id.value.trim(), password: f.pw.value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) { if (o.ok) location.href = "/pakadb"; else err.textContent = (o.j && o.j.error) || "Login failed."; })
      .catch(function () { err.textContent = "Network error."; });
  });
</script></body></html>`;
  }

  // ---- Elo ladder: settle one duel match --------------------------------
  // result: "a" | "b" | "draw"; returns { [accountId]: { rating, delta } }.
  // Win/loss/draw tallies are recorded for any signed-in player; the rating
  // only moves when BOTH players are accounts (a ranked match).
  function applyMatch(aId, bId, result) {
    const out = {};
    const get = (id) => (id ? db.prepare("SELECT id, rating, wins, losses, draws FROM accounts WHERE id = ?").get(id) : null);
    const A = get(aId), B = get(bId);
    const bump = (acc, col) => db.prepare(`UPDATE accounts SET ${col} = ${col} + 1 WHERE id = ?`).run(acc.id);
    if (A) bump(A, result === "a" ? "wins" : result === "b" ? "losses" : "draws");
    if (B) bump(B, result === "b" ? "wins" : result === "a" ? "losses" : "draws");
    if (A && B) {
      const K = 32;
      const ea = 1 / (1 + Math.pow(10, (B.rating - A.rating) / 400));
      const sa = result === "a" ? 1 : result === "draw" ? 0.5 : 0;
      const na = Math.round(A.rating + K * (sa - ea));
      const nb = Math.round(B.rating + K * ((1 - sa) - (1 - ea)));
      db.prepare("UPDATE accounts SET rating = ? WHERE id = ?").run(na, A.id);
      db.prepare("UPDATE accounts SET rating = ? WHERE id = ?").run(nb, B.id);
      out[A.id] = { rating: na, delta: na - A.rating };
      out[B.id] = { rating: nb, delta: nb - B.rating };
    } else {
      if (A) out[A.id] = { rating: A.rating, delta: 0 };
      if (B) out[B.id] = { rating: B.rating, delta: 0 };
    }
    return out;
  }

  // ---- anti-cheat penalty: dock a flat amount from an account's rating -----
  // Used when a Duel player leaves the tab/window mid-round. Floored at 0 so a
  // rating never goes negative. Returns { rating, delta } (delta is negative).
  function penalize(accountId, points) {
    if (!accountId) return null;
    const a = db.prepare("SELECT id, rating FROM accounts WHERE id = ?").get(accountId);
    if (!a) return null;
    const next = Math.max(0, a.rating - points);
    db.prepare("UPDATE accounts SET rating = ? WHERE id = ?").run(next, a.id);
    return { rating: next, delta: next - a.rating };
  }

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

    // ---- Pakadle Duel (bundled static game; realtime over /duel/ws) ----
    if (url.pathname === "/duel" || url.pathname.startsWith("/duel/")) {
      let sub = url.pathname.slice("/duel".length);
      if (sub === "" || sub === "/") sub = "/index.html";
      if (sub === "/ws") { res.writeHead(426); return res.end("upgrade required"); }
      const baseDir = path.join(ROOT, "duel");
      const fp = path.normalize(path.join(baseDir, sub));
      if (!fp.startsWith(baseDir)) { res.writeHead(403); return res.end("forbidden"); }
      if (path.basename(fp) === "online.js") { res.writeHead(403); return res.end("forbidden"); }
      return fs.readFile(fp, (err, buf) => {
        if (err) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
        res.end(buf);
      });
    }

    // ---- Pakeiba (bundled static game; realtime over /pakeiba/ws) ----
    // Gated until it ships: always intercept the path, but 404 unless enabled,
    // so nothing under /pakeiba/ leaks through the static handler below.
    if (url.pathname === "/pakeiba" || url.pathname.startsWith("/pakeiba/")) {
      if (!PAKEIBA_ENABLED) { res.writeHead(404); return res.end("not found"); }
      let sub = url.pathname.slice("/pakeiba".length);
      if (sub === "" || sub === "/") sub = "/index.html";
      if (sub === "/ws") { res.writeHead(426); return res.end("upgrade required"); }
      const baseDir = path.join(ROOT, "pakeiba");
      const fp = path.normalize(path.join(baseDir, sub));
      if (!fp.startsWith(baseDir)) { res.writeHead(403); return res.end("forbidden"); }
      if (path.basename(fp) === "online.js") { res.writeHead(403); return res.end("forbidden"); }
      return fs.readFile(fp, (err, buf) => {
        if (err) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(fp)] || "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        res.end(buf);
      });
    }

    // ---- PakaDB QA gate: block the app entry AND every /pakadb/* asset unless
    // the visitor holds a valid tester cookie, so it can't be reached by URL. ----
    const qaKind = qaPathKind(url);
    if (qaKind && qaTesters && !qaAuthed(req)) {
      if (qaKind === "entry") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(qaLoginHtml());
      }
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end("PakaDB is in private testing — log in at /pakadb");
    }
    // QA gate login / logout (standalone; separate cookie from Duel's sid)
    if (url.pathname === "/api/pakadb/login" && req.method === "POST") {
      return readBody(req, (body) => {
        let data; try { data = JSON.parse(body); } catch { return sendJson(res, { error: "bad json" }, 400); }
        const id = String(data.id || "").trim();
        const password = String(data.password || "");
        if (!qaTesters) return sendJson(res, { ok: true });   // gate disabled
        if (!qaVerify(id, password)) return sendJson(res, { error: "Wrong identifier or password." }, 401);
        setQaCookie(req, res, id);
        return sendJson(res, { ok: true });
      });
    }
    if (url.pathname === "/api/pakadb/logout" && req.method === "POST") {
      clearQaCookie(req, res);
      return sendJson(res, { ok: true });
    }

    // ---- PakaDB (rich character database + future breeding tool) ----
    // Its own static mini-app under pakadb/, backed by the gametora-sourced
    // dataset in pakadb/data/ (built by pakadb/build-data.js). Kept entirely
    // separate from words.js (the Pakadle puzzle roster). Sub-paths (css/js/
    // data/assets) fall through to the static handler below.
    if (url.pathname === "/pakadb" || url.pathname === "/pakadb/") {
      return fs.readFile(path.join(ROOT, "pakadb", "index.html"), (err, buf) => {
        if (err) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(buf);
      });
    }

    // ---- API ----
    if (url.pathname === "/api/daily" && req.method === "GET") {
      const pid = ensurePid(req, res);
      const date = todayStr();
      const p = puzzleForDate(date);
      const e = words[p.idx];
      const answer = e.word.toUpperCase();
      // stamp when this pid first saw today's puzzle (kept even after they guess)
      db.prepare(
        "INSERT OR IGNORE INTO plays (pid, date, grid, finished, won, updated_at, started_at) VALUES (?, ?, '[]', 0, 0, ?, ?)"
      ).run(pid, date, new Date().toISOString(), new Date().toISOString());
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
        const e = words[p.idx];
        const answer = e.word.toUpperCase();
        const play = getPlay(pid, date);

        if (play.finished) return sendJson(res, { error: "already finished" }, 409);
        if (play.grid.length >= MAX_GUESSES) return sendJson(res, { error: "no guesses left" }, 409);

        const guess = String(data.guess || "").toUpperCase();
        if (!/^[A-Z]+$/.test(guess) || guess.length !== answer.length) {
          return sendJson(res, { error: "invalid guess" }, 400);
        }
        if (!wordSet.has(guess)) {
          // Right shape, but it isn't an Umamusume word. Don't consume a slot.
          return sendJson(res, { error: "not in word list" }, 422);
        }

        const states = evaluate(guess, answer);
        const grid = play.grid.concat(guess);
        const won = guess === answer;
        const finished = won || grid.length >= MAX_GUESSES;

        const now = new Date();
        const startedAt = play.startedAt || now.toISOString();
        db.prepare(
          `INSERT INTO plays (pid, date, grid, finished, won, updated_at, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pid, date) DO UPDATE SET
             grid = excluded.grid, finished = excluded.finished,
             won = excluded.won, updated_at = excluded.updated_at`
        ).run(pid, date, JSON.stringify(grid), finished ? 1 : 0, won ? 1 : 0, now.toISOString(), startedAt);

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

    // ---- Duel accounts / auth / leaderboard ----
    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      return readBody(req, (body) => {
        let data; try { data = JSON.parse(body); } catch { return sendJson(res, { error: "bad json" }, 400); }
        const name = String(data.name || "").trim();
        const password = String(data.password || "");
        if (name.length < 1 || name.length > 24 || !/^[\x20-\x7e]+$/.test(name)) {
          return sendJson(res, { error: "Name must be 1–24 printable characters." }, 400);
        }
        if (password.length < 6 || password.length > 200) {
          return sendJson(res, { error: "Password must be at least 6 characters." }, 400);
        }
        const nameLower = name.toLowerCase();
        if (db.prepare("SELECT 1 FROM accounts WHERE name_lower = ?").get(nameLower)) {
          return sendJson(res, { error: "That name is taken." }, 409);
        }
        const id = crypto.randomUUID();
        const salt = makeSalt();
        const hash = hashPassword(password, salt);
        db.prepare(
          "INSERT INTO accounts (id, name, name_lower, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(id, name, nameLower, salt, hash, new Date().toISOString());
        const token = crypto.randomBytes(32).toString("hex");
        db.prepare("INSERT INTO sessions (token, account_id, created_at) VALUES (?, ?, ?)").run(token, id, new Date().toISOString());
        setSessionCookie(req, res, token);
        const acc = db.prepare("SELECT id, name, rating, wins, losses, draws FROM accounts WHERE id = ?").get(id);
        return sendJson(res, { account: publicAccount(acc) });
      });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      return readBody(req, (body) => {
        let data; try { data = JSON.parse(body); } catch { return sendJson(res, { error: "bad json" }, 400); }
        const name = String(data.name || "").trim();
        const password = String(data.password || "");
        const acc = db.prepare("SELECT * FROM accounts WHERE name_lower = ?").get(name.toLowerCase());
        if (!acc || !verifyPassword(password, acc.salt, acc.hash)) {
          return sendJson(res, { error: "Wrong name or password." }, 401);
        }
        const token = crypto.randomBytes(32).toString("hex");
        db.prepare("INSERT INTO sessions (token, account_id, created_at) VALUES (?, ?, ?)").run(token, acc.id, new Date().toISOString());
        setSessionCookie(req, res, token);
        return sendJson(res, { account: publicAccount(acc) });
      });
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const token = sessionToken(req);
      if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      clearSessionCookie(req, res);
      return sendJson(res, { ok: true });
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      return sendJson(res, { account: publicAccount(accountFromReq(req)) });
    }

    if (url.pathname === "/api/leaderboard" && req.method === "GET") {
      const rows = db
        .prepare("SELECT name, rating, wins, losses, draws FROM accounts ORDER BY rating DESC, wins DESC, name ASC LIMIT 50")
        .all();
      return sendJson(res, { leaders: rows });
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

  // Pakadle Duel WebSocket endpoint (/duel/ws): realtime racing + Elo ladder.
  duelOnline.init(server, pakachessWs, () => crypto.randomUUID(), {
    words, wordSet, evaluate,
    identify: (req) => {
      const a = accountFromReq(req);
      return a ? { id: a.id, name: a.name, rating: a.rating } : null;
    },
    onMatch: applyMatch,
    penalize, // anti-cheat: dock rating when a player tabs away mid-round
    ...(options.duelTimings || {}), // test seam: shrink countdown/grace windows
  });

  // Pakeiba WebSocket endpoint (/pakeiba/ws): rooms, bots, server-run races.
  // Only wire it up when Pakeiba is enabled (see PAKEIBA_ENABLED above).
  if (PAKEIBA_ENABLED) pakeibaOnline.init(server, pakachessWs, () => crypto.randomUUID());

  return {
    server, db, words, evaluate, dayNumber, secondsUntilRollover, puzzleForDate, puzzleIdxFor,
    computeStats, getPlay, rowsWithStates, MAX_GUESSES,
    accountFromReq, applyMatch, penalize, hashPassword, verifyPassword,
  };
}

module.exports = { createApp, evaluate, dayNumber, secondsUntilRollover, MAX_GUESSES, DAILY_EPOCH };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const { server, words } = createApp();
  server.listen(PORT, () => {
    console.log(`Pakadle running → http://localhost:${PORT}  (${words.length} uma in the pool)`);
  });
}
