// Pakachess rules engine, shared by the browser client and the Node server so
// both validate moves with identical code. Isomorphic: attaches to window in the
// browser, exports via module.exports under Node.
(function (global, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else global.PakaEngine = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const FILES = "abcdefgh";
  const sqn = (r, c) => FILES[c] + (8 - r);
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

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

  function notate(m, chk, mate) {
    let s;
    if (m.castle === "K") s = "O-O";
    else if (m.castle === "Q") s = "O-O-O";
    else s = (m.t === "p" ? "" : m.t.toUpperCase()) + sqn(m.from[0], m.from[1]) + (m.cap ? "x" : "-") + sqn(m.to[0], m.to[1]) + (m.promo ? "=Q" : "");
    return s + (mate ? "#" : chk ? "+" : "");
  }

  // find the fully-annotated legal move matching a from/to (and promo) request
  function findMove(s, from, to) {
    return legalMoves(s, s.turn).find(m =>
      m.from[0] === from[0] && m.from[1] === from[1] && m.to[0] === to[0] && m.to[1] === to[1]) || null;
  }

  return { fresh, clone, opp, kingPos, inCheck, pseudo, legalMoves, doMove, notate, findMove, VAL, FILES, sqn };
});
