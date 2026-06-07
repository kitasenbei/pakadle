"use strict";

// Pakadle Duel: end-to-end over a real WebSocket. Boots the app, registers two
// accounts, opens two browser-style WS connections (Node 22's global undici
// WebSocket carries the session cookie through the handshake), and races a
// 1-round private match to a decisive, ranked finish — then asserts the Elo
// ladder moved the right way.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../server.js");

// Each uma has a UNIQUE word length, so a round's announced `length` pins the
// answer exactly — the client can solve deterministically without ever being
// told the word, exactly like a human who already knows the (tiny) pool.
const STUB = [
  { word: "TEIO", name: "Teio", quote: "q", img: "https://x.invalid/a.png" },
  { word: "VODKA", name: "Vodka", quote: "q", img: "https://x.invalid/b.png" },
  { word: "SUZUKA", name: "Suzuka", quote: "q", img: "https://x.invalid/c.png" },
  { word: "SPECIAL", name: "Special", quote: "q", img: "https://x.invalid/d.png" },
];
const BY_LEN = {}; STUB.forEach((e) => (BY_LEN[e.word.length] = e.word));

function tmpDb(n) { return path.join(os.tmpdir(), `pakadle-duel-${process.pid}-${n}-${Date.now()}.db`); }

async function boot() {
  const app = createApp({
    dbFile: tmpDb("app"), words: STUB, todayStr: () => "2026-01-01", puzzleIdxFor: () => 0,
    duelTimings: { countdownMs: 150, roundGraceMs: 150, matchGraceMs: 150 },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  return app;
}

async function register(base, name, password) {
  const res = await fetch(base + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = (setCookie.match(/sid=[A-Fa-f0-9]+/) || [""])[0];
  return { body: await res.json(), cookie, status: res.status };
}

// a tiny promise-driven WS client that records messages and lets a test await
// the next message of a given type. Every client made through a harness is
// tracked so teardown can close them all and wait for the socket to release
// (an undici WebSocket left open keeps the process alive and would wedge the
// multi-file test runner, which spawns one child process per file).
function makeHarness() {
  const clients = [];
  function client(base, cookie) {
    const url = base.replace(/^http/, "ws") + "/duel/ws";
    const sock = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : undefined);
    const waiters = []; const inbox = [];
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data); inbox.push(m);
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].type === m.t) { waiters[i].resolve(m); waiters.splice(i, 1); break; }
      }
    };
    const ready = new Promise((res) => (sock.onopen = () => res()));
    const closed = new Promise((res) => (sock.onclose = () => res()));
    const api = {
      sock, ready, inbox, closed,
      send: (o) => sock.send(JSON.stringify(o)),
      next: (type, ms = 4000) => new Promise((resolve, reject) => {
        const hit = inbox.find((m) => m.t === type && !m._seen);
        if (hit) { hit._seen = true; return resolve(hit); }
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error("timeout waiting for " + type)), ms);
      }),
      close: () => { try { sock.close(); } catch (_) {} },
    };
    clients.push(api);
    return api;
  }
  async function teardown(app) {
    for (const c of clients) c.close();
    await Promise.race([
      Promise.allSettled(clients.map((c) => c.closed)),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    try { app.server.closeAllConnections(); } catch (_) {}
    await new Promise((r) => app.server.close(r));
  }
  return { client, teardown };
}

test("duel: ranked private match races to a decisive Elo result", async (t) => {
  const app = await boot();
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const { client, teardown } = makeHarness();
  t.after(() => teardown(app));

  const A = await register(base, "Alpha", "hunter2x");
  const B = await register(base, "Bravo", "hunter2x");
  assert.equal(A.status, 200); assert.equal(B.status, 200);
  assert.equal(A.body.account.rating, 1000);

  const a = client(base, A.cookie), b = client(base, B.cookie);
  await Promise.all([a.ready, b.ready]);
  await a.next("idle"); await b.next("idle");

  // Alpha hosts a 1-round, fastest-solve room with no clock; Bravo joins by code.
  const code = "RACE";
  a.send({ t: "join", code, cfg: { rounds: 1, winBy: "speed", timeLimit: 0 } });
  await a.next("waiting");
  b.send({ t: "join", code });

  const startA = await a.next("start");
  const startB = await b.next("start");
  assert.equal(startA.ranked, true, "both signed in -> ranked");
  assert.equal(startA.opponent, "Bravo");
  assert.equal(startB.opponent, "Alpha");

  const roundA = await a.next("round");
  await b.next("round");
  const answer = BY_LEN[roundA.length];
  assert.ok(answer, "round length maps to a unique stub word");

  // wait for the server's "go", then Alpha guesses instantly; Bravo stalls so
  // Alpha is unambiguously first to solve (fastest-solve => Alpha wins the round)
  await a.next("go"); await b.next("go");

  // a right-length but not-in-list guess must NOT burn a row
  a.send({ t: "guess", guess: "ZZZZZZZ".slice(0, roundA.length) });
  const bad = await a.next("bad");
  assert.equal(bad.reason, "notword");

  a.send({ t: "guess", guess: answer });
  const myRow = await a.next("row");
  assert.equal(myRow.won, true);
  assert.deepEqual(myRow.states, myRow.states.map(() => "correct"));

  // Bravo only ever sees Alpha's colors, never the letters
  const oppRow = await b.next("oppRow");
  assert.equal(oppRow.won, true);
  assert.equal(oppRow.guess, undefined, "opponent letters must not leak");
  assert.deepEqual(oppRow.states, oppRow.states.map(() => "correct"));

  // round + match resolve in Alpha's favor
  const roA = await a.next("roundOver");
  assert.equal(roA.outcome, "win");
  assert.equal(roA.reveal.word, answer);

  const moA = await a.next("matchOver");
  const moB = await b.next("matchOver");
  assert.equal(moA.outcome, "win");
  assert.equal(moB.outcome, "lose");
  assert.equal(moA.ranked, true);
  assert.ok(moA.delta > 0, "winner's rating rises");
  assert.ok(moB.delta < 0, "loser's rating falls");
  assert.equal(moA.rating, 1000 + moA.delta);

  // ladder is persisted + reflected in the leaderboard
  const lb = await (await fetch(base + "/api/leaderboard")).json();
  const alpha = lb.leaders.find((x) => x.name === "Alpha");
  const bravo = lb.leaders.find((x) => x.name === "Bravo");
  assert.equal(alpha.wins, 1); assert.equal(alpha.losses, 0);
  assert.equal(bravo.losses, 1); assert.equal(bravo.wins, 0);
  assert.ok(alpha.rating > bravo.rating);
});

test("duel: tab-switch forfeit hands the match over AND docks 100 rating", async (t) => {
  const app = await boot();
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const { client, teardown } = makeHarness();
  t.after(() => teardown(app));

  const A = await register(base, "Stayer", "hunter2x");
  const B = await register(base, "Peeker", "hunter2x");

  const a = client(base, A.cookie), b = client(base, B.cookie);
  await Promise.all([a.ready, b.ready]);
  await a.next("idle"); await b.next("idle");

  a.send({ t: "join", code: "PEEK", cfg: { rounds: 3, winBy: "speed", timeLimit: 0 } });
  await a.next("waiting");
  b.send({ t: "join", code: "PEEK" });
  await a.next("start"); await b.next("start");
  await a.next("round"); await b.next("round");
  await a.next("go"); await b.next("go");

  // Peeker leaves the tab mid-round -> automatic forfeit with a rating penalty
  b.send({ t: "resign", reason: "focus" });

  const moA = await a.next("matchOver");
  const moB = await b.next("matchOver");

  assert.equal(moA.outcome, "win");
  assert.equal(moA.reason, "focus");
  assert.ok(moA.delta > 0, "the trainer who stayed gains rating");
  assert.equal(moA.penalty, undefined, "no penalty on the innocent side");

  assert.equal(moB.outcome, "lose");
  assert.equal(moB.reason, "focus");
  assert.equal(moB.penalty, 100, "offender is docked a flat 100");
  // combined delta = ranked loss (negative) minus the 100 penalty
  assert.ok(moB.delta <= -100, "the dock is on top of the ranked loss");
  assert.equal(moB.rating, 1000 + moB.delta, "reported rating matches the delta");

  // persisted: the leaderboard shows the docked rating
  const lb = await (await fetch(base + "/api/leaderboard")).json();
  const peeker = lb.leaders.find((x) => x.name === "Peeker");
  assert.equal(peeker.rating, moB.rating);
  assert.ok(peeker.rating < 900, "rating fell well past the bare Elo loss");
});

test("auth: duplicate names and bad passwords are rejected", async (t) => {
  const app = await boot();
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const { teardown } = makeHarness();
  t.after(() => teardown(app));

  const first = await register(base, "Solo", "goodpass");
  assert.equal(first.status, 200);
  const dup = await register(base, "SOLO", "otherpass"); // case-insensitive clash
  assert.equal(dup.status, 409);
  const weak = await register(base, "Newbie", "123");    // too short
  assert.equal(weak.status, 400);

  // wrong password is refused; right one logs in
  const wrong = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Solo", password: "nope" }),
  });
  assert.equal(wrong.status, 401);
  const ok = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Solo", password: "goodpass" }),
  });
  assert.equal(ok.status, 200);
});
