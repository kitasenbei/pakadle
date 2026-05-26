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
      if (live && sel && sel[0] === r && sel[1] === c) sq.classList.add("sel");
      if (dl && ((dl[0][0] === r && dl[0][1] === c) || (dl[1][0] === r && dl[1][1] === c))) sq.classList.add("last");
      if (chkSq && chkSq[0] === r && chkSq[1] === c) sq.classList.add("chk");
      const mv = live && selMoves && selMoves.find(m => m.to[0] === r && m.to[1] === c);
      if (mv) sq.classList.add(mv.cap ? "cap" : "move");
      const p = ds.board[r][c];
      if (p) {
        const base = document.createElement("div"); base.className = "base " + p.c; sq.appendChild(base);
        const pc = document.createElement("div"); pc.className = "piece " + p.c; pc.title = NAME[p.t];
        pc.innerHTML = '<img src="' + IMG[p.t] + '" alt="' + NAME[p.t] + '" referrerpolicy="no-referrer">';
        sq.appendChild(pc);
      }
      sq.addEventListener("click", () => onClick(r, c));
      boardEl.appendChild(sq);
    }
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
        statusEl.textContent = loser === "w" ? "Out of time, the AI wins." : "AI flagged, you win! 🥕";
        statusEl.className = loser === "b" ? "win" : "over";
      }
      renderClocks();
    }, 1000);
  }
  function stopClock() { if (clockTimer) clearInterval(clockTimer); clockTimer = null; }

  // ===================== flow =====================
  function onClick(r, c) {
    if (!atLive()) { goTo(history.length - 1); return; } // tap the board to return to the live game
    if (over || busy || state.turn !== "w") return;
    if (sel && selMoves) { const mv = selMoves.find(m => m.to[0] === r && m.to[1] === c); if (mv) { play(mv); return; } }
    const p = state.board[r][c];
    if (p && p.c === "w") { sel = [r, c]; selMoves = legalMoves(state, "w").filter(m => m.from[0] === r && m.from[1] === c); }
    else { sel = null; selMoves = null; }
    render();
  }

  function play(m) {
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
    if (wasLive) viewIdx = history.length - 1; // stay live unless you were reviewing
    renderAll();

    if (mate || stale) {
      over = true; stopClock();
      statusEl.textContent = mate ? (them === "w" ? "Checkmate, the AI wins." : "Checkmate, you win! 🥕") : "Stalemate, it's a draw.";
      statusEl.className = mate && them === "b" ? "win" : "over";
      renderClocks();
      return;
    }
    if (them === "b") { statusEl.textContent = chk ? "Check! AI to move." : "Pakachess is thinking..."; statusEl.className = chk ? "chkmsg" : ""; busy = true; setTimeout(aiMove, 450); }
    else { statusEl.textContent = chk ? "Check! Your move." : "Your move"; statusEl.className = chk ? "chkmsg" : ""; }
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
    statusEl.textContent = "Your move"; statusEl.className = "";
    renderAll(); startClock();
  }

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
})();
