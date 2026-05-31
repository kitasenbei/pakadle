"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp, evaluate, dayNumber, secondsUntilRollover, DAILY_EPOCH } = require("../server.js");

// ---- evaluate (two-pass Wordle scorer with duplicate-letter handling) ----

test("evaluate: exact match → all correct", () => {
  assert.deepEqual(evaluate("HELLO", "HELLO"), ["correct", "correct", "correct", "correct", "correct"]);
});

test("evaluate: no overlap → all absent", () => {
  assert.deepEqual(evaluate("ABCDE", "FGHIJ"), ["absent", "absent", "absent", "absent", "absent"]);
});

test("evaluate: a present letter in the wrong slot is marked present", () => {
  // answer SUZUKA, guess KZSAUU
  // K→present, Z→present, S→present, A→present, U→present, U→present (answer has 2 U's)
  const states = evaluate("KZSAUU", "SUZUKA");
  assert.deepEqual(states, ["present", "present", "present", "present", "present", "present"]);
});

test("evaluate: duplicate letters in guess do not double-count beyond answer count", () => {
  // answer = SPECIAL (one L), guess = LLLLLLL → only the L slot that's exact is correct,
  // the rest are absent (no more L's left in the answer pool).
  // SPECIAL: S P E C I A L  → L is at index 6
  const states = evaluate("LLLLLLL", "SPECIAL");
  assert.deepEqual(states, ["absent", "absent", "absent", "absent", "absent", "absent", "correct"]);
});

test("evaluate: an extra duplicate is absent once the count is spent", () => {
  // answer GOOSE (two O's), guess OOOOO → indices 1 and 2 align (correct),
  // remaining O's have no more O's in the count → absent.
  const states = evaluate("OOOOO", "GOOSE");
  assert.deepEqual(states, ["absent", "correct", "correct", "absent", "absent"]);
});

test("evaluate: correct takes precedence over present for the same letter", () => {
  // answer = ABBA, guess = BBBB → index 1 and 2 are correct B's; the other B's have no more B count.
  const states = evaluate("BBBB", "ABBA");
  assert.deepEqual(states, ["absent", "correct", "correct", "absent"]);
});

// ---- dayNumber (UTC epoch math) ----

test("dayNumber: epoch date is day 0", () => {
  assert.equal(dayNumber(DAILY_EPOCH), 0);
});

test("dayNumber: day after epoch is 1", () => {
  assert.equal(dayNumber("2026-01-02"), 1);
});

test("dayNumber: 30 days after epoch is 30", () => {
  assert.equal(dayNumber("2026-01-31"), 30);
});

test("dayNumber: dates before epoch are negative", () => {
  assert.equal(dayNumber("2025-12-31"), -1);
});

// ---- secondsUntilRollover ----

test("secondsUntilRollover: at UTC midnight returns one full day", () => {
  const midnight = new Date("2026-06-15T00:00:00.000Z");
  assert.equal(secondsUntilRollover(midnight), 86400);
});

test("secondsUntilRollover: one second before midnight returns 1", () => {
  const almost = new Date("2026-06-15T23:59:59.000Z");
  assert.equal(secondsUntilRollover(almost), 1);
});

// ---- computeStats (DB-backed) ----

function tmpDb(name) {
  return path.join(os.tmpdir(), `pakadle-test-${process.pid}-${name}-${Date.now()}.db`);
}

function seedPlay(db, pid, date, grid, won) {
  db.prepare(
    `INSERT INTO plays (pid, date, grid, finished, won, updated_at) VALUES (?, ?, ?, 1, ?, ?)`
  ).run(pid, date, JSON.stringify(grid), won ? 1 : 0, new Date().toISOString());
}

test("computeStats: empty history yields zeroed stats", () => {
  const dbFile = tmpDb("empty");
  const app = createApp({ dbFile });
  try {
    const s = app.computeStats("nobody");
    assert.deepEqual(s, { played: 0, wins: 0, winRate: 0, streak: 0, maxStreak: 0, dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } });
  } finally {
    app.db.close();
    fs.unlinkSync(dbFile);
  }
});

test("computeStats: counts wins, losses, and win-rate", () => {
  const dbFile = tmpDb("wins");
  const app = createApp({ dbFile });
  try {
    const pid = "u1";
    seedPlay(app.db, pid, "2026-01-01", ["AAA"], true);
    seedPlay(app.db, pid, "2026-01-02", ["AAA", "BBB"], true);
    seedPlay(app.db, pid, "2026-01-03", ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"], false);
    const s = app.computeStats(pid);
    assert.equal(s.played, 3);
    assert.equal(s.wins, 2);
    assert.equal(s.winRate, 67); // round(2/3 * 100)
    assert.deepEqual(s.dist, { 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0 });
  } finally {
    app.db.close();
    fs.unlinkSync(dbFile);
  }
});

test("computeStats: consecutive wins build a current streak; a loss breaks it", () => {
  const dbFile = tmpDb("streak");
  const app = createApp({ dbFile });
  try {
    const pid = "u2";
    seedPlay(app.db, pid, "2026-01-01", ["X"], true);
    seedPlay(app.db, pid, "2026-01-02", ["X"], true);
    seedPlay(app.db, pid, "2026-01-03", ["X"], true);
    const s1 = app.computeStats(pid);
    assert.equal(s1.streak, 3);
    assert.equal(s1.maxStreak, 3);

    // Loss on day 4 zeroes the current streak but maxStreak stays.
    seedPlay(app.db, pid, "2026-01-04", Array(6).fill("X"), false);
    const s2 = app.computeStats(pid);
    assert.equal(s2.streak, 0);
    assert.equal(s2.maxStreak, 3);
  } finally {
    app.db.close();
    fs.unlinkSync(dbFile);
  }
});

test("computeStats: a one-day gap breaks the streak even with two adjacent wins around it", () => {
  const dbFile = tmpDb("gap");
  const app = createApp({ dbFile });
  try {
    const pid = "u3";
    seedPlay(app.db, pid, "2026-01-01", ["X"], true);
    seedPlay(app.db, pid, "2026-01-02", ["X"], true);
    // (no play on 2026-01-03)
    seedPlay(app.db, pid, "2026-01-04", ["X"], true);
    const s = app.computeStats(pid);
    // Current streak: just the latest win (preceding row is 2 days earlier).
    assert.equal(s.streak, 1);
    // Max streak: the two consecutive wins on day 1 and 2.
    assert.equal(s.maxStreak, 2);
  } finally {
    app.db.close();
    fs.unlinkSync(dbFile);
  }
});

// ---- puzzleIdxFor: HMAC-keyed answer selection ----
//
// Goal: anyone with the public words.js (it's in the repo) cannot predict
// tomorrow's answer without also knowing the per-deployment dailySeed.
// These tests pin the math: same seed+date is deterministic, but the index
// is genuinely keyed by the seed (different seeds → different indices).

// A synthetic stub large enough that random collisions across a handful of
// trials are vanishingly unlikely. Names don't have to be realistic uma data.
const HMAC_STUB = Array.from({ length: 1024 }, (_, i) => ({
  word: "W" + String(i).padStart(4, "0"),
  name: "Stub " + i,
  quote: "",
  img: "",
}));

function hmacAppWithSeed(seed) {
  const dbFile = tmpDb("hmac-" + Buffer.from(seed).toString("hex").slice(0, 8));
  const app = createApp({ dbFile, words: HMAC_STUB, dailySeed: seed });
  return { app, dbFile };
}

test("puzzleIdxFor: same seed + same date yields the same index across two app instances", () => {
  const seed = "deterministic-seed";
  const a = hmacAppWithSeed(seed);
  const b = hmacAppWithSeed(seed);
  try {
    const date = "2026-07-15";
    assert.equal(a.app.puzzleIdxFor(date), b.app.puzzleIdxFor(date));
  } finally {
    a.app.db.close(); b.app.db.close();
    fs.unlinkSync(a.dbFile); fs.unlinkSync(b.dbFile);
  }
});

test("puzzleIdxFor: implements HMAC-SHA256(seed, date) first-4-bytes mod N", () => {
  const seed = "formula-check";
  const a = hmacAppWithSeed(seed);
  try {
    const date = "2026-09-09";
    const expected = crypto.createHmac("sha256", seed).update(date).digest().readUInt32BE(0) % HMAC_STUB.length;
    assert.equal(a.app.puzzleIdxFor(date), expected);
  } finally {
    a.app.db.close(); fs.unlinkSync(a.dbFile);
  }
});

test("puzzleIdxFor: different seeds produce different indices for the same date (5 trials, no fallback to dayNumber)", () => {
  const date = "2026-03-14";
  // dayNumber(date) % HMAC_STUB.length is what an attacker would compute from
  // the public formula. Verify none of 5 distinct random seeds happens to
  // collide with it (collision probability per seed: 1/1024).
  const publicFormula = ((dayNumber(date) % HMAC_STUB.length) + HMAC_STUB.length) % HMAC_STUB.length;
  const indices = [];
  const cleanups = [];
  try {
    for (let i = 0; i < 5; i++) {
      const { app, dbFile } = hmacAppWithSeed("seed-trial-" + i);
      cleanups.push({ app, dbFile });
      indices.push(app.puzzleIdxFor(date));
    }
    // At least 4 of 5 must differ from the public formula. P(all 5 collide) ~ 1e-15.
    const matches = indices.filter((v) => v === publicFormula).length;
    assert.ok(matches <= 1, `too many seeds matched the public formula (${matches}/5); HMAC may not be in use`);
    // And the seeds should disagree among themselves (not all 5 equal).
    assert.ok(new Set(indices).size >= 2, "5 seeds all produced the same idx; selection isn't seed-dependent");
  } finally {
    cleanups.forEach(({ app, dbFile }) => { app.db.close(); fs.unlinkSync(dbFile); });
  }
});

test("puzzleIdxFor: same seed, different dates yield different indices (no constant function)", () => {
  const { app, dbFile } = hmacAppWithSeed("date-sensitivity");
  try {
    const dates = ["2026-01-01", "2026-01-02", "2026-06-15", "2026-12-31", "2027-04-04"];
    const indices = dates.map((d) => app.puzzleIdxFor(d));
    assert.ok(new Set(indices).size >= 4, `expected ≥4 distinct indices across 5 dates, got ${new Set(indices).size}`);
  } finally {
    app.db.close(); fs.unlinkSync(dbFile);
  }
});

test("puzzleIdxFor: server with no provided seed bootstraps a random one into the DB meta table", () => {
  const dbFile = tmpDb("seed-bootstrap");
  try {
    // First boot — no seed in options, no env var (cleared explicitly), no meta row.
    const prevEnv = process.env.PAKADLE_DAILY_SEED;
    delete process.env.PAKADLE_DAILY_SEED;
    try {
      const a = createApp({ dbFile, words: HMAC_STUB });
      const row = a.db.prepare("SELECT value FROM meta WHERE key = 'daily_seed'").get();
      assert.ok(row && row.value && row.value.length >= 32, "expected a non-trivial generated seed");
      const idx1 = a.puzzleIdxFor("2026-08-08");
      a.db.close();

      // Second boot on the same DB — should reuse the persisted seed, not generate a new one.
      const b = createApp({ dbFile, words: HMAC_STUB });
      const idx2 = b.puzzleIdxFor("2026-08-08");
      assert.equal(idx1, idx2);
      b.db.close();
    } finally {
      if (prevEnv !== undefined) process.env.PAKADLE_DAILY_SEED = prevEnv;
    }
  } finally {
    fs.unlinkSync(dbFile);
  }
});
