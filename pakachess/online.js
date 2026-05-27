// Pakachess online: server-authoritative matchmaking, clocks, and reconnect.
// Players meet in private rooms (a shared short code); the first to enter a code
// waits, the second pairs with them. The server owns the board state and both
// clocks, validating every move with the shared engine.
"use strict";

const E = require("./engine.js");

const START_MS = 600000;   // 10:00 per side
const ABANDON_MS = 120000; // drop a game if both players gone this long

function init(server, ws, ensurePid) {
  const games = new Map();      // id -> game
  const pidGame = new Map();    // pid -> game id
  const pidConn = new Map();    // pid -> live conn
  const rooms = new Map();      // room code -> { pid, conn } waiting for a partner
  let nextId = 1;
  const pidName = new Map();    // pid -> chosen display name
  const cleanCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const cleanName = (s) => (String(s).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 24)) || "Trainer";

  const opp = (c) => (c === "w" ? "b" : "w");
  const colorOf = (g, pid) => (g.players.w === pid ? "w" : g.players.b === pid ? "b" : null);

  function liveClocks(g) {
    let lw = g.clock.w, lb = g.clock.b;
    if (g.started && !g.over) {
      const el = Date.now() - g.turnStart;
      if (g.state.turn === "w") lw -= el; else lb -= el;
    }
    return { w: Math.max(0, Math.ceil(lw / 1000)), b: Math.max(0, Math.ceil(lb / 1000)) };
  }

  function sendTo(g, pid, msg) { const c = g.conns[pid]; if (c && c.alive) c.send(msg); }
  function broadcast(g, msg) { sendTo(g, g.players.w, msg); sendTo(g, g.players.b, msg); }

  function cleanup(g) {
    games.delete(g.id);
    if (pidGame.get(g.players.w) === g.id) pidGame.delete(g.players.w);
    if (pidGame.get(g.players.b) === g.id) pidGame.delete(g.players.b);
  }

  function finish(g, result, reason) {
    if (g.over) return;
    const clocks = liveClocks(g); // capture elapsed time before freezing the game
    g.over = true; g.result = result; g.reason = reason;
    broadcast(g, { t: "over", result, reason, clocks });
    setTimeout(() => cleanup(g), 1500); // let the over message land, then free it
  }

  function startGame(pidA, pidB) {
    const white = Math.random() < 0.5 ? pidA : pidB;
    const black = white === pidA ? pidB : pidA;
    const names = { w: pidName.get(white) || "Trainer", b: pidName.get(black) || "Trainer" };
    const g = {
      id: nextId++, players: { w: white, b: black }, conns: {}, names,
      state: E.fresh(), clock: { w: START_MS, b: START_MS },
      turnStart: null, started: false, over: false, result: null, reason: null,
      moves: [], lastMove: null, discSince: null,
    };
    g.conns[white] = pidConn.get(white) || null;
    g.conns[black] = pidConn.get(black) || null;
    games.set(g.id, g);
    pidGame.set(white, g.id); pidGame.set(black, g.id);
    sendTo(g, white, { t: "start", color: "w", opponent: names.b, clocks: { w: 600, b: 600 } });
    sendTo(g, black, { t: "start", color: "b", opponent: names.w, clocks: { w: 600, b: 600 } });
  }

  function syncTo(g, pid) {
    const col = colorOf(g, pid);
    sendTo(g, pid, {
      t: "sync", color: col, opponent: g.names[opp(col)],
      state: g.state, clocks: liveClocks(g), moves: g.moves, lastMove: g.lastMove,
      over: g.over, result: g.result, reason: g.reason,
    });
  }

  function handleMove(g, pid, from, to) {
    if (g.over) return;
    const col = colorOf(g, pid);
    if (col !== g.state.turn) return;                 // not your turn
    const m = E.findMove(g.state, from, to);
    if (!m) { sendTo(g, pid, { t: "error", msg: "illegal move" }); return; }

    const now = Date.now();
    if (!g.started) g.started = true;                 // first move starts the clocks
    else g.clock[col] -= (now - g.turnStart);
    g.turnStart = now;

    g.state = E.doMove(g.state, m);
    const them = g.state.turn;
    const chk = E.inCheck(g.state, them);
    const legal = E.legalMoves(g.state, them);
    const mate = chk && legal.length === 0;
    const stale = !chk && legal.length === 0;
    g.moves.push(E.notate(m, chk, mate));
    g.lastMove = [from, to];

    broadcast(g, { t: "move", ply: g.moves.length, from, to, by: col, turn: them, check: chk, clocks: liveClocks(g) });
    if (mate) finish(g, col, "checkmate");
    else if (stale) finish(g, "draw", "stalemate");
  }

  function leaveQueueOrGame(pid, conn, asResign) {
    for (const [code, w] of rooms) if (w.pid === pid && w.conn === conn) rooms.delete(code);
    const gid = pidGame.get(pid);
    if (gid != null) {
      const g = games.get(gid);
      if (g && !g.over) finish(g, opp(colorOf(g, pid)), asResign ? "resign" : "abandon");
    }
  }

  ws.attach(server, {
    path: "/pakachess/ws",
    ensurePid,
    onConnection(conn) {
      const pid = conn.pid;
      pidConn.set(pid, conn);

      conn.onMessage = (msg) => {
        if (!msg || typeof msg.t !== "string") return;
        if (msg.t === "join") {
          if (typeof msg.name === "string") pidName.set(pid, cleanName(msg.name));
          if (pidGame.has(pid)) { syncTo(games.get(pidGame.get(pid)), pid); return; } // already playing
          const code = cleanCode(msg.code);
          if (!code) { conn.send({ t: "error", msg: "Enter a room code." }); return; }
          const w = rooms.get(code);
          if (w && w.pid !== pid && pidConn.get(w.pid) && pidConn.get(w.pid).alive) {
            rooms.delete(code);
            startGame(w.pid, pid);                 // friend was waiting in this room -> pair up
          } else {
            for (const [c, rw] of rooms) if (rw.pid === pid) rooms.delete(c); // drop any prior wait
            rooms.set(code, { pid, conn });
            conn.send({ t: "waiting", code });
          }
        } else if (msg.t === "move") {
          const gid = pidGame.get(pid);
          if (gid != null && games.has(gid) && Array.isArray(msg.from) && Array.isArray(msg.to)) {
            handleMove(games.get(gid), pid, msg.from, msg.to);
          }
        } else if (msg.t === "resign") {
          leaveQueueOrGame(pid, conn, true);
        } else if (msg.t === "leave") {
          leaveQueueOrGame(pid, conn, true);
        } else if (msg.t === "hello" || msg.t === "resync") {
          const gid = pidGame.get(pid);
          if (gid != null && games.has(gid)) syncTo(games.get(gid), pid);
          else conn.send({ t: "idle" });
        }
      };

      conn.onClose = () => {
        if (pidConn.get(pid) === conn) pidConn.delete(pid);
        for (const [code, w] of rooms) if (w.conn === conn) rooms.delete(code);
        const gid = pidGame.get(pid);
        if (gid != null && games.has(gid)) {
          const g = games.get(gid);
          if (g.conns[pid] === conn) g.conns[pid] = null;
          if (!g.over) broadcast(g, { t: "oppDisc" });
        }
      };

      // greet: resume an active game if one exists, else idle
      const gid = pidGame.get(pid);
      if (gid != null && games.has(gid)) {
        const g = games.get(gid);
        g.conns[pid] = conn;
        syncTo(g, pid);
        broadcast(g, { t: "oppConn" });
      } else {
        conn.send({ t: "idle" });
      }
    },
  });

  // 1s tick: detect timeouts, push clock syncs, reap abandoned games
  setInterval(() => {
    const now = Date.now();
    for (const g of games.values()) {
      if (g.over) continue;
      if (g.started) {
        const side = g.state.turn;
        const rem = g.clock[side] - (now - g.turnStart);
        if (rem <= 0) { g.clock[side] = 0; finish(g, opp(side), "timeout"); continue; }
        broadcast(g, { t: "clock", clocks: liveClocks(g), turn: side });
      }
      const bothGone = (!g.conns[g.players.w] || !g.conns[g.players.w].alive) &&
                       (!g.conns[g.players.b] || !g.conns[g.players.b].alive);
      if (bothGone) { if (!g.discSince) g.discSince = now; else if (now - g.discSince > ABANDON_MS) cleanup(g); }
      else g.discSince = null;
    }
  }, 1000).unref();
}

module.exports = { init };
