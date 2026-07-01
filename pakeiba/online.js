// Pakeiba — realtime Umamusume horse racing, server-authoritative.
// Trainers gather in a private room (a shared short code), the host adds bots
// and starts the race, then everyone sprints down a straight track by tapping.
// The server owns each horse's position, runs the countdown + race clock, and
// broadcasts positions ~10x/sec so every browser draws the same race.
//
// Up to 12 runners per room (humans + bots combined). "For now" the track is a
// flat straight line; a real racetrack with corners can layer on later without
// changing the wire protocol (positions are a 0..100 progress scalar).
//
// Transport is the same tiny zero-dependency WebSocket server as Pakachess
// (../pakachess/ws.js); this module owns the race logic on top of it.
"use strict";

const MAX_RUNNERS = 12;
const TRACK = 100;            // finish line distance (progress units)
const TICK_MS = 100;          // position broadcast cadence (10 Hz)
const TAP_MIN_MS = 28;        // ignore taps closer than this (autoclicker guard)
const COUNTDOWN_MS = 3000;    // "3·2·1·GO" before the gate opens
const MAX_RACE_MS = 90000;    // safety: end any race that drags on this long
const FINISH_GRACE_MS = 6000; // after the 1st horse crosses, wrap up the field
const ABANDON_MS = 120000;    // empty room (no live humans) this long -> reap it
const RESET_GRACE_MS = 600;   // let "results" land before a rematch can wipe it

// horse silks: a colour per lane, assigned in join order
const SILKS = ["#E85D8B", "#F2A93B", "#4CA62E", "#7C748F", "#3FA7D6", "#C9466F",
               "#9B59B6", "#16A085", "#E67E22", "#2C7BE5", "#D6336C", "#5C6BC0"];

// fun stand-in names for bots, drawn from the uma roster
const BOT_NAMES = ["Gold Ship", "Oguri Cap", "Vodka", "Daiwa Scarlet", "Tokai Teio",
  "Maruzensky", "Grass Wonder", "Mejiro McQueen", "Symboli Rudolf", "Taiki Shuttle",
  "Special Week", "Silence Suzuka", "Air Groove", "Narita Brian", "Agnes Tachyon"];

function init(server, ws, ensurePid) {
  const rooms = new Map();   // code -> room
  const pidRoom = new Map(); // pid -> room code
  const pidConn = new Map(); // pid -> live conn
  const pidName = new Map(); // pid -> chosen display name

  const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const cleanName = (s) => (String(s || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 24)) || "Trainer";

  // ---- send helpers -------------------------------------------------------
  function sendTo(room, pid, msg) { const c = room.conns[pid]; if (c && c.alive) c.send(msg); }
  function broadcast(room, msg) { for (const pid in room.conns) sendTo(room, pid, msg); }

  function liveHumans(room) {
    let n = 0;
    for (const r of room.runners.values()) {
      if (!r.bot && room.conns[r.id] && room.conns[r.id].alive) n++;
    }
    return n;
  }
  function nextSilk(room) {
    const used = new Set([...room.runners.values()].map((r) => r.silk));
    return SILKS.find((c) => !used.has(c)) || SILKS[room.runners.size % SILKS.length];
  }

  // ---- room snapshot for the lobby ---------------------------------------
  function roster(room) {
    return [...room.runners.values()].map((r) => ({
      id: r.id, name: r.name, bot: !!r.bot, silk: r.silk,
    }));
  }
  function roomMsg(room, pid) {
    return {
      t: "room", code: room.code, you: pid, host: room.host === pid,
      racing: room.racing, count: room.runners.size, max: MAX_RUNNERS,
      runners: roster(room),
    };
  }
  function broadcastRoom(room) { for (const pid in room.conns) sendTo(room, pid, roomMsg(room, pid)); }

  // ---- lifecycle ----------------------------------------------------------
  function createRoom(code, hostPid) {
    const room = {
      code, host: hostPid, runners: new Map(), conns: {},
      racing: false, over: false, startAt: 0, raceStart: 0,
      places: [], lastTick: -1, timer: null, emptySince: null, botSeq: 0,
    };
    rooms.set(code, room);
    return room;
  }

  function addRunner(room, id, name, bot, conn) {
    const silk = nextSilk(room);
    room.runners.set(id, {
      id, name, bot: !!bot, silk,
      progress: 0, place: 0, finishedAt: 0, lastTap: 0,
      // bot pace: taps/sec, jittered per tick for a lifelike surge
      rate: bot ? 5.5 + Math.random() * 4 : 0,
    });
    if (conn) room.conns[id] = conn;
  }

  function removeRunner(room, id) {
    room.runners.delete(id);
    delete room.conns[id];
    if (pidRoom.get(id) === room.code) pidRoom.delete(id);
  }

  function cleanup(room) {
    if (room.timer) { clearInterval(room.timer); room.timer = null; }
    for (const id of room.runners.keys()) if (pidRoom.get(id) === room.code) pidRoom.delete(id);
    rooms.delete(room.code);
  }

  // pick a fresh host among connected humans; reap the room if none remain
  function reassignHostOrReap(room) {
    if (room.host && room.runners.has(room.host) && !room.runners.get(room.host).bot &&
        room.conns[room.host] && room.conns[room.host].alive) return; // current host fine
    let next = null;
    for (const r of room.runners.values()) {
      if (!r.bot && room.conns[r.id] && room.conns[r.id].alive) { next = r.id; break; }
    }
    if (next) { room.host = next; broadcastRoom(room); }
    // no live humans: keep the room briefly; the abandon sweep reaps it
  }

  // ---- the race ----------------------------------------------------------
  function startRace(room) {
    if (room.racing) return;
    if (room.runners.size < 1) return;
    room.racing = true; room.over = false; room.places = []; room.lastTick = -1;
    room.startAt = Date.now() + COUNTDOWN_MS; // gate opens after the countdown
    room.raceStart = room.startAt;
    room.finishDeadline = 0; // armed once the first horse crosses the line
    for (const r of room.runners.values()) {
      r.progress = 0; r.place = 0; r.finishedAt = 0; r.lastTap = 0;
    }
    broadcast(room, { t: "raceInit", runners: roster(room), countdown: Math.ceil(COUNTDOWN_MS / 1000) });
    if (!room.timer) room.timer = setInterval(() => tick(room), TICK_MS);
  }

  function positionsMsg(room) {
    const pos = {};
    for (const r of room.runners.values()) pos[r.id] = { p: Math.round(r.progress), place: r.place };
    return { t: "positions", pos };
  }

  function finishRunner(room, r, now) {
    if (r.place) return;
    r.progress = TRACK;
    room.places.push(r.id);
    r.place = room.places.length;
    r.finishedAt = now;
    // first horse over the line starts the clock on stragglers
    if (!room.finishDeadline) room.finishDeadline = now + FINISH_GRACE_MS;
    broadcast(room, { t: "crossed", id: r.id, place: r.place, name: r.name });
  }

  function endRace(room) {
    if (room.over) return;
    room.over = true; room.racing = false;
    // anyone still running gets ranked by remaining distance
    const unplaced = [...room.runners.values()].filter((r) => !r.place)
      .sort((a, b) => b.progress - a.progress);
    for (const r of unplaced) { room.places.push(r.id); r.place = room.places.length; }
    const order = room.places.map((id) => {
      const r = room.runners.get(id);
      return r ? { id: r.id, name: r.name, bot: !!r.bot, silk: r.silk, place: r.place } : null;
    }).filter(Boolean);
    broadcast(room, { t: "results", order });
  }

  function tick(room) {
    const now = Date.now();
    if (!room.racing) {
      // idle room with no live humans -> reap after a grace period
      if (liveHumans(room) === 0) {
        if (!room.emptySince) room.emptySince = now;
        else if (now - room.emptySince > ABANDON_MS) cleanup(room);
      } else room.emptySince = null;
      return;
    }

    // countdown phase
    if (now < room.startAt) {
      const cd = Math.ceil((room.startAt - now) / 1000);
      if (cd !== room.lastTick) { room.lastTick = cd; broadcast(room, { t: "countdown", n: cd }); }
      return;
    }
    if (room.lastTick !== 0) { room.lastTick = 0; broadcast(room, { t: "go" }); }

    // advance bots; humans advance on their own taps
    const dt = TICK_MS / 1000;
    for (const r of room.runners.values()) {
      if (r.bot && !r.place) {
        const jitter = 0.75 + Math.random() * 0.5;   // lifelike surges/lulls
        r.progress += r.rate * dt * 1.15 * jitter;   // 1.15 ≈ avg human stride
        if (r.progress >= TRACK) finishRunner(room, r, now);
      }
    }

    broadcast(room, positionsMsg(room));

    const allDone = [...room.runners.values()].every((r) => r.place);
    const graceUp = room.finishDeadline && now >= room.finishDeadline;
    if (allDone || graceUp || now - room.raceStart > MAX_RACE_MS) endRace(room);
  }

  function handleTap(room, pid) {
    if (!room.racing || room.over) return;
    const now = Date.now();
    if (now < room.startAt) return;               // gate not open yet (false start ignored)
    const r = room.runners.get(pid);
    if (!r || r.bot || r.place) return;
    if (now - r.lastTap < TAP_MIN_MS) return;     // autoclicker guard
    r.lastTap = now;
    r.progress += 0.8 + Math.random() * 0.7;      // a stride of ground per tap
    if (r.progress >= TRACK) finishRunner(room, r, now);
  }

  function leaveRoom(pid) {
    const code = pidRoom.get(pid);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) { pidRoom.delete(pid); return; }
    removeRunner(room, pid);
    if (room.runners.size === 0 || liveHumans(room) === 0) {
      // no humans left: stop the race, let the sweep reap the room
      if (room.runners.size === 0) cleanup(room);
      else { room.emptySince = Date.now(); broadcastRoom(room); }
      return;
    }
    reassignHostOrReap(room);
    broadcastRoom(room);
  }

  // ---- WebSocket wiring ---------------------------------------------------
  ws.attach(server, {
    path: "/pakeiba/ws",
    ensurePid,
    onConnection(conn) {
      const pid = conn.pid;
      pidConn.set(pid, conn);

      conn.onMessage = (msg) => {
        if (!msg || typeof msg.t !== "string") return;

        if (msg.t === "join") {
          if (typeof msg.name === "string") pidName.set(pid, cleanName(msg.name));
          // already in a room? just resync
          if (pidRoom.has(pid) && rooms.has(pidRoom.get(pid))) {
            const room = rooms.get(pidRoom.get(pid));
            room.conns[pid] = conn;
            sendTo(room, pid, roomMsg(room, pid));
            if (room.racing) sendTo(room, pid, positionsMsg(room));
            return;
          }
          const code = cleanCode(msg.code);
          if (!code) { conn.send({ t: "error", msg: "Enter a room code." }); return; }
          let room = rooms.get(code);
          if (!room) room = createRoom(code, pid);
          if (room.racing) { conn.send({ t: "error", msg: "That race already started. Try again after it." }); return; }
          if (room.runners.size >= MAX_RUNNERS) { conn.send({ t: "error", msg: "This room is full (12 runners)." }); return; }
          addRunner(room, pid, pidName.get(pid) || "Trainer", false, conn);
          pidRoom.set(pid, code);
          room.emptySince = null;
          if (!room.timer) room.timer = setInterval(() => tick(room), TICK_MS);
          broadcastRoom(room);
          return;
        }

        const code = pidRoom.get(pid);
        const room = code && rooms.get(code);

        if (msg.t === "addBot") {
          if (!room || room.host !== pid || room.racing) return;
          if (room.runners.size >= MAX_RUNNERS) { conn.send({ t: "error", msg: "Room is full." }); return; }
          const used = new Set([...room.runners.values()].map((r) => r.name));
          const name = BOT_NAMES.find((n) => !used.has(n)) || ("Bot " + (++room.botSeq));
          addRunner(room, "bot:" + room.code + ":" + (++room.botSeq), name, true, null);
          broadcastRoom(room);
          return;
        }

        if (msg.t === "removeBot") {
          if (!room || room.host !== pid || room.racing) return;
          const r = room.runners.get(String(msg.id || ""));
          if (r && r.bot) { removeRunner(room, r.id); broadcastRoom(room); }
          return;
        }

        if (msg.t === "start") {
          if (!room || room.host !== pid || room.racing) return;
          startRace(room);
          return;
        }

        if (msg.t === "tap") {
          if (room) handleTap(room, pid);
          return;
        }

        if (msg.t === "again") {
          // host resets a finished room back to the lobby for a rematch
          if (!room || room.host !== pid || room.racing) return;
          if (!room.over && room.places.length === 0) return;
          setTimeout(() => {
            if (!rooms.has(room.code) || room.racing) return;
            room.over = false; room.places = []; room.lastTick = -1;
            for (const r of room.runners.values()) { r.progress = 0; r.place = 0; r.finishedAt = 0; }
            broadcastRoom(room);
          }, RESET_GRACE_MS);
          return;
        }

        if (msg.t === "leave") { leaveRoom(pid); conn.send({ t: "idle" }); return; }

        if (msg.t === "hello" || msg.t === "resync") {
          if (room) {
            room.conns[pid] = conn;
            sendTo(room, pid, roomMsg(room, pid));
            if (room.racing) sendTo(room, pid, positionsMsg(room));
          } else conn.send({ t: "idle" });
          return;
        }
      };

      conn.onClose = () => {
        if (pidConn.get(pid) === conn) pidConn.delete(pid);
        const code = pidRoom.get(pid);
        const room = code && rooms.get(code);
        if (!room) return;
        if (room.conns[pid] === conn) delete room.conns[pid];
        if (room.racing) {
          // mid-race drop: keep the horse on the track (bots-style coast not applied;
          // it simply stops advancing). The race still ends via allDone/MAX_RACE_MS.
          broadcastRoom(room);
        } else {
          // in the lobby: leaving the tab removes you from the roster
          removeRunner(room, pid);
          if (room.runners.size === 0) { cleanup(room); return; }
          reassignHostOrReap(room);
          broadcastRoom(room);
        }
      };

      // greet: resume the room if there is one, else idle
      const code = pidRoom.get(pid);
      if (code && rooms.has(code)) {
        const room = rooms.get(code);
        room.conns[pid] = conn;
        sendTo(room, pid, roomMsg(room, pid));
        if (room.racing) sendTo(room, pid, positionsMsg(room));
      } else {
        conn.send({ t: "idle" });
      }
    },
  });
}

module.exports = { init };
