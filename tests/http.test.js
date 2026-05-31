"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../server.js");

// Two-word stub so the day-rotated answer can be pinned via options.todayStr,
// while still leaving a second valid-but-wrong horse name (WRONGLY) for tests
// that exercise scoring without revealing the answer.
const STUB_WORDS = [
  { word: "TESTING", name: "Test Uma",    quote: "for the harness", img: "https://example.invalid/uma.png" },
  { word: "WRONGLY", name: "Wrongly Uma", quote: "not the answer",  img: "https://example.invalid/wrong.png" },
];
// DAILY_EPOCH is 2026-01-01 (day 0). idx = 0 % 2 = 0 → TESTING.
const PINNED_DATE = "2026-01-01";

function tmpDb(name) {
  return path.join(os.tmpdir(), `pakadle-http-${process.pid}-${name}-${Date.now()}.db`);
}

// Boots the app on a random port; returns helpers + a teardown.
async function bootApp(words = STUB_WORDS) {
  const dbFile = tmpDb("app");
  const app = createApp({ dbFile, words, todayStr: () => PINNED_DATE });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  // Session-style fetch: stores the pid cookie issued on first response and
  // replays it on subsequent calls, so a "user" persists across requests.
  let cookie = "";
  async function req(method, urlPath, body) {
    const headers = { "Content-Type": "application/json" };
    if (cookie) headers["Cookie"] = cookie;
    const res = await fetch(base + urlPath, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = setCookie.match(/pid=([A-Za-z0-9-]+)/);
      if (m) cookie = `pid=${m[1]}`;
    }
    const ct = res.headers.get("content-type") || "";
    const payload = ct.includes("application/json") ? await res.json() : await res.text();
    return { status: res.status, headers: res.headers, body: payload };
  }

  async function teardown() {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
    try { fs.unlinkSync(dbFile); } catch {}
  }

  return { base, port, req, teardown, app };
}

// ---- /api/daily ----

test("GET /api/daily on a fresh client issues a pid cookie and returns an empty board", async () => {
  const { req, teardown } = await bootApp();
  try {
    const r = await req("GET", "/api/daily");
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 7); // "TESTING"
    assert.equal(r.body.finished, false);
    assert.equal(r.body.won, false);
    assert.deepEqual(r.body.rows, []);
    assert.equal(typeof r.body.number, "number");
    // No reveal until finished.
    assert.equal(r.body.reveal, undefined);
    // pid cookie was set on this response.
    const sc = r.headers.get("set-cookie") || "";
    assert.match(sc, /pid=[A-Za-z0-9-]+/);
    assert.match(sc, /HttpOnly/);
  } finally {
    await teardown();
  }
});

// ---- /api/guess: happy path (wrong, then right) ----

test("POST /api/guess returns states for a wrong guess without revealing the answer", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily"); // claim a pid
    const r = await req("POST", "/api/guess", { guess: "wrongly" }); // lowercase → uppercased server-side
    assert.equal(r.status, 200);
    assert.equal(r.body.finished, false);
    assert.equal(r.body.won, false);
    assert.equal(r.body.row, 0);
    // TESTING vs WRONGLY: N (idx 3) and G (idx 4) are present, rest absent.
    assert.deepEqual(r.body.states, ["absent", "absent", "absent", "present", "present", "absent", "absent"]);
    assert.equal(r.body.reveal, undefined);
  } finally {
    await teardown();
  }
});

test("POST /api/guess with the answer finishes the game, returns reveal and stats", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    const r = await req("POST", "/api/guess", { guess: "TESTING" });
    assert.equal(r.status, 200);
    assert.equal(r.body.won, true);
    assert.equal(r.body.finished, true);
    assert.deepEqual(r.body.states, Array(7).fill("correct"));
    assert.equal(r.body.reveal.word, "TESTING");
    assert.equal(r.body.reveal.name, "Test Uma");
    assert.equal(r.body.stats.played, 1);
    assert.equal(r.body.stats.wins, 1);
    assert.equal(r.body.stats.winRate, 100);
    assert.equal(r.body.stats.streak, 1);
  } finally {
    await teardown();
  }
});

// ---- /api/guess: loss path (use up all 6 guesses) ----

test("POST /api/guess: six wrong guesses finishes the game as a loss with the reveal", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    let last;
    for (let i = 0; i < 6; i++) {
      last = await req("POST", "/api/guess", { guess: "WRONGLY" });
      assert.equal(last.status, 200);
    }
    assert.equal(last.body.finished, true);
    assert.equal(last.body.won, false);
    assert.equal(last.body.reveal.word, "TESTING");
    assert.equal(last.body.stats.played, 1);
    assert.equal(last.body.stats.wins, 0);
    assert.equal(last.body.stats.winRate, 0);
  } finally {
    await teardown();
  }
});

// ---- /api/guess: validation ----

test("POST /api/guess rejects wrong-length guesses with 400", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    const r = await req("POST", "/api/guess", { guess: "SHORT" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid guess");
  } finally {
    await teardown();
  }
});

test("POST /api/guess rejects non-letter guesses with 400", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    const r = await req("POST", "/api/guess", { guess: "TEST123" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid guess");
  } finally {
    await teardown();
  }
});

test("POST /api/guess with malformed JSON returns 400", async () => {
  const { teardown, base } = await bootApp();
  try {
    // First, claim a pid via a normal call so the request body parser is what's under test.
    const init = await fetch(base + "/api/daily");
    const cookie = (init.headers.get("set-cookie") || "").match(/pid=[A-Za-z0-9-]+/)[0];
    const res = await fetch(base + "/api/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad json" });
  } finally {
    await teardown();
  }
});

// ---- /api/guess: word-list validation ----

test("POST /api/guess rejects a right-shaped guess that isn't a horse name with 422", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    // 7 letters, all uppercase, but ZZZZZZZ is not in STUB_WORDS.
    const r = await req("POST", "/api/guess", { guess: "ZZZZZZZ" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "not in word list");
    // No states, no row index, no reveal: the request was rejected, not scored.
    assert.equal(r.body.states, undefined);
    assert.equal(r.body.reveal, undefined);
  } finally {
    await teardown();
  }
});

test("POST /api/guess: a not-in-list rejection does not consume a guess slot", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    // Try three bogus guesses in a row, then verify the saved board is still empty
    // and a real guess still lands on row 0.
    for (const w of ["ZZZZZZZ", "QQQQQQQ", "XXXXXXX"]) {
      const r = await req("POST", "/api/guess", { guess: w });
      assert.equal(r.status, 422);
    }
    const daily = await req("GET", "/api/daily");
    assert.deepEqual(daily.body.rows, []);

    const real = await req("POST", "/api/guess", { guess: "WRONGLY" });
    assert.equal(real.status, 200);
    assert.equal(real.body.row, 0);
  } finally {
    await teardown();
  }
});

test("POST /api/guess: format errors take precedence over word-list errors", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    // Wrong length AND not in the word list. Server should report the format
    // problem (400 invalid guess), not the word-list one, because the length
    // check is what tells the client "your row isn't full yet".
    const r = await req("POST", "/api/guess", { guess: "ZZZ" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid guess");
  } finally {
    await teardown();
  }
});

test("POST /api/guess: WRONGLY (in the stub list) is scored, not rejected", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    const r = await req("POST", "/api/guess", { guess: "WRONGLY" });
    assert.equal(r.status, 200);
    // TESTING vs WRONGLY: N (idx 3) and G (idx 4) present, rest absent.
    assert.deepEqual(r.body.states, ["absent", "absent", "absent", "present", "present", "absent", "absent"]);
  } finally {
    await teardown();
  }
});

// ---- /api/guess: alias subwords (non-canonical words from an uma's full name) ----
//
// The howto promises "any word inside an uma's name counts". With one entry
// {word: "GOLD", name: "Gold Ship"}, the curated answer is GOLD but SHIP must
// also be accepted as a valid guess (it scores, it doesn't 422).
async function bootGoldShipApp() {
  const dbFile = tmpDb("aliases");
  const stub = [{ word: "GOLD", name: "Gold Ship", quote: "", img: "" }];
  const app = createApp({ dbFile, words: stub, todayStr: () => "2026-01-01" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  async function req(method, urlPath, body) {
    const headers = { "Content-Type": "application/json" };
    if (cookie) headers["Cookie"] = cookie;
    const res = await fetch(base + urlPath, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie");
    if (sc) {
      const m = sc.match(/pid=([A-Za-z0-9-]+)/);
      if (m) cookie = `pid=${m[1]}`;
    }
    return { status: res.status, body: await res.json() };
  }
  async function teardown() {
    await new Promise((r) => app.server.close(r));
    app.db.close();
    try { fs.unlinkSync(dbFile); } catch {}
  }
  return { req, teardown };
}

test("POST /api/guess accepts a non-canonical subword from an uma's full name", async () => {
  const { req, teardown } = await bootGoldShipApp();
  try {
    await req("GET", "/api/daily");
    // SHIP is in the name "Gold Ship" but isn't the curated answer (GOLD is).
    // Pre-alias behavior would have 422'd this; now it should score.
    const r = await req("POST", "/api/guess", { guess: "SHIP" });
    assert.equal(r.status, 200);
    assert.equal(r.body.won, false);
    // GOLD vs SHIP: no shared letters → all absent.
    assert.deepEqual(r.body.states, ["absent", "absent", "absent", "absent"]);
  } finally {
    await teardown();
  }
});

test("POST /api/guess still 422s a 4-letter word that isn't in any uma name", async () => {
  const { req, teardown } = await bootGoldShipApp();
  try {
    await req("GET", "/api/daily");
    // BLAH is the right length but is neither GOLD nor a subword of "Gold Ship".
    const r = await req("POST", "/api/guess", { guess: "BLAH" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "not in word list");
  } finally {
    await teardown();
  }
});

test("POST /api/guess: an alias guess and a wrong canonical guess both count toward the 6-guess limit", async () => {
  const { req, teardown } = await bootGoldShipApp();
  try {
    await req("GET", "/api/daily");
    // Use SHIP four times + a real win on the fifth submission.
    for (let i = 0; i < 4; i++) {
      const r = await req("POST", "/api/guess", { guess: "SHIP" });
      assert.equal(r.status, 200);
      assert.equal(r.body.row, i);
    }
    const win = await req("POST", "/api/guess", { guess: "GOLD" });
    assert.equal(win.status, 200);
    assert.equal(win.body.won, true);
    assert.equal(win.body.row, 4);
  } finally {
    await teardown();
  }
});

// ---- /api/guess: already-finished guard ----

test("POST /api/guess after the game is finished returns 409", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    await req("POST", "/api/guess", { guess: "TESTING" });
    const again = await req("POST", "/api/guess", { guess: "TESTING" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "already finished");
  } finally {
    await teardown();
  }
});

// ---- /api/daily after finishing reveals the character ----

test("GET /api/daily after finishing returns the played rows and the reveal", async () => {
  const { req, teardown } = await bootApp();
  try {
    await req("GET", "/api/daily");
    await req("POST", "/api/guess", { guess: "WRONGLY" });
    await req("POST", "/api/guess", { guess: "TESTING" });

    const r = await req("GET", "/api/daily");
    assert.equal(r.status, 200);
    assert.equal(r.body.finished, true);
    assert.equal(r.body.won, true);
    assert.equal(r.body.rows.length, 2);
    assert.equal(r.body.rows[0].guess, "WRONGLY");
    assert.equal(r.body.rows[1].guess, "TESTING");
    assert.deepEqual(r.body.rows[1].states, Array(7).fill("correct"));
    assert.equal(r.body.reveal.word, "TESTING");
  } finally {
    await teardown();
  }
});

// ---- /api/stats ----

test("GET /api/stats returns zeroed stats for a brand-new pid", async () => {
  const { req, teardown } = await bootApp();
  try {
    const r = await req("GET", "/api/stats");
    assert.equal(r.status, 200);
    assert.equal(r.body.played, 0);
    assert.equal(r.body.wins, 0);
    assert.equal(r.body.streak, 0);
  } finally {
    await teardown();
  }
});

// ---- two clients are isolated by pid ----

test("two distinct cookies see independent boards", async () => {
  const { teardown, base } = await bootApp();
  try {
    // Client A finishes; client B should still see an empty board.
    const aInit = await fetch(base + "/api/daily");
    const aCookie = (aInit.headers.get("set-cookie") || "").match(/pid=[A-Za-z0-9-]+/)[0];
    await fetch(base + "/api/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: aCookie },
      body: JSON.stringify({ guess: "TESTING" }),
    });

    const bInit = await fetch(base + "/api/daily");
    const bCookie = (bInit.headers.get("set-cookie") || "").match(/pid=[A-Za-z0-9-]+/)[0];
    assert.notEqual(aCookie, bCookie);
    const bDaily = await (await fetch(base + "/api/daily", { headers: { Cookie: bCookie } })).json();
    assert.equal(bDaily.finished, false);
    assert.deepEqual(bDaily.rows, []);
  } finally {
    await teardown();
  }
});

// ---- static file routing ----

test("GET / serves index.html", async () => {
  const { teardown, base } = await bootApp();
  try {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("<html") || body.includes("<!DOCTYPE"));
  } finally {
    await teardown();
  }
});

test("GET a missing file returns 404", async () => {
  const { teardown, base } = await bootApp();
  try {
    const res = await fetch(base + "/nope-this-does-not-exist.txt");
    assert.equal(res.status, 404);
  } finally {
    await teardown();
  }
});

test("GET a blocked file (words.js, server.js, pakadle.db, package.json) returns 403", async () => {
  const { teardown, base } = await bootApp();
  try {
    for (const p of ["/words.js", "/server.js", "/pakadle.db", "/package.json"]) {
      const res = await fetch(base + p);
      assert.equal(res.status, 403, `expected 403 for ${p}, got ${res.status}`);
    }
  } finally {
    await teardown();
  }
});

test("GET a path-traversal attempt is rejected", async () => {
  const { teardown, base } = await bootApp();
  try {
    // The server normalizes and then checks the prefix; encoded "../" should not escape ROOT.
    const res = await fetch(base + "/%2e%2e/%2e%2e/etc/passwd");
    // Either 403 (outside root) or 404 (normalized to a missing path) is acceptable; never 200.
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
  } finally {
    await teardown();
  }
});
