// Pakachess: uma-themed chess. Play PakaBot locally, or another person online
// (server-authoritative over WebSockets). Pieces: pawn=Haru Urara, rook=Orfevre,
// knight=Seiun Sky, bishop=Calstone Light O, queen=Aston Machan, king=Durandal.
(function () {
  "use strict";

  const E = window.PakaEngine;
  const { fresh, clone, opp, kingPos, inCheck, legalMoves, doMove, notate, findMove, VAL } = E;

  const IMG = {
    p: "https://static.wikia.nocookie.net/umamusume/images/2/25/Haru_Urara_%28Main%29.png/revision/latest/scale-to-width-down/276?cb=20240731184718",
    r: "https://static.wikia.nocookie.net/umamusume/images/d/dc/Orfevre_%28Main%29.png/revision/latest/scale-to-width-down/236?cb=20240731194838",
    n: "https://static.wikia.nocookie.net/umamusume/images/c/cd/Seiun_Sky_%28Main%29.png/revision/latest/scale-to-width-down/247?cb=20240731202025",
    b: "https://static.wikia.nocookie.net/umamusume/images/a/a5/Calstone_Light_O_%28Main%29.png/revision/latest/scale-to-width-down/245?cb=20240731182618",
    q: "https://static.wikia.nocookie.net/umamusume/images/b/b3/Aston_Machan_%28Main%29.png/revision/latest/scale-to-width-down/250?cb=20240731174024",
    k: "https://static.wikia.nocookie.net/umamusume/images/f/fb/Durandal_%28Main%29.png/revision/latest/scale-to-width-down/239?cb=20240731182621",
  };
  const NAME = { p: "Haru Urara", r: "Orfevre", n: "Seiun Sky", b: "Calstone Light O", q: "Aston Machan", k: "Durandal" };

  const $ = (id) => document.getElementById(id);
  const boardEl = $("board"), statusEl = $("status");
  const trayTop = $("tray-top"), trayBottom = $("tray-bottom");
  const moveListEl = $("movelist");
  const clockSelfEl = $("clock-self"), clockOppEl = $("clock-opp"), oppNameEl = $("opp-name");
  const navFirst = $("nav-first"), navPrev = $("nav-prev"), navNext = $("nav-next"), navLast = $("nav-last");
  const menuEl = $("menu"), gameEl = $("game"), waitingEl = $("waiting");
  const toMenuBtn = $("to-menu"), newGameBtn = $("new-game"), discBanner = $("disc-banner");
  const nameInput = $("name-input");
  const modalEl = $("modal"), modalConfirm = $("modal-confirm"), modalCancel = $("modal-cancel");
  const roomEntryEl = $("room-entry"), roomInput = $("room-input");
  const roomPlay = $("room-play"), roomCancel = $("room-cancel"), waitCodeEl = $("wait-code");

  const CLOCK_START = 600; // 10:00 each
  let state, sel, selMoves, lastMove, over, busy;
  let captured, moveHist, clocks, clockTimer;
  let history, viewIdx;
  let entrance = false, clockStarted = false;
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Firefox mis-composites the flying slide-ghost (drifts/breaks after a hard reload);
  // there it falls back to the instant land+bounce, which it handles fine.
  const noSlide = /firefox/i.test(navigator.userAgent || "");

  // mode + online networking
  let mode = null;        // "bot" | "online" | null (on the menu)
  let myColor = "w";      // which color the human controls
  let flip = false;       // render with black at the bottom
  let ws = null, reconnecting = false;
  const idx = (r, c) => (flip ? (7 - r) * 8 + (7 - c) : r * 8 + c); // board coord -> child index

  // ===================== rendering =====================
  const atLive = () => viewIdx === history.length - 1;

  function render() {
    boardEl.innerHTML = "";
    const live = atLive();
    const ds = live ? state : history[viewIdx].state;
    const dl = live ? lastMove : history[viewIdx].lastMove;
    const chkSq = inCheck(ds, ds.turn) ? kingPos(ds, ds.turn) : null;
    for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) {
      const r = flip ? 7 - dr : dr, c = flip ? 7 - dc : dc;
      const sq = document.createElement("div");
      sq.className = "sq " + ((r + c) % 2 ? "dark" : "light");
      if (entrance && !reduceMotion) { sq.classList.add("enter"); sq.style.animationDelay = ((dr + dc) * 0.03).toFixed(3) + "s"; }
      if (live && sel && sel[0] === r && sel[1] === c) sq.classList.add("sel");
      if (dl && ((dl[0][0] === r && dl[0][1] === c) || (dl[1][0] === r && dl[1][1] === c))) sq.classList.add("last");
      if (chkSq && chkSq[0] === r && chkSq[1] === c) sq.classList.add("chk");
      const mv = live && selMoves && selMoves.find(m => m.to[0] === r && m.to[1] === c);
      if (mv) sq.classList.add(mv.cap ? "cap" : "move");
      const p = ds.board[r][c];
      if (p) {
        if (live && !over && state.turn === myColor && p.c === myColor) sq.classList.add("movable");
        const team = p.c === myColor ? "mine" : "theirs";
        const base = document.createElement("div"); base.className = "base " + team; sq.appendChild(base);
        const pc = document.createElement("div"); pc.className = "piece " + p.c; pc.title = NAME[p.t];
        if (entrance && !reduceMotion) { pc.classList.add("enter"); pc.style.animationDelay = ((dr + dc) * 0.03 + 0.1).toFixed(3) + "s"; }
        pc.innerHTML = '<img src="' + IMG[p.t] + '" alt="' + NAME[p.t] + '" referrerpolicy="no-referrer">';
        sq.appendChild(pc);
        const front = document.createElement("div"); front.className = "basefront " + team; sq.appendChild(front);
      }
      sq.dataset.r = r; sq.dataset.c = c;
      boardEl.appendChild(sq);
    }
    entrance = false;
  }

  function bounceAt(to) {
    const cell = boardEl.children[idx(to[0], to[1])];
    const pc = cell && cell.querySelector(".piece");
    if (!pc) return;
    pc.classList.remove("land"); void pc.offsetWidth; pc.classList.add("land");
    pc.addEventListener("animationend", () => pc.classList.remove("land"), { once: true });
  }
  function animateSlide(from, to) {
    if (noSlide) { bounceAt(to); return; } // Firefox: skip the flying ghost, just land+bounce
    const oSq = boardEl.children[idx(from[0], from[1])];
    const dSq = boardEl.children[idx(to[0], to[1])];
    const dPiece = dSq && dSq.querySelector(".piece");
    if (!oSq || !dPiece) return;
    // hide the whole destination frame (piece + team ring + front rail) until the uma lands
    const hide = [dPiece, dSq.querySelector(".base"), dSq.querySelector(".basefront")].filter(Boolean);
    // Anchor to the board's wrapper (a plain flex column, NOT the grid) so the path
    // can't drift, and place the ghost at the destination. Then animate a composited
    // transform from the origin offset back to zero via the Web Animations API, which
    // handles the from->to itself (no reflow/rAF race that Firefox runs flaky).
    const anchor = boardEl.parentElement; // .boardcol (position:relative)
    const ref = anchor.getBoundingClientRect();
    const a = oSq.getBoundingClientRect(), b = dSq.getBoundingClientRect();
    const w = dPiece.offsetWidth, h = dPiece.offsetHeight;
    const x1 = b.left - ref.left + (b.width - w) / 2, y1 = b.top - ref.top + (b.height - h) / 2;
    const dx = a.left - b.left, dy = a.top - b.top; // origin relative to destination
    const ghost = dPiece.cloneNode(true);
    ghost.className = "piece slideghost";
    ghost.style.cssText = "position:absolute;margin:0;z-index:900;pointer-events:none;width:" + w +
      "px;height:" + h + "px;left:" + x1 + "px;top:" + y1 + "px;";
    anchor.appendChild(ghost);
    hide.forEach((el) => { el.style.opacity = "0"; });
    const done = () => { if (!ghost.parentNode) return; ghost.remove(); hide.forEach((el) => { el.style.opacity = ""; }); bounceAt(to); };
    if (ghost.animate) {
      const anim = ghost.animate(
        [{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "translate(0,0)" }],
        { duration: 220, easing: "cubic-bezier(.3,.85,.35,1)" }
      );
      anim.onfinish = done; anim.oncancel = done;
      setTimeout(done, 320); // safety net
    } else { done(); }
  }

  function renderTrays() {
    const pts = (arr) => arr.reduce((s, p) => s + VAL[p.t], 0);
    const icons = (arr) => arr.slice().sort((a, b) => VAL[b.t] - VAL[a.t])
      .map(p => '<img class="cap ' + p.c + '" src="' + IMG[p.t] + '" referrerpolicy="no-referrer" title="' + NAME[p.t] + '">').join("");
    const mine = captured[myColor], theirs = captured[opp(myColor)];
    const diff = pts(mine) - pts(theirs);
    trayBottom.innerHTML = icons(mine) + (diff > 0 ? '<span class="adv">+' + diff + "</span>" : "");
    trayTop.innerHTML = icons(theirs) + (diff < 0 ? '<span class="adv">+' + (-diff) + "</span>" : "");
  }

  function renderMoves() {
    let html = "";
    for (let i = 0; i < moveHist.length; i += 2) {
      const wa = viewIdx === i + 1 ? " active" : "", ba = viewIdx === i + 2 ? " active" : "";
      html += '<div class="mv"><span class="n">' + (i / 2 + 1) + '.</span>'
        + '<span class="ply' + wa + '" data-ply="' + i + '">' + moveHist[i] + "</span>"
        + (moveHist[i + 1] != null
            ? '<span class="ply' + ba + '" data-ply="' + (i + 1) + '">' + moveHist[i + 1] + "</span>"
            : "<span></span>") + "</div>";
    }
    moveListEl.innerHTML = html || '<div class="mv empty">No moves yet.</div>';
    if (atLive()) moveListEl.scrollTop = moveListEl.scrollHeight;
  }

  function updateNav() {
    const start = viewIdx <= 0, end = atLive();
    navFirst.disabled = navPrev.disabled = start;
    navNext.disabled = navLast.disabled = end;
  }
  function goTo(i) { viewIdx = Math.max(0, Math.min(history.length - 1, i)); renderAll(); }

  const fmt = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  function renderClocks() {
    clockSelfEl.querySelector(".time").textContent = fmt(clocks[myColor]);
    clockOppEl.querySelector(".time").textContent = fmt(clocks[opp(myColor)]);
    clockSelfEl.classList.toggle("active", !over && state.turn === myColor);
    clockOppEl.classList.toggle("active", !over && state.turn === opp(myColor));
  }
  function popTime(color) {
    const el = (color === myColor ? clockSelfEl : clockOppEl).querySelector(".time");
    el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick");
  }
  function setStatus(text, cls) {
    statusEl.textContent = text; statusEl.className = cls || "";
    if (reduceMotion) return;
    statusEl.classList.remove("pop"); void statusEl.offsetWidth; statusEl.classList.add("pop");
  }
  function renderAll() { render(); renderTrays(); renderMoves(); renderClocks(); updateNav(); }

  // ===================== local clock (PakaBot mode) =====================
  function startClock() {
    stopClock();
    clockTimer = setInterval(() => {
      if (over) return;
      clocks[state.turn] = Math.max(0, clocks[state.turn] - 1);
      if (clocks[state.turn] === 0) {
        over = true; stopClock();
        const loser = state.turn;
        setStatus(loser === "w" ? "Out of time, PakaBot wins." : "PakaBot flagged, you win! 🥕", loser === "b" ? "win" : "over");
      }
      renderClocks();
      if (!reduceMotion && !over) popTime(state.turn);
    }, 1000);
  }
  function stopClock() { if (clockTimer) clearInterval(clockTimer); clockTimer = null; }

  // ===================== input: click + drag =====================
  let drag = null;
  const DRAG_THRESHOLD = 6;
  const myTurn = () => mode && !over && !busy && state.turn === myColor;
  function selectAt(r, c) {
    sel = [r, c];
    selMoves = legalMoves(state, myColor).filter(m => m.from[0] === r && m.from[1] === c);
  }
  function tryMoveTo(r, c, slide = true) {
    if (!sel || !selMoves) return false;
    const mv = selMoves.find(m => m.to[0] === r && m.to[1] === c);
    if (mv) { makeMove(mv, slide); return true; }
    return false;
  }
  function sqUnder(x, y) {
    const el = document.elementFromPoint(x, y);
    const sq = el && el.closest ? el.closest(".sq") : null;
    if (!sq || !boardEl.contains(sq)) return null;
    return [+sq.dataset.r, +sq.dataset.c];
  }

  function onPointerDown(e) {
    const sqEl = e.target.closest(".sq");
    if (!sqEl) return;
    const r = +sqEl.dataset.r, c = +sqEl.dataset.c;
    if (!atLive()) { goTo(history.length - 1); return; }
    if (!myTurn()) return;
    if (tryMoveTo(r, c)) return;
    const p = state.board[r][c];
    if (p && p.c === myColor) {
      selectAt(r, c); render();
      const liveSq = boardEl.children[idx(r, c)];
      drag = { from: [r, c], sqEl: liveSq, pieceEl: liveSq.querySelector(".piece"),
               startX: e.clientX, startY: e.clientY, moved: false, ghost: null, hover: null, pid: e.pointerId };
      try { boardEl.setPointerCapture(e.pointerId); } catch (_) {}
    } else { sel = null; selMoves = null; render(); }
  }
  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.moved = true;
      const rect = drag.sqEl.getBoundingClientRect();
      const g = drag.pieceEl.cloneNode(true);
      g.classList.add("ghost"); g.style.width = rect.width + "px"; g.style.height = rect.width + "px";
      document.body.appendChild(g); drag.ghost = g;
      drag.pieceEl.style.opacity = "0.25";
    }
    drag.ghost.style.left = e.clientX + "px"; drag.ghost.style.top = e.clientY + "px";
    const t = sqUnder(e.clientX, e.clientY);
    const cur = t ? boardEl.children[idx(t[0], t[1])] : null;
    if (cur !== drag.hover) {
      if (drag.hover) drag.hover.classList.remove("draghover");
      boardEl.querySelectorAll(".destghost").forEach(n => n.remove());
      if (cur) {
        cur.classList.add("draghover");
        if (!cur.querySelector(".piece")) {
          const dg = drag.pieceEl.cloneNode(true);
          dg.className = "piece destghost"; dg.style.opacity = "";
          cur.appendChild(dg);
        }
      }
      drag.hover = cur;
    }
  }
  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag; drag = null;
    try { boardEl.releasePointerCapture(e.pointerId); } catch (_) {}
    endDragFor(d);
    if (!d.moved) return;
    const t = sqUnder(e.clientX, e.clientY);
    if (t && t[0] === d.from[0] && t[1] === d.from[1]) { render(); return; }
    if (t && tryMoveTo(t[0], t[1], false)) return;
    sel = null; selMoves = null; render();
  }
  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag; drag = null; endDragFor(d);
  }
  function endDragFor(d) {
    if (d.hover) d.hover.classList.remove("draghover");
    boardEl.querySelectorAll(".destghost").forEach(n => n.remove());
    if (d.ghost) d.ghost.remove();
    if (d.pieceEl) d.pieceEl.style.opacity = "";
  }

  // ===================== move application (shared) =====================
  function applyMove(m, slide) {
    const wasLive = atLive();
    const mover = state.turn;
    if (m.cap) captured[mover].push({ t: m.capType, c: opp(mover) });
    state = doMove(state, m);
    lastMove = [m.from, m.to]; sel = null; selMoves = null;
    const them = state.turn;
    const theirLegal = legalMoves(state, them);
    const chk = inCheck(state, them);
    const mate = chk && theirLegal.length === 0;
    const stale = !chk && theirLegal.length === 0;
    moveHist.push(notate(m, chk, mate));
    history.push({ state: clone(state), lastMove });
    if (wasLive) viewIdx = history.length - 1;
    renderAll();
    if (atLive() && !reduceMotion) { if (slide) animateSlide(m.from, m.to); else bounceAt(m.to); }
    return { mover, them, chk, mate, stale };
  }
  function makeMove(m, slide) { if (mode === "online") onlineMove(m, slide); else botPlay(m, slide); }

  // ===================== PakaBot (local) =====================
  function botPlay(m, slide) {
    if (!clockStarted) { clockStarted = true; startClock(); }
    const { them, chk, mate, stale } = applyMove(m, slide);
    if (mate || stale) {
      over = true; stopClock();
      setStatus(mate ? (them === "w" ? "Checkmate, PakaBot wins." : "Checkmate, you win! 🥕") : "Stalemate, it's a draw.",
                mate && them === "b" ? "win" : "over");
      renderClocks();
      return;
    }
    if (them === "b") { setStatus(chk ? "Check! PakaBot to move." : "PakaBot is thinking...", chk ? "chkmsg" : ""); busy = true; setTimeout(aiMove, 450); }
    else { setStatus(chk ? "Check! Your move." : "Your move", chk ? "chkmsg" : ""); }
  }
  function aiMove() {
    const moves = legalMoves(state, "b");
    let best = [], bs = -1;
    for (const m of moves) { let s = m.cap ? VAL[m.capType] : 0; if (m.promo) s += 8; if (s > bs) { bs = s; best = [m]; } else if (s === bs) best.push(m); }
    busy = false;
    botPlay(best[Math.floor(Math.random() * best.length)]);
  }
  function newGame() { // PakaBot game
    mode = "bot"; myColor = "w"; flip = false;
    oppNameEl.textContent = "PakaBot";
    state = fresh(); sel = null; selMoves = null; lastMove = null; over = false; busy = false;
    captured = { w: [], b: [] }; moveHist = []; clocks = { w: CLOCK_START, b: CLOCK_START };
    history = [{ state: clone(state), lastMove: null }]; viewIdx = 0;
    clockStarted = false; stopClock();
    setStatus("Your move", "");
    showGame();
    entrance = true; renderAll();
  }

  // ===================== online =====================
  function onlineTurnStatus(turn, chk) {
    if (over) return;
    const mine = turn === myColor;
    setStatus(chk ? (mine ? "Check! Your move." : "Check! Opponent to move.")
                  : (mine ? "Your move" : "Opponent to move"), chk ? "chkmsg" : "");
  }
  function onlineMove(m, slide) {
    const { them, chk } = applyMove(m, slide);
    wsSend({ t: "move", from: m.from, to: m.to });
    onlineTurnStatus(them, chk);
  }
  function remoteMove(from, to) {
    const m = findMove(state, from, to);
    if (!m) { wsSend({ t: "resync" }); return; }
    const { them, chk } = applyMove(m, true);
    onlineTurnStatus(them, chk);
  }
  function setClocks(c, turn) {
    const prevSelf = clocks[myColor], prevOpp = clocks[opp(myColor)];
    clocks = { w: c.w, b: c.b };
    renderClocks();
    if (!reduceMotion && turn) {
      if (turn === myColor && clocks[myColor] < prevSelf) popTime(myColor);
      else if (turn !== myColor && clocks[opp(myColor)] < prevOpp) popTime(opp(myColor));
    }
  }
  function recomputeCaptured(s) { // rebuild trays from the board after a reconnect
    const init = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
    const cnt = { w: {}, b: {} };
    for (const row of s.board) for (const p of row) if (p) cnt[p.c][p.t] = (cnt[p.c][p.t] || 0) + 1;
    const cap = { w: [], b: [] };
    for (const t of ["q", "r", "b", "n", "p"]) {
      for (let i = 0; i < init[t] - (cnt.b[t] || 0); i++) cap.w.push({ t, c: "b" });
      for (let i = 0; i < init[t] - (cnt.w[t] || 0); i++) cap.b.push({ t, c: "w" });
    }
    return cap;
  }

  function beginOnlineFresh(msg) {
    mode = "online"; reconnecting = false;
    myColor = msg.color; flip = (myColor === "b");
    oppNameEl.textContent = msg.opponent || "Opponent";
    localStorage.setItem("pkc_online", "1");
    state = fresh(); sel = null; selMoves = null; lastMove = null; over = false; busy = false;
    captured = { w: [], b: [] }; moveHist = []; clocks = { w: msg.clocks.w, b: msg.clocks.b };
    history = [{ state: clone(state), lastMove: null }]; viewIdx = 0;
    clockStarted = false; stopClock();
    showGame();
    entrance = true; renderAll();
    onlineTurnStatus(state.turn, false);
  }
  function beginOnlineSync(msg) {
    mode = "online"; reconnecting = false;
    myColor = msg.color; flip = (myColor === "b");
    oppNameEl.textContent = msg.opponent || "Opponent";
    localStorage.setItem("pkc_online", "1");
    state = clone(msg.state);
    sel = null; selMoves = null; lastMove = msg.lastMove || null; busy = false;
    over = !!msg.over;
    captured = recomputeCaptured(state);
    moveHist = (msg.moves || []).slice();
    clocks = { w: msg.clocks.w, b: msg.clocks.b };
    history = [{ state: clone(state), lastMove }]; viewIdx = 0;
    showGame();
    entrance = false; renderAll();
    if (over) showOnlineOver(msg.result, msg.reason);
    else onlineTurnStatus(state.turn, inCheck(state, state.turn));
  }
  function showOnlineOver(result, reason) {
    over = true; stopClock();
    localStorage.removeItem("pkc_online");
    let text, cls;
    if (result === "draw") { text = reason === "stalemate" ? "Stalemate, it's a draw." : "Draw."; cls = "over"; }
    else {
      const youWon = result === myColor;
      const why = reason === "checkmate" ? "Checkmate" : reason === "timeout" ? "Time" : reason === "resign" ? "Resignation" : "Opponent left";
      text = youWon ? (why + ", you win! 🥕") : (why + ", you lose.");
      cls = youWon ? "win" : "over";
    }
    setStatus(text, cls);
    renderClocks();
    setDisc(false);
    toMenuBtn.textContent = "Menu";
    newGameBtn.hidden = false; newGameBtn.textContent = "Play again";
  }

  function handleServer(msg) {
    switch (msg.t) {
      case "idle":
        if (reconnecting) { reconnecting = false; localStorage.removeItem("pkc_online"); showMenu(); }
        break;
      case "waiting":
        if (msg.code) waitCodeEl.textContent = msg.code;
        showWaiting(); break;
      case "start":
        beginOnlineFresh(msg); break;
      case "sync":
        beginOnlineSync(msg); break;
      case "move":
        if (msg.ply === moveHist.length && msg.by === myColor) setClocks(msg.clocks, msg.turn); // my move confirmed
        else if (msg.ply === moveHist.length + 1) { remoteMove(msg.from, msg.to); setClocks(msg.clocks, msg.turn); }
        else if (msg.ply > moveHist.length + 1) wsSend({ t: "resync" });
        break;
      case "clock":
        if (mode === "online" && !over) setClocks(msg.clocks, msg.turn); break;
      case "over":
        if (mode === "online") showOnlineOver(msg.result, msg.reason); break;
      case "oppDisc":
        if (mode === "online" && !over) setDisc(true); break;
      case "oppConn":
        if (mode === "online") setDisc(false); break;
    }
  }

  function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function ensureConnected(cb) {
    if (ws && ws.readyState === 1) { if (cb) cb(); return; }
    if (ws && ws.readyState === 0) { if (cb) ws.addEventListener("open", cb, { once: true }); return; }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/pakachess/ws");
    ws.onopen = () => { wsSend({ t: "hello" }); if (cb) cb(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } handleServer(m); };
    ws.onclose = () => { if (mode === "online" && !over) { setStatus("Reconnecting...", ""); setTimeout(() => ensureConnected(), 1500); } };
    ws.onerror = () => {};
  }
  function genCode() {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous O/0/I/1
    let s = ""; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  function joinRoom() {
    const code = (roomInput.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!code) { roomInput.focus(); return; }
    roomInput.value = code;
    const name = (nameInput.value || "").trim().slice(0, 24) || "Trainer";
    nameInput.value = name;
    localStorage.setItem("pkc_name", name);
    $("wait-name").textContent = name;
    waitCodeEl.textContent = code;
    showWaiting();
    ensureConnected(() => wsSend({ t: "join", code, name }));
  }

  // ===================== screens =====================
  function setDisc(on) { if (discBanner) discBanner.hidden = !on; }
  function showMenu() {
    mode = null; stopClock(); setDisc(false);
    menuEl.hidden = false; gameEl.hidden = true; waitingEl.hidden = true; roomEntryEl.hidden = true;
    menuEl.querySelector(".name-row").hidden = false;
    menuEl.querySelector(".menu-grid").hidden = false;
    toMenuBtn.hidden = true; newGameBtn.hidden = true;
  }
  function showRoomEntry() {
    menuEl.hidden = false; gameEl.hidden = true; waitingEl.hidden = true;
    menuEl.querySelector(".name-row").hidden = true;
    menuEl.querySelector(".menu-grid").hidden = true;
    roomEntryEl.hidden = false;
    toMenuBtn.hidden = true; newGameBtn.hidden = true;
    roomInput.value = genCode();
    roomInput.focus(); roomInput.select();
  }
  function showWaiting() {
    menuEl.hidden = false; gameEl.hidden = true; roomEntryEl.hidden = true;
    menuEl.querySelector(".name-row").hidden = true;
    menuEl.querySelector(".menu-grid").hidden = true;
    waitingEl.hidden = false;
  }
  function showGame() {
    menuEl.hidden = true; gameEl.hidden = false; setDisc(false);
    toMenuBtn.hidden = false;
    if (mode === "online") { toMenuBtn.textContent = "Resign"; newGameBtn.hidden = true; }
    else { toMenuBtn.textContent = "Menu"; newGameBtn.hidden = false; newGameBtn.textContent = "New Game"; }
  }

  // ===================== wiring =====================
  boardEl.addEventListener("pointerdown", onPointerDown);
  boardEl.addEventListener("pointermove", onPointerMove);
  boardEl.addEventListener("pointerup", onPointerUp);
  boardEl.addEventListener("pointercancel", onPointerCancel);

  $("mode-bot").addEventListener("click", newGame);
  $("mode-online").addEventListener("click", showRoomEntry);
  roomPlay.addEventListener("click", joinRoom);
  roomCancel.addEventListener("click", showMenu);
  roomInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("cancel-wait").addEventListener("click", () => { wsSend({ t: "leave" }); showMenu(); });

  newGameBtn.addEventListener("click", () => {
    if (mode === "bot") newGame();
    else if (mode === "online") showRoomEntry(); // "Play again" -> pick a room again
  });
  function leaveToMenu() {
    if (mode === "online") localStorage.removeItem("pkc_online");
    showMenu();
  }
  toMenuBtn.addEventListener("click", () => {
    if (mode === "online" && !over) modalEl.hidden = false; // resigning a live game -> confirm first
    else leaveToMenu();                                     // bot game, or already over -> just leave
  });
  modalCancel.addEventListener("click", () => { modalEl.hidden = true; });
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) modalEl.hidden = true; });
  modalConfirm.addEventListener("click", () => {
    modalEl.hidden = true;
    if (mode === "online" && !over) wsSend({ t: "resign" });
    leaveToMenu();
  });

  navFirst.addEventListener("click", () => goTo(0));
  navPrev.addEventListener("click", () => goTo(viewIdx - 1));
  navNext.addEventListener("click", () => goTo(viewIdx + 1));
  navLast.addEventListener("click", () => goTo(history.length - 1));
  moveListEl.addEventListener("click", (e) => {
    const el = e.target.closest(".ply");
    if (el && +el.dataset.ply < moveHist.length) goTo(+el.dataset.ply + 1);
  });
  document.addEventListener("keydown", (e) => {
    if (!modalEl.hidden) { if (e.key === "Escape") modalEl.hidden = true; return; }
    if (gameEl.hidden) return;
    if (e.key === "ArrowLeft") { goTo(viewIdx - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { goTo(viewIdx + 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { goTo(0); e.preventDefault(); }
    else if (e.key === "ArrowDown") { goTo(history.length - 1); e.preventDefault(); }
  });

  // entry point: resume an online game in progress, otherwise show the menu
  nameInput.value = localStorage.getItem("pkc_name") || ("Trainer-" + Math.floor(1000 + Math.random() * 9000));
  if (localStorage.getItem("pkc_online")) { reconnecting = true; ensureConnected(); }
  else showMenu();

  // ===================== drifting petals (ambient background) =====================
  (function petals() {
    const layer = $("petals");
    if (!layer || reduceMotion) return;
    const COLORS = ["#E85D8B", "#F2A93B", "#4CA62E", "#F6C6D8"];
    for (let i = 0; i < 22; i++) {
      const p = document.createElement("div"); p.className = "petal";
      const inner = document.createElement("i");
      const size = 8 + Math.random() * 10;
      inner.style.width = inner.style.height = size + "px";
      inner.style.background = COLORS[i % COLORS.length];
      inner.style.opacity = (0.18 + Math.random() * 0.22).toFixed(2);
      inner.style.animationDuration = (2 + Math.random() * 2.5).toFixed(2) + "s";
      p.appendChild(inner);
      p.style.left = (Math.random() * 100) + "vw";
      p.style.animationDuration = (9 + Math.random() * 8).toFixed(2) + "s";
      p.style.animationDelay = (-Math.random() * 16).toFixed(2) + "s";
      layer.appendChild(p);
    }
  })();

  // ===== jumpy "Waiting for an opponent..." letters (staggered hop wave) =====
  (function jumpyWait() {
    const el = document.querySelector(".wait-text");
    if (!el || reduceMotion) return;
    const text = el.textContent;
    el.textContent = "";
    [...text].forEach((ch, i) => {
      const s = document.createElement("span");
      s.textContent = ch === " " ? " " : ch;
      s.style.animationDelay = (i * 0.06).toFixed(2) + "s";
      el.appendChild(s);
    });
  })();
})();
