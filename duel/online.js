// Pakadle Duel — realtime head-to-head Wordle racing, server-authoritative.
// Two trainers get the SAME hidden uma each round and race on their own grids.
// The server owns every answer, validates every guess, runs the per-round clock,
// keeps score across a best-of-N match, and never ships the answer (or your
// opponent's letters) to the other browser until the round is decided.
//
// Matchmaking:
//   - Quick Match : drop into a global queue, pair with the next trainer waiting.
//   - Private room: a host picks the rules + a short code, a friend joins by code.
//
// Transport is the same tiny zero-dependency WebSocket server as Pakachess
// (../pakachess/ws.js); this module just owns the game logic on top of it.
"use strict";

const MAX_GUESSES = 6;
const ABANDON_MS = 60000;    // both sides gone this long -> reap the game
const HARD_ROUND_CAP = 25;   // draw-spiral backstop so a match can't run forever

// Quick Match uses these fixed rules (private rooms let the host choose).
const QUICK_CFG = { rounds: 3, winBy: "speed", timeLimit: 90 };

function init(server, ws, ensurePid, deps) {
  const {
    words, wordSet, evaluate, now = () => Date.now(),
    // identify(req) -> { id, name, rating } | null   (resolves the logged-in account from cookies)
    identify = () => null,
    // onMatch(aAccountId, bAccountId, result)  result: "a" | "b" | "draw"  (updates the rank ladder)
    onMatch = () => {},
    // penalize(accountId, points) -> { rating, delta } | null  (anti-cheat rating dock)
    penalize = () => null,
  } = deps;
  // flat rating hit for leaving the tab/window mid-round in Duel.
  const FOCUS_PENALTY = deps.focusPenalty != null ? deps.focusPenalty : 100;
  const COUNTDOWN_MS = deps.countdownMs != null ? deps.countdownMs : 3000;     // "3-2-1-go" pre-round
  const ROUND_GRACE_MS = deps.roundGraceMs != null ? deps.roundGraceMs : 4500; // reveal lingers between rounds
  const MATCH_GRACE_MS = deps.matchGraceMs != null ? deps.matchGraceMs : 1500; // before the game is reaped

  const games = new Map();      // id -> game
  const pidGame = new Map();    // pid -> game id
  const pidConn = new Map();    // pid -> live conn
  const pidName = new Map();    // pid -> chosen display name
  const pidAccount = new Map(); // pid -> { id, name, rating } | null (logged-in identity)
  const rooms = new Map();      // room code -> { pid, conn, cfg } waiting for a friend
  let queue = null;             // { pid, conn } waiting in the Quick Match pool
  let nextId = 1;

  const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const cleanName = (s) => (String(s || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 24)) || "Trainer";

  function normCfg(c) {
    c = c || {};
    const rounds = [1, 3, 5, 7].includes(+c.rounds) ? +c.rounds : 3;
    const winBy = c.winBy === "guesses" ? "guesses" : "speed";
    const tl = +c.timeLimit;
    const timeLimit = [0, 30, 45, 60, 90, 120, 180].includes(tl) ? tl : 90;
    return { rounds, winBy, timeLimit };
  }

  // ---- send helpers -------------------------------------------------------
  function sendTo(g, pid, msg) { const c = g.conns[pid]; if (c && c.alive) c.send(msg); }
  function broadcast(g, msg) { for (const pid of g.players) sendTo(g, pid, msg); }
  // per-player message built from each pid's own perspective
  function sendEach(g, build) { for (const pid of g.players) sendTo(g, pid, build(pid)); }
  const other = (g, pid) => (g.players[0] === pid ? g.players[1] : g.players[0]);
  const scoreFor = (g, pid) => ({ you: g.score[pid], opp: g.score[other(g, pid)] });

  // ---- round answer picking ----------------------------------------------
  function pickAnswerIdx(g) {
    // avoid repeating a word inside the same match where we can
    let idx, guard = 0;
    do { idx = Math.floor(Math.random() * words.length); guard++; }
    while (g.usedIdx.has(idx) && g.usedIdx.size < words.length && guard < 50);
    g.usedIdx.add(idx);
    return idx;
  }

  // ---- match lifecycle ----------------------------------------------------
  function startMatch(pidA, pidB, cfg) {
    const g = {
      id: nextId++, code: null, cfg: normCfg(cfg),
      players: [pidA, pidB], conns: {}, names: {},
      score: { [pidA]: 0, [pidB]: 0 },
      target: 0, usedIdx: new Set(),
      roundNo: 0, round: null,
      over: false, discSince: null, roundTimer: null,
    };
    g.target = Math.floor(g.cfg.rounds / 2) + 1; // best-of-N
    // a logged-in player's display name is their (authoritative) account name
    g.account = { [pidA]: pidAccount.get(pidA) || null, [pidB]: pidAccount.get(pidB) || null };
    g.names[pidA] = (g.account[pidA] && g.account[pidA].name) || pidName.get(pidA) || "Trainer";
    g.names[pidB] = (g.account[pidB] && g.account[pidB].name) || pidName.get(pidB) || "Trainer";
    g.ranked = !!(g.account[pidA] && g.account[pidB]); // both signed in -> counts on the ladder
    g.conns[pidA] = pidConn.get(pidA) || null;
    g.conns[pidB] = pidConn.get(pidB) || null;
    games.set(g.id, g);
    pidGame.set(pidA, g.id); pidGame.set(pidB, g.id);

    sendEach(g, (pid) => {
      const oa = g.account[other(g, pid)];
      return {
        t: "start", you: g.names[pid], opponent: g.names[other(g, pid)],
        opponentRating: oa ? oa.rating : null, ranked: g.ranked,
        cfg: g.cfg, target: g.target, score: scoreFor(g, pid),
      };
    });
    startRound(g);
  }

  function startRound(g) {
    if (g.over || !games.has(g.id)) return;
    g.roundNo++;
    const idx = pickAnswerIdx(g);
    const answer = String(words[idx].word).toUpperCase();
    const startAt = now() + COUNTDOWN_MS;
    g.round = {
      idx, answer, len: answer.length,
      boards: {}, startAt, deadline: g.cfg.timeLimit ? startAt + g.cfg.timeLimit * 1000 : null,
      over: false, lastTick: -1,
    };
    for (const pid of g.players) {
      g.round.boards[pid] = { grid: [], states: [], finished: false, won: false, solvedAt: null };
    }
    sendEach(g, (pid) => ({
      t: "round", roundNo: g.roundNo, rounds: g.cfg.rounds, length: answer.length,
      winBy: g.cfg.winBy, timeLimit: g.cfg.timeLimit, countdown: Math.ceil(COUNTDOWN_MS / 1000),
      score: scoreFor(g, pid),
    }));
  }

  function decideRound(g) {
    const [a, b] = g.players;
    const ba = g.round.boards[a], bb = g.round.boards[b];
    if (g.cfg.winBy === "speed") {
      if (ba.won && bb.won) return ba.solvedAt <= bb.solvedAt ? a : b;
      if (ba.won) return a;
      if (bb.won) return b;
      return "draw";
    }
    // fewest guesses
    if (ba.won && bb.won) {
      if (ba.grid.length < bb.grid.length) return a;
      if (bb.grid.length < ba.grid.length) return b;
      return "draw";
    }
    if (ba.won) return a;
    if (bb.won) return b;
    return "draw";
  }

  // Has the round reached a natural end (independent of the clock)?
  function roundSettled(g) {
    const bs = g.players.map((p) => g.round.boards[p]);
    if (g.cfg.winBy === "speed" && bs.some((b) => b.won)) return true; // first solve ends it
    return bs.every((b) => b.finished);                                // everyone done otherwise
  }

  function endRound(g) {
    if (!g.round || g.round.over) return;
    g.round.over = true;
    const result = decideRound(g);          // pid | "draw"
    if (result !== "draw") g.score[result]++;
    const e = words[g.round.idx];
    const reveal = { word: e.word, name: e.name, quote: e.quote, img: e.img };

    sendEach(g, (pid) => {
      const op = other(g, pid);
      const ob = g.round.boards[op];
      return {
        t: "roundOver",
        outcome: result === "draw" ? "draw" : result === pid ? "win" : "lose",
        reveal, score: scoreFor(g, pid),
        // round's done -> safe to reveal the opponent's actual guesses now
        oppBoard: { grid: ob.grid.slice(), states: ob.states.slice(), won: ob.won },
      };
    });

    const clinched = g.players.some((p) => g.score[p] >= g.target);
    const capped = g.roundNo >= HARD_ROUND_CAP;
    if (clinched || capped) {
      g.roundTimer = setTimeout(() => endMatch(g), ROUND_GRACE_MS);
    } else {
      g.roundTimer = setTimeout(() => startRound(g), ROUND_GRACE_MS);
    }
  }

  // Settle the ladder once per match. Returns a map of accountId -> {rating, delta}.
  function settleRatings(g, winnerPid) {
    const [a, b] = g.players;
    const result = winnerPid == null ? "draw" : winnerPid === a ? "a" : "b";
    const aId = g.account[a] && g.account[a].id;
    const bId = g.account[b] && g.account[b].id;
    try { return onMatch(aId || null, bId || null, result) || {}; }
    catch (_) { return {}; }
  }

  function endMatch(g) {
    if (g.over) return;
    g.over = true;
    const [a, b] = g.players;
    const winner = g.score[a] > g.score[b] ? a : g.score[b] > g.score[a] ? b : null;
    const ladder = g.ranked ? settleRatings(g, winner) : {};
    sendEach(g, (pid) => {
      const acct = g.account[pid];
      const mine = acct && ladder[acct.id];
      return {
        t: "matchOver", ranked: g.ranked,
        outcome: winner == null ? "draw" : winner === pid ? "win" : "lose",
        score: scoreFor(g, pid),
        rating: mine ? mine.rating : (acct ? acct.rating : null),
        delta: mine ? mine.delta : null,
      };
    });
    g.roundTimer = setTimeout(() => cleanup(g), MATCH_GRACE_MS);
  }

  function cleanup(g) {
    if (g.roundTimer) clearTimeout(g.roundTimer);
    games.delete(g.id);
    for (const pid of g.players) if (pidGame.get(pid) === g.id) pidGame.delete(pid);
  }

  // forfeit the whole match to the player who is still here
  function forfeit(g, loserPid) {
    if (g.over) return;
    if (g.roundTimer) clearTimeout(g.roundTimer);
    if (g.round) g.round.over = true;
    g.over = true;
    const winner = other(g, loserPid);
    const ladder = g.ranked ? settleRatings(g, winner) : {};
    sendEach(g, (pid) => {
      const acct = g.account[pid];
      const mine = acct && ladder[acct.id];
      return {
        t: "matchOver", reason: "forfeit", ranked: g.ranked,
        outcome: pid === winner ? "win" : "lose", score: scoreFor(g, pid),
        rating: mine ? mine.rating : (acct ? acct.rating : null),
        delta: mine ? mine.delta : null,
      };
    });
    setTimeout(() => cleanup(g), MATCH_GRACE_MS);
  }

  // Forfeit triggered by the offender leaving the tab/window mid-round. On top of
  // the normal forfeit (match goes to the opponent, ranked Elo settles), the
  // offender is docked a flat FOCUS_PENALTY from their account rating — a peeking
  // deterrent. The penalty only bites a logged-in account; a guest just forfeits.
  function focusForfeit(g, loserPid) {
    if (g.over) return;
    if (g.roundTimer) clearTimeout(g.roundTimer);
    if (g.round) g.round.over = true;
    g.over = true;
    const winner = other(g, loserPid);
    const ladder = g.ranked ? settleRatings(g, winner) : {};
    // dock the offender on top of any ranked Elo change (after settle, so it
    // reads the freshly-updated rating).
    const loserAcct = g.account[loserPid];
    let pen = null;
    if (loserAcct) { try { pen = penalize(loserAcct.id, FOCUS_PENALTY); } catch (_) {} }
    sendEach(g, (pid) => {
      const acct = g.account[pid];
      const mine = acct && ladder[acct.id];
      const msg = {
        t: "matchOver", reason: "focus", ranked: g.ranked,
        outcome: pid === winner ? "win" : "lose", score: scoreFor(g, pid),
        rating: mine ? mine.rating : (acct ? acct.rating : null),
        delta: mine ? mine.delta : null,
      };
      if (pid === loserPid && pen) {
        // surface the docked rating + combined delta (ranked move, if any, − penalty)
        msg.rating = pen.rating;
        msg.delta = (mine ? mine.delta : 0) + pen.delta;
        msg.penalty = FOCUS_PENALTY;
      }
      return msg;
    });
    setTimeout(() => cleanup(g), MATCH_GRACE_MS);
  }

  // ---- guessing -----------------------------------------------------------
  function handleGuess(g, pid, raw) {
    if (g.over || !g.round || g.round.over) return;
    if (now() < g.round.startAt) return;             // still in the countdown
    const board = g.round.boards[pid];
    if (!board || board.finished) return;

    const guess = String(raw || "").toUpperCase();
    if (!/^[A-Z]+$/.test(guess) || guess.length !== g.round.len) {
      sendTo(g, pid, { t: "bad", reason: "invalid" }); return;
    }
    if (!wordSet.has(guess)) {
      sendTo(g, pid, { t: "bad", reason: "notword" }); return; // doesn't burn a row
    }

    const states = evaluate(guess, g.round.answer);
    board.grid.push(guess);
    board.states.push(states);
    const won = guess === g.round.answer;
    if (won) { board.won = true; board.solvedAt = now(); }
    board.finished = won || board.grid.length >= MAX_GUESSES;
    const rowIdx = board.grid.length - 1;

    // me: full row (letters + colors). opponent: colors only (no letters leak).
    sendTo(g, pid, { t: "row", row: rowIdx, guess, states, finished: board.finished, won });
    sendTo(g, other(g, pid), {
      t: "oppRow", row: rowIdx, states, finished: board.finished, won, count: board.grid.length,
    });

    if (roundSettled(g)) endRound(g);
  }

  // ---- reconnect / resume -------------------------------------------------
  function syncTo(g, pid) {
    const op = other(g, pid);
    const myb = g.round ? g.round.boards[pid] : null;
    const ob = g.round ? g.round.boards[op] : null;
    const oa = g.account[op];
    sendTo(g, pid, {
      t: "sync", you: g.names[pid], opponent: g.names[op], cfg: g.cfg, target: g.target,
      opponentRating: oa ? oa.rating : null, ranked: g.ranked,
      score: scoreFor(g, pid), roundNo: g.roundNo, over: g.over,
      round: g.round && !g.round.over ? {
        length: g.round.len, winBy: g.cfg.winBy, timeLimit: g.cfg.timeLimit,
        remaining: clockRemaining(g),
        my: { grid: myb.grid.slice(), states: myb.states.slice(), finished: myb.finished, won: myb.won },
        // opponent's colors only, mid-round
        opp: { states: ob.states.slice(), count: ob.grid.length, finished: ob.finished, won: ob.won },
      } : null,
    });
  }

  function clockRemaining(g) {
    if (!g.round || !g.round.deadline) return null;
    return Math.max(0, Math.ceil((g.round.deadline - now()) / 1000));
  }

  // ---- lobby: leave whatever I'm in --------------------------------------
  function dropFromLobby(pid, conn) {
    if (queue && queue.pid === pid && queue.conn === conn) queue = null;
    for (const [code, w] of rooms) if (w.pid === pid && w.conn === conn) rooms.delete(code);
  }

  // ---- WebSocket wiring ---------------------------------------------------
  ws.attach(server, {
    path: "/duel/ws",
    ensurePid,
    onConnection(conn, req) {
      const pid = conn.pid;
      pidConn.set(pid, conn);
      // resolve the logged-in account (if any) from the request cookies
      let acct = null;
      try { acct = identify(req) || null; } catch (_) {}
      pidAccount.set(pid, acct);

      conn.onMessage = (msg) => {
        if (!msg || typeof msg.t !== "string") return;

        if (msg.t === "join") {
          // logged-in trainers always play under their account name
          if (acct) pidName.set(pid, acct.name);
          else if (typeof msg.name === "string") pidName.set(pid, cleanName(msg.name));
          if (pidGame.has(pid)) { syncTo(games.get(pidGame.get(pid)), pid); return; } // already playing

          if (msg.mode === "quick") {
            dropFromLobby(pid, conn);
            if (queue && queue.pid !== pid && pidConn.get(queue.pid) && pidConn.get(queue.pid).alive) {
              const w = queue; queue = null;
              startMatch(w.pid, pid, QUICK_CFG);
            } else {
              queue = { pid, conn };
              conn.send({ t: "queued" });
            }
            return;
          }

          // private room (host creates with cfg, friend joins by code)
          const code = cleanCode(msg.code);
          if (!code) { conn.send({ t: "error", msg: "Enter a room code." }); return; }
          const w = rooms.get(code);
          if (w && w.pid !== pid && pidConn.get(w.pid) && pidConn.get(w.pid).alive) {
            rooms.delete(code);
            const g = startMatch(w.pid, pid, w.cfg); // host's rules win
            return g;
          }
          dropFromLobby(pid, conn);
          const cfg = normCfg(msg.cfg);
          rooms.set(code, { pid, conn, cfg });
          conn.send({ t: "waiting", code, cfg });
          return;
        }

        if (msg.t === "guess") {
          const gid = pidGame.get(pid);
          if (gid != null && games.has(gid)) handleGuess(games.get(gid), pid, msg.guess);
          return;
        }

        if (msg.t === "leave" || msg.t === "resign") {
          dropFromLobby(pid, conn);
          const gid = pidGame.get(pid);
          if (gid != null && games.has(gid)) {
            // a tab/window-switch forfeit carries an extra rating penalty
            if (msg.reason === "focus") focusForfeit(games.get(gid), pid);
            else forfeit(games.get(gid), pid);
          }
          return;
        }

        if (msg.t === "hello" || msg.t === "resync") {
          const gid = pidGame.get(pid);
          if (gid != null && games.has(gid)) syncTo(games.get(gid), pid);
          else conn.send({ t: "idle" });
          return;
        }
      };

      conn.onClose = () => {
        if (pidConn.get(pid) === conn) pidConn.delete(pid);
        dropFromLobby(pid, conn);
        const gid = pidGame.get(pid);
        if (gid != null && games.has(gid)) {
          const g = games.get(gid);
          if (g.conns[pid] === conn) g.conns[pid] = null;
          if (!g.over) broadcast(g, { t: "oppDisc" });
        }
      };

      // greet: resume an in-progress match if there is one, else idle
      const gid = pidGame.get(pid);
      if (gid != null && games.has(gid)) {
        const g = games.get(gid);
        g.conns[pid] = conn;
        syncTo(g, pid);
        if (!g.over) broadcast(g, { t: "oppConn" });
      } else {
        conn.send({ t: "idle" });
      }
    },
  });

  // ---- 1s tick: countdown, per-round clock, timeouts, abandonment ---------
  setInterval(() => {
    const t = now();
    for (const g of games.values()) {
      if (g.over) continue;
      if (g.round && !g.round.over) {
        const r = g.round;
        if (t < r.startAt) {
          const cd = Math.ceil((r.startAt - t) / 1000);
          if (cd !== r.lastTick) { r.lastTick = cd; broadcast(g, { t: "countdown", n: cd }); }
        } else {
          if (!r.went) { r.went = true; broadcast(g, { t: "go", remaining: clockRemaining(g) }); }
          if (r.deadline) {
            const rem = Math.max(0, Math.ceil((r.deadline - t) / 1000));
            broadcast(g, { t: "clock", remaining: rem });
            if (t >= r.deadline) { endRound(g); continue; }
          }
        }
      }
      const bothGone = g.players.every((p) => !g.conns[p] || !g.conns[p].alive);
      if (bothGone) { if (!g.discSince) g.discSince = t; else if (t - g.discSince > ABANDON_MS) cleanup(g); }
      else g.discSince = null;
    }
  }, 1000).unref();
}

module.exports = { init };
