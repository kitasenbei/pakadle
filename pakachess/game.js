// Pakachess: uma-themed chess vs a (dumb) AI. Fully client-side.
// Pieces: pawn=Haru Urara, rook=Orfevre, knight=Seiun Sky,
//         bishop=Calstone Light O, queen=Aston Machan, king=Durandal.
(function () {
  "use strict";

  const IMG = {
    p: "https://static.wikia.nocookie.net/umamusume/images/2/25/Haru_Urara_%28Main%29.png/revision/latest/scale-to-width-down/276?cb=20240731184718",
    r: "https://static.wikia.nocookie.net/umamusume/images/d/dc/Orfevre_%28Main%29.png/revision/latest/scale-to-width-down/236?cb=20240731194838",
    n: "https://static.wikia.nocookie.net/umamusume/images/c/cd/Seiun_Sky_%28Main%29.png/revision/latest/scale-to-width-down/247?cb=20240731202025",
    b: "https://static.wikia.nocookie.net/umamusume/images/a/a5/Calstone_Light_O_%28Main%29.png/revision/latest/scale-to-width-down/245?cb=20240731182618",
    q: "https://static.wikia.nocookie.net/umamusume/images/b/b3/Aston_Machan_%28Main%29.png/revision/latest/scale-to-width-down/250?cb=20240731174024",
    k: "https://static.wikia.nocookie.net/umamusume/images/f/fb/Durandal_%28Main%29.png/revision/latest/scale-to-width-down/239?cb=20240731182621",
  };
  const NAME = { p: "Haru Urara", r: "Orfevre", n: "Seiun Sky", b: "Calstone Light O", q: "Aston Machan", k: "Durandal" };
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const FILES = "abcdefgh";
  const sqn = (r, c) => FILES[c] + (8 - r);

  const $ = (id) => document.getElementById(id);
  const boardEl = $("board"), statusEl = $("status");
  const trayTop = $("tray-top"), trayBottom = $("tray-bottom");
  const moveListEl = $("movelist"), clockWEl = $("clock-w"), clockBEl = $("clock-b");
  const navFirst = $("nav-first"), navPrev = $("nav-prev"), navNext = $("nav-next"), navLast = $("nav-last");

  const CLOCK_START = 600; // 10:00 each
  let state, sel, selMoves, lastMove, over, busy;
  let captured, moveHist, clocks, clockTimer;
  let history, viewIdx; // history[i] = snapshot after ply i (history[0] = start); viewIdx = position shown
  let entrance = false; // animate pieces sliding in on a fresh board
  let clockStarted = false; // clocks don't tick until the first move is played
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ===================== engine =====================
  function fresh() {
    const back = ["r", "n", "b", "q", "k", "b", "n", "r"];
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (let c = 0; c < 8; c++) {
      board[0][c] = { t: back[c], c: "b" }; board[1][c] = { t: "p", c: "b" };
      board[6][c] = { t: "p", c: "w" }; board[7][c] = { t: back[c], c: "w" };
    }
    return { board, turn: "w", rights: { wK: true, wQ: true, bK: true, bQ: true }, ep: null };
  }
  const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const opp = (c) => (c === "w" ? "b" : "w");
  const clone = (s) => ({ board: s.board.map(row => row.map(p => (p ? { ...p } : null))), turn: s.turn, rights: { ...s.rights }, ep: s.ep ? [...s.ep] : null });
  function kingPos(s, col) { for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = s.board[r][c]; if (p && p.t === "k" && p.c === col) return [r, c]; } return null; }

  function attacked(s, r, c, by) {
    const B = s.board;
    const pr = by === "w" ? r + 1 : r - 1;
    for (const dc of [-1, 1]) { const p = inB(pr, c + dc) && B[pr][c + dc]; if (p && p.c === by && p.t === "p") return true; }
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) { const p = inB(r + dr, c + dc) && B[r + dr][c + dc]; if (p && p.c === by && p.t === "n") return true; }
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const p = inB(r + dr, c + dc) && B[r + dr][c + dc]; if (p && p.c === by && p.t === "k") return true; }
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) { let rr = r + dr, cc = c + dc; while (inB(rr, cc)) { const p = B[rr][cc]; if (p) { if (p.c === by && (p.t === "r" || p.t === "q")) return true; break; } rr += dr; cc += dc; } }
    for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) { let rr = r + dr, cc = c + dc; while (inB(rr, cc)) { const p = B[rr][cc]; if (p) { if (p.c === by && (p.t === "b" || p.t === "q")) return true; break; } rr += dr; cc += dc; } }
    return false;
  }
  const inCheck = (s, col) => { const k = kingPos(s, col); return k ? attacked(s, k[0], k[1], opp(col)) : false; };

  function pseudo(s, col) {
    const B = s.board, out = [];
    const add = (fr, fc, tr, tc, extra) => out.push(Object.assign({ from: [fr, fc], to: [tr, tc], t: B[fr][fc].t }, extra || {}));
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = B[r][c]; if (!p || p.c !== col) continue;
      if (p.t === "p") {
        const dir = col === "w" ? -1 : 1, start = col === "w" ? 6 : 1, last = col === "w" ? 0 : 7;
        if (inB(r + dir, c) && !B[r + dir][c]) { add(r, c, r + dir, c, { promo: r + dir === last }); if (r === start && !B[r + 2 * dir][c]) add(r, c, r + 2 * dir, c, { dbl: true }); }
        for (const dc of [-1, 1]) { const tr = r + dir, tc = c + dc; if (!inB(tr, tc)) continue; const tp = B[tr][tc];
          if (tp && tp.c !== col) add(r, c, tr, tc, { cap: true, capType: tp.t, promo: tr === last });
          else if (s.ep && s.ep[0] === tr && s.ep[1] === tc) add(r, c, tr, tc, { cap: true, capType: "p", ep: true }); }
      } else if (p.t === "n") {
        for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) { const tr = r + dr, tc = c + dc; if (!inB(tr, tc)) continue; const tp = B[tr][tc]; if (!tp) add(r, c, tr, tc); else if (tp.c !== col) add(r, c, tr, tc, { cap: true, capType: tp.t }); }
      } else if (p.t === "k") {
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const tr = r + dr, tc = c + dc; if (!inB(tr, tc)) continue; const tp = B[tr][tc]; if (!tp) add(r, c, tr, tc); else if (tp.c !== col) add(r, c, tr, tc, { cap: true, capType: tp.t }); }
        const home = col === "w" ? 7 : 0, kS = col === "w" ? "wK" : "bK", qS = col === "w" ? "wQ" : "bQ";
        if (r === home && c === 4 && !inCheck(s, col)) {
          if (s.rights[kS] && !B[home][5] && !B[home][6] && B[home][7] && B[home][7].t === "r" && !attacked(s, home, 5, opp(col)) && !attacked(s, home, 6, opp(col))) add(r, c, home, 6, { castle: "K" });
          if (s.rights[qS] && !B[home][1] && !B[home][2] && !B[home][3] && B[home][0] && B[home][0].t === "r" && !attacked(s, home, 3, opp(col)) && !attacked(s, home, 2, opp(col))) add(r, c, home, 2, { castle: "Q" });
        }
      } else {
        const dirs = p.t === "r" ? [[-1,0],[1,0],[0,-1],[0,1]] : p.t === "b" ? [[-1,-1],[-1,1],[1,-1],[1,1]] : [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
        for (const [dr, dc] of dirs) { let tr = r + dr, tc = c + dc; while (inB(tr, tc)) { const tp = B[tr][tc]; if (!tp) add(r, c, tr, tc); else { if (tp.c !== col) add(r, c, tr, tc, { cap: true, capType: tp.t }); break; } tr += dr; tc += dc; } }
      }
    }
    return out;
  }

  function doMove(s, m) {
    const ns = clone(s), B = ns.board, [fr, fc] = m.from, [tr, tc] = m.to, p = B[fr][fc];
    B[tr][tc] = p; B[fr][fc] = null;
    if (m.ep) B[fr][tc] = null;
    if (m.promo) p.t = "q";
    if (m.castle === "K") { B[tr][5] = B[tr][7]; B[tr][7] = null; }
    if (m.castle === "Q") { B[tr][3] = B[tr][0]; B[tr][0] = null; }
    if (p.t === "k") { if (p.c === "w") { ns.rights.wK = ns.rights.wQ = false; } else { ns.rights.bK = ns.rights.bQ = false; } }
    const touch = (r, c) => { if (r === 7 && c === 0) ns.rights.wQ = false; if (r === 7 && c === 7) ns.rights.wK = false; if (r === 0 && c === 0) ns.rights.bQ = false; if (r === 0 && c === 7) ns.rights.bK = false; };
    touch(fr, fc); touch(tr, tc);
    ns.ep = m.dbl ? [(fr + tr) / 2, fc] : null;
    ns.turn = opp(s.turn);
    return ns;
  }
  const legalMoves = (s, col) => pseudo(s, col).filter(m => !inCheck(doMove(s, m), col));

  // ===================== notation =====================
  function notate(m, chk, mate) {
    let s;
    if (m.castle === "K") s = "O-O";
    else if (m.castle === "Q") s = "O-O-O";
    else s = (m.t === "p" ? "" : m.t.toUpperCase()) + sqn(m.from[0], m.from[1]) + (m.cap ? "x" : "-") + sqn(m.to[0], m.to[1]) + (m.promo ? "=Q" : "");
    return s + (mate ? "#" : chk ? "+" : "");
  }

  // ===================== rendering =====================
  const atLive = () => viewIdx === history.length - 1;

  function render() {
    boardEl.innerHTML = "";
    const live = atLive();
    const ds = live ? state : history[viewIdx].state;     // displayed position
    const dl = live ? lastMove : history[viewIdx].lastMove; // its last move
    const chkSq = inCheck(ds, ds.turn) ? kingPos(ds, ds.turn) : null;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const sq = document.createElement("div");
      sq.className = "sq " + ((r + c) % 2 ? "dark" : "light");
      if (entrance && !reduceMotion) { sq.classList.add("enter"); sq.style.animationDelay = ((r + c) * 0.03).toFixed(3) + "s"; }
      if (live && sel && sel[0] === r && sel[1] === c) sq.classList.add("sel");
      if (dl && ((dl[0][0] === r && dl[0][1] === c) || (dl[1][0] === r && dl[1][1] === c))) sq.classList.add("last");
      if (chkSq && chkSq[0] === r && chkSq[1] === c) sq.classList.add("chk");
      const mv = live && selMoves && selMoves.find(m => m.to[0] === r && m.to[1] === c);
      if (mv) sq.classList.add(mv.cap ? "cap" : "move");
      const p = ds.board[r][c];
      if (p) {
        if (live && !over && state.turn === "w" && p.c === "w") sq.classList.add("movable");
        const base = document.createElement("div"); base.className = "base " + p.c; sq.appendChild(base);
        const pc = document.createElement("div"); pc.className = "piece " + p.c; pc.title = NAME[p.t];
        if (entrance && !reduceMotion) { pc.classList.add("enter"); pc.style.animationDelay = ((r + c) * 0.03 + 0.1).toFixed(3) + "s"; }
        pc.innerHTML = '<img src="' + IMG[p.t] + '" alt="' + NAME[p.t] + '" referrerpolicy="no-referrer">';
        sq.appendChild(pc);
      }
      sq.dataset.r = r; sq.dataset.c = c;
      boardEl.appendChild(sq);
    }
    entrance = false;
  }

  // a piece "lands" with a little overshoot bounce
  function bounceAt(to) {
    const pc = boardEl.children[to[0] * 8 + to[1]].querySelector(".piece");
    if (!pc) return;
    pc.classList.remove("land"); void pc.offsetWidth; pc.classList.add("land");
    pc.addEventListener("animationend", () => pc.classList.remove("land"), { once: true });
  }
  // slide a floating clone from origin to destination (no square-clipping), then land
  function animateSlide(from, to) {
    const oSq = boardEl.children[from[0] * 8 + from[1]];
    const dSq = boardEl.children[to[0] * 8 + to[1]];
    const dPiece = dSq && dSq.querySelector(".piece");
    if (!oSq || !dPiece) return;
    const a = oSq.getBoundingClientRect(), b = dSq.getBoundingClientRect(), pr = dPiece.getBoundingClientRect();
    const ghost = dPiece.cloneNode(true);
    ghost.className = "piece slideghost";
    ghost.style.cssText = "position:fixed;margin:0;z-index:900;pointer-events:none;width:" + pr.width +
      "px;height:" + pr.height + "px;left:" + (a.left + a.width / 2) + "px;top:" + (a.top + a.height / 2) +
      "px;transform:translate(-50%,-50%);transition:none;";
    document.body.appendChild(ghost);
    dPiece.style.opacity = "0";
    ghost.getBoundingClientRect(); // force reflow so the start position sticks
    requestAnimationFrame(() => {
      ghost.style.transition = "left .22s cubic-bezier(.3,.85,.35,1), top .22s cubic-bezier(.3,.85,.35,1)";
      ghost.style.left = (b.left + b.width / 2) + "px";
      ghost.style.top = (b.top + b.height / 2) + "px";
    });
    const done = () => {
      if (!ghost.parentNode) return;
      ghost.remove(); dPiece.style.opacity = ""; bounceAt(to);
    };
    ghost.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 360);
  }

  function renderTrays() {
    const pts = (arr) => arr.reduce((s, p) => s + VAL[p.t], 0);
    const icons = (arr) => arr.slice().sort((a, b) => VAL[b.t] - VAL[a.t])
      .map(p => '<img class="cap ' + p.c + '" src="' + IMG[p.t] + '" referrerpolicy="no-referrer" title="' + NAME[p.t] + '">').join("");
    const diff = pts(captured.w) - pts(captured.b);
    trayTop.innerHTML = icons(captured.b) + (diff < 0 ? '<span class="adv">+' + (-diff) + "</span>" : "");
    trayBottom.innerHTML = icons(captured.w) + (diff > 0 ? '<span class="adv">+' + diff + "</span>" : "");
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
    clockWEl.querySelector(".time").textContent = fmt(clocks.w);
    clockBEl.querySelector(".time").textContent = fmt(clocks.b);
    clockWEl.classList.toggle("active", !over && state.turn === "w");
    clockBEl.classList.toggle("active", !over && state.turn === "b");
  }
  function popTime(side) { // a little bounce on the digit that just ticked
    const el = (side === "w" ? clockWEl : clockBEl).querySelector(".time");
    el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick");
  }
  function setStatus(text, cls) { // status text pops when it changes
    statusEl.textContent = text; statusEl.className = cls || "";
    if (reduceMotion) return;
    statusEl.classList.remove("pop"); void statusEl.offsetWidth; statusEl.classList.add("pop");
  }
  function renderAll() { render(); renderTrays(); renderMoves(); renderClocks(); updateNav(); }

  // ===================== clock =====================
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

  // ===================== flow: click + drag =====================
  let drag = null;
  const DRAG_THRESHOLD = 6;
  function selectAt(r, c) {
    sel = [r, c];
    selMoves = legalMoves(state, "w").filter(m => m.from[0] === r && m.from[1] === c);
  }
  function tryMoveTo(r, c, slide = true) {
    if (!sel || !selMoves) return false;
    const mv = selMoves.find(m => m.to[0] === r && m.to[1] === c);
    if (mv) { play(mv, slide); return true; }
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
    if (!atLive()) { goTo(history.length - 1); return; }   // tap board to return to live game
    if (over || busy || state.turn !== "w") return;
    if (tryMoveTo(r, c)) return;                            // a piece was selected: this is its target
    const p = state.board[r][c];
    if (p && p.c === "w") {
      selectAt(r, c); render();
      const liveSq = boardEl.children[r * 8 + c]; // re-query: render() just rebuilt the board
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
    const cur = t ? boardEl.children[t[0] * 8 + t[1]] : null;
    if (cur !== drag.hover) {
      if (drag.hover) drag.hover.classList.remove("draghover");
      boardEl.querySelectorAll(".destghost").forEach(n => n.remove());
      if (cur) {
        cur.classList.add("draghover");
        if (!cur.querySelector(".piece")) { // only preview on empty squares; occupied ones already show a uma
          const dg = drag.pieceEl.cloneNode(true); // translucent preview snapped to the hovered square
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
    if (!d.moved) return;                                   // pure tap: selection stays for tap-to-move
    const t = sqUnder(e.clientX, e.clientY);
    if (t && t[0] === d.from[0] && t[1] === d.from[1]) { render(); return; } // dropped back: keep selected
    if (t && tryMoveTo(t[0], t[1], false)) return; // dragged: piece is already there, just land it
    sel = null; selMoves = null; render();                  // dropped on a non-target: deselect
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

  function play(m, slide = true) {
    const wasLive = atLive();
    const mover = state.turn;
    if (!clockStarted) { clockStarted = true; startClock(); } // first move starts the clocks
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
    if (wasLive) viewIdx = history.length - 1; // stay live unless you were reviewing
    renderAll();
    if (atLive() && !reduceMotion) { if (slide) animateSlide(m.from, m.to); else bounceAt(m.to); }

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
    play(best[Math.floor(Math.random() * best.length)]);
  }

  function newGame() {
    state = fresh(); sel = null; selMoves = null; lastMove = null; over = false; busy = false;
    captured = { w: [], b: [] }; moveHist = []; clocks = { w: CLOCK_START, b: CLOCK_START };
    history = [{ state: clone(state), lastMove: null }]; viewIdx = 0;
    setStatus("Your move", "");
    clockStarted = false; stopClock(); // wait for the first move before ticking
    entrance = true; renderAll();
  }

  boardEl.addEventListener("pointerdown", onPointerDown);
  boardEl.addEventListener("pointermove", onPointerMove);
  boardEl.addEventListener("pointerup", onPointerUp);
  boardEl.addEventListener("pointercancel", onPointerCancel);

  $("new-game").addEventListener("click", newGame);
  navFirst.addEventListener("click", () => goTo(0));
  navPrev.addEventListener("click", () => goTo(viewIdx - 1));
  navNext.addEventListener("click", () => goTo(viewIdx + 1));
  navLast.addEventListener("click", () => goTo(history.length - 1));
  moveListEl.addEventListener("click", (e) => {
    const el = e.target.closest(".ply");
    if (el && +el.dataset.ply < moveHist.length) goTo(+el.dataset.ply + 1);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { goTo(viewIdx - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { goTo(viewIdx + 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { goTo(0); e.preventDefault(); }
    else if (e.key === "ArrowDown") { goTo(history.length - 1); e.preventDefault(); }
  });
  newGame();

  // ===== drifting petals (ambient background) =====
  (function petals() {
    const layer = $("petals");
    if (!layer || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
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
})();
