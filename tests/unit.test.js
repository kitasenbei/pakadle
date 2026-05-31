"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
