// Pakadle Duel — realtime head-to-head word racing (front-end).
// The server owns every answer and every clock; this client only renders state
// and forwards keystrokes. Your grid shows letters; the opponent's grid shows
// only tile colors mid-round (no letters leak), then the real guesses on reveal.
(function () {
  "use strict";

  const ROWS = 6;
  const FLIP_STAGGER = 220, FLIP_HALF = 250, FLIP_DUR = 500;
  const RANK = { absent: 1, present: 2, correct: 3 };
  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ----- DOM -----
  const lobbyEl = $("lobby"), duelEl = $("duel"), keyboardEl = $("keyboard");
  const boardYou = $("board-you"), boardOpp = $("board-opp");
  const toastWrap = $("toast-wrap");
  const acctChip = $("acct-chip"), acctNameEl = $("acct-name"), acctRatingEl = $("acct-rating");
  const authBtn = $("auth-btn"), boardBtn = $("board-btn"), quitBtn = $("quit-btn");
  const guestRow = $("guest-row"), guestName = $("guest-name");
  const createPanel = $("create-panel"), joinPanel = $("join-panel"), waitingEl = $("waiting");
  const waitText = $("wait-text"), waitRoom = $("wait-room"), waitCode = $("wait-code");
  const cdOverlay = $("countdown"), cdNum = $("cd-num"), resultEl = $("result");
  const authModal = $("auth-modal"), authErr = $("auth-err"), authNameI = $("auth-name"), authPassI = $("auth-pass");
  const boardModal = $("board-modal"), lbList = $("lb-list");
  const clockEl = $("clock"), roundNoEl = $("round-no"), winbyLabel = $("winby-label");
  const youNameEl = $("you-name"), oppNameEl = $("opp-name"), oppHeadEl = $("opp-head");
  const youScoreEl = $("you-score"), oppScoreEl = $("opp-score");
  const discBanner = $("disc-banner"), rankedTag = $("ranked-tag"), oppProgress = $("opp-progress");

  const KEY_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "↵ZXCVBNM⌫"];
  const keyEls = {};

  // ----- state -----
  let account = null;          // {name, rating, wins, losses, draws} | null
  let ws = null, reconnecting = false;
  let inGame = false, roundLive = false, locked = true, isRevealing = false;
  let wordLen = 0, myRow = 0, myGuess = "", myFinished = false;
  let cfg = null;

  // ===================== networking =====================
  function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function ensureConnected(cb) {
    if (ws && ws.readyState === 1) { if (cb) cb(); return; }
    if (ws && ws.readyState === 0) { if (cb) ws.addEventListener("open", cb, { once: true }); return; }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/duel/ws");
    ws.onopen = () => { wsSend({ t: "hello" }); if (cb) cb(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } handle(m); };
    ws.onclose = () => { if (inGame) { setClock("reconnecting…"); setTimeout(() => ensureConnected(), 1500); } };
    ws.onerror = () => {};
  }

  function handle(m) {
    switch (m.t) {
      case "idle": if (reconnecting) { reconnecting = false; sessionStorage.removeItem("duel_live"); } showLobby(); break;
      case "queued": showWaiting(false); break;
      case "waiting": showWaiting(true, m.code); break;
      case "error": toast(m.msg || "Something went wrong"); break;
      case "start": beginMatch(m); break;
      case "round": beginRound(m); break;
      case "countdown": showCountdown(m.n); break;
      case "go": endCountdown(m.remaining); break;
      case "clock": if (typeof m.remaining === "number") setClock(fmtClock(m.remaining), m.remaining); break;
      case "row": applyMyRow(m); break;
      case "oppRow": applyOppRow(m); break;
      case "bad": handleBad(m.reason); break;
      case "roundOver": showRoundOver(m); break;
      case "matchOver": showMatchOver(m); break;
      case "sync": syncMatch(m); break;
      case "oppDisc": discBanner.hidden = false; break;
      case "oppConn": discBanner.hidden = true; break;
    }
  }

  // ===================== lobby / screens =====================
  function hideAll() { lobbyEl.hidden = true; duelEl.hidden = true; }
  function showLobby() {
    inGame = false; roundLive = false; locked = true;
    hideAll(); lobbyEl.hidden = false;
    createPanel.hidden = true; joinPanel.hidden = true; waitingEl.hidden = true;
    lobbyEl.querySelector(".menu-grid").hidden = false;
    guestRow.hidden = !!account;
    quitBtn.hidden = true;
    resultEl.hidden = true; cdOverlay.hidden = true; discBanner.hidden = true;
  }
  function showPanel(el) {
    lobbyEl.querySelector(".menu-grid").hidden = true;
    guestRow.hidden = true;
    createPanel.hidden = el !== createPanel;
    joinPanel.hidden = el !== joinPanel;
    waitingEl.hidden = el !== waitingEl;
    el.hidden = false;
  }
  function showWaiting(isRoom, code) {
    hideAll(); lobbyEl.hidden = false; showPanel(waitingEl);
    waitText.textContent = isRoom ? "Waiting for your friend…" : "Finding an opponent…";
    waitRoom.hidden = !isRoom;
    if (isRoom && code) waitCode.textContent = code;
  }

  function nameForJoin() {
    if (account) return account.name;
    const n = (guestName.value || "").trim().slice(0, 24) || "Trainer";
    guestName.value = n;
    try { localStorage.setItem("duel_name", n); } catch (_) {}
    return n;
  }

  function startQuick() { ensureConnected(() => wsSend({ t: "join", mode: "quick", name: nameForJoin() })); showWaiting(false); }
  function createRoom() {
    const code = genCode();
    ensureConnected(() => wsSend({ t: "join", code, cfg: readSettings(), name: nameForJoin() }));
    showWaiting(true, code);
  }
  function joinRoom() {
    const code = ($("join-code").value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!code) { $("join-code").focus(); return; }
    ensureConnected(() => wsSend({ t: "join", code, name: nameForJoin() }));
    showWaiting(true, code);
  }
  function genCode() {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = ""; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }

  // segmented-control settings
  function wireSeg(id) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      [...$(id).children].forEach((c) => c.classList.toggle("on", c === b));
    });
  }
  function segValue(id) { const on = $(id).querySelector(".on"); return on ? on.dataset.v : null; }
  function readSettings() {
    return { rounds: +segValue("set-rounds"), winBy: segValue("set-winby"), timeLimit: +segValue("set-time") };
  }

  // ===================== match / round flow =====================
  function beginMatch(m) {
    inGame = true; reconnecting = false;
    cfg = m.cfg;
    sessionStorage.setItem("duel_live", "1");
    youNameEl.textContent = m.you || "You";
    oppNameEl.textContent = m.opponent || "Opponent";
    oppHeadEl.textContent = m.opponent || "Opponent";
    rankedTag.hidden = !m.ranked;
    setScore(m.score);
    hideAll(); duelEl.hidden = false;
    quitBtn.hidden = false; quitBtn.textContent = "Resign";
    discBanner.hidden = true; resultEl.hidden = true;
  }

  function beginRound(m) {
    roundLive = true; isRevealing = false; myFinished = false; myRow = 0; myGuess = "";
    wordLen = m.length;
    cfg = { rounds: m.rounds, winBy: m.winBy, timeLimit: m.timeLimit };
    setScore(m.score);
    roundNoEl.textContent = "Round " + m.roundNo;
    winbyLabel.textContent = m.winBy === "guesses" ? "fewest guesses" : "fastest solve";
    oppProgress.textContent = "";
    setClock(m.timeLimit ? fmtClock(m.timeLimit) : "∞");
    buildBoard(boardYou, wordLen, false);
    buildBoard(boardOpp, wordLen, true);
    resetKeyboard();
    resultEl.hidden = true;
    lock(true);
    showCountdown(m.countdown || 3);
  }

  function showCountdown(n) {
    cdOverlay.hidden = false;
    cdNum.textContent = n > 0 ? String(n) : "GO!";
    cdNum.classList.remove("pulse"); void cdNum.offsetWidth; cdNum.classList.add("pulse");
  }
  function endCountdown(remaining) {
    cdNum.textContent = "GO!";
    cdNum.classList.remove("pulse"); void cdNum.offsetWidth; cdNum.classList.add("pulse");
    setTimeout(() => { cdOverlay.hidden = true; }, 450);
    if (typeof remaining === "number") setClock(fmtClock(remaining), remaining);
    else if (cfg && !cfg.timeLimit) setClock("∞");
    lock(false);
  }

  function lock(on) { locked = on; }

  // ===================== boards =====================
  function buildBoard(el, len, masked) {
    el.innerHTML = "";
    el.style.setProperty("--cols", len);
    el.classList.toggle("masked", masked);
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement("div");
      row.className = "drow";
      for (let c = 0; c < len; c++) {
        const t = document.createElement("div");
        t.className = "dtile";
        row.appendChild(t);
      }
      el.appendChild(row);
    }
  }

  // my row confirmed by the server
  function applyMyRow(m) {
    const row = boardYou.children[m.row];
    if (!row) return;
    const tiles = row.children;
    const up = String(m.guess).toUpperCase();
    for (let i = 0; i < wordLen; i++) {
      const tile = tiles[i];
      tile.textContent = up[i];
      tile.classList.add("filled");
      if (!reduceMotion) {
        setTimeout(() => {
          tile.classList.add("flip");
          setTimeout(() => tile.classList.add(m.states[i]), FLIP_HALF);
        }, i * FLIP_STAGGER);
      } else { tile.classList.add(m.states[i]); }
    }
    const total = reduceMotion ? 0 : (wordLen - 1) * FLIP_STAGGER + FLIP_DUR;
    setTimeout(() => {
      updateKeyboard(up, m.states);
      isRevealing = false;
      myGuess = "";
      if (m.finished) { myFinished = true; if (m.won) winBounce(row); }
      else { myRow++; }
    }, total);
  }

  // opponent row: colors only (masked) — never their letters
  function applyOppRow(m) {
    const row = boardOpp.children[m.row];
    if (row) {
      const tiles = row.children;
      for (let i = 0; i < wordLen; i++) {
        tiles[i].classList.add("filled", m.states[i]);
        if (!reduceMotion) { tiles[i].classList.add("pop"); setTimeout(() => tiles[i].classList.remove("pop"), 160); }
      }
    }
    oppProgress.textContent = m.won ? "solved! 🥕" : m.finished ? "out of guesses" : m.count + "/" + ROWS;
  }

  // ===================== typing =====================
  function addLetter(ch) {
    if (locked || isRevealing || myFinished || !roundLive) return;
    if (myGuess.length >= wordLen) return;
    clearInvalid();
    const tile = boardYou.children[myRow].children[myGuess.length];
    tile.textContent = ch; tile.classList.add("filled", "pop");
    setTimeout(() => tile.classList.remove("pop"), 120);
    myGuess += ch;
  }
  function delLetter() {
    if (locked || isRevealing || myFinished || !roundLive || myGuess.length === 0) return;
    clearInvalid();
    myGuess = myGuess.slice(0, -1);
    const tile = boardYou.children[myRow].children[myGuess.length];
    tile.textContent = ""; tile.classList.remove("filled");
  }
  function submitGuess() {
    if (locked || isRevealing || myFinished || !roundLive) return;
    if (myGuess.length < wordLen) { shakeRow(); toast("Not enough letters"); return; }
    isRevealing = true;
    wsSend({ t: "guess", guess: myGuess });
  }
  function handleBad(reason) {
    isRevealing = false;
    if (reason === "notword") markInvalid();
    else shakeRow();
  }

  function shakeRow() {
    const row = boardYou.children[myRow]; if (!row) return;
    row.classList.add("shake");
    row.addEventListener("animationend", () => row.classList.remove("shake"), { once: true });
  }
  function markInvalid() {
    const row = boardYou.children[myRow]; if (!row) return;
    row.classList.add("invalid");
    shakeRow();
    setTimeout(clearInvalid, 900);
  }
  function clearInvalid() {
    const row = boardYou.children[myRow]; if (row) row.classList.remove("invalid");
  }
  function winBounce(row) {
    const tiles = row.children;
    for (let i = 0; i < tiles.length; i++) {
      setTimeout(() => {
        tiles[i].classList.add("bounce");
        tiles[i].addEventListener("animationend", () => tiles[i].classList.remove("bounce"), { once: true });
      }, i * 80);
    }
  }

  // ===================== keyboard =====================
  function buildKeyboard() {
    KEY_ROWS.forEach((rowStr) => {
      const row = document.createElement("div"); row.className = "krow";
      for (const ch of rowStr) {
        const btn = document.createElement("button"); btn.className = "key";
        if (ch === "↵") { btn.textContent = "Enter"; btn.classList.add("wide"); btn.addEventListener("click", submitGuess); }
        else if (ch === "⌫") { btn.textContent = "⌫"; btn.classList.add("wide"); btn.addEventListener("click", delLetter); }
        else { btn.textContent = ch; keyEls[ch] = btn; btn.addEventListener("click", () => addLetter(ch)); }
        row.appendChild(btn);
      }
      keyboardEl.appendChild(row);
    });
  }
  function resetKeyboard() {
    for (const k in keyEls) { keyEls[k].classList.remove("correct", "present", "absent"); delete keyEls[k].dataset.state; }
  }
  function updateKeyboard(g, states) {
    for (let i = 0; i < g.length; i++) {
      const el = keyEls[g[i]]; if (!el) continue;
      const cur = el.dataset.state;
      if (!cur || RANK[states[i]] > RANK[cur]) {
        el.dataset.state = states[i];
        el.classList.remove("correct", "present", "absent");
        el.classList.add(states[i]);
      }
    }
  }

  // ===================== scores / clock =====================
  function setScore(s) { if (!s) return; youScoreEl.textContent = s.you; oppScoreEl.textContent = s.opp; }
  function fmtClock(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ":" + String(s).padStart(2, "0"); }
  function setClock(text, secsLeft) {
    clockEl.textContent = text;
    clockEl.classList.toggle("low", typeof secsLeft === "number" && secsLeft <= 10 && secsLeft > 0);
  }

  // ===================== round / match results =====================
  function showRoundOver(m) {
    roundLive = false; lock(true);
    setScore(m.score);
    // reveal opponent's real letters now that the round is locked
    if (m.oppBoard && m.oppBoard.grid) {
      m.oppBoard.grid.forEach((g, r) => {
        const row = boardOpp.children[r]; if (!row) return;
        const up = String(g).toUpperCase();
        for (let i = 0; i < up.length; i++) { row.children[i].textContent = up[i]; row.children[i].classList.add("revealed"); }
      });
    }
    const e = m.reveal || {};
    const head = m.outcome === "win" ? "Round won! 🥕" : m.outcome === "lose" ? "Round lost" : "Round drawn";
    const cls = m.outcome === "win" ? "win" : m.outcome === "lose" ? "lose" : "draw";
    if (m.outcome === "win") confettiBurst();
    resultEl.className = "overlay show " + cls;
    resultEl.innerHTML = revealCard(head, e, "Next round starting…");
    resultEl.hidden = false;
    wireRevealImg();
  }

  function showMatchOver(m) {
    inGame = false; roundLive = false; lock(true);
    sessionStorage.removeItem("duel_live");
    setScore(m.score);
    quitBtn.textContent = "Quit";
    const head = m.outcome === "win" ? "You win the match! 🏆" : m.outcome === "lose" ? "You lost the match" : "Match drawn";
    const cls = m.outcome === "win" ? "win" : m.outcome === "lose" ? "lose" : "draw";
    if (m.outcome === "win") confettiBurst();
    let sub = "Final score " + m.score.you + " – " + m.score.opp;
    if (m.reason === "forfeit") sub = (m.outcome === "win" ? "Opponent left. " : "") + sub;
    let elo = "";
    if (m.ranked && typeof m.rating === "number") {
      const d = m.delta || 0;
      const sign = d > 0 ? "+" + d : "" + d;
      elo = '<div class="elo">New rating <b>' + m.rating + '</b> <span class="' + (d >= 0 ? "up" : "down") + '">' + sign + "</span></div>";
      // keep our local account rating fresh
      if (account) { account.rating = m.rating; renderAccount(); }
    } else if (!m.ranked) {
      elo = '<div class="elo casual">Casual match — sign in for ranked play.</div>';
    }
    resultEl.className = "overlay show " + cls;
    resultEl.innerHTML =
      '<div class="result-card ' + cls + '">' +
      '<div class="result-badge">' + head + "</div>" +
      '<div class="result-sub">' + sub + "</div>" + elo +
      '<div class="result-btns">' +
      '<button class="primary-btn" id="again-btn">Play again</button>' +
      '<button class="ghost-btn" id="menu-btn">Menu</button>' +
      "</div></div>";
    resultEl.hidden = false;
    $("again-btn").addEventListener("click", () => { resultEl.hidden = true; showLobby(); });
    $("menu-btn").addEventListener("click", () => { resultEl.hidden = true; showLobby(); });
  }

  function revealCard(head, e, footer) {
    const portrait = e.img
      ? '<img class="reveal-portrait" src="' + e.img + '" alt="' + (e.name || "") + '" referrerpolicy="no-referrer" />' : "";
    return (
      '<div class="result-card reveal">' +
      '<div class="result-badge">' + head + "</div>" +
      '<div class="reveal-row">' + portrait +
      '<div class="reveal-info"><div class="reveal-word">' + (e.word || "") + "</div>" +
      '<div class="reveal-name">' + (e.name || "") + "</div>" +
      (e.quote ? '<div class="reveal-quote">' + e.quote + "</div>" : "") + "</div></div>" +
      (footer ? '<div class="result-sub small">' + footer + "</div>" : "") +
      "</div>"
    );
  }
  function wireRevealImg() {
    const img = resultEl.querySelector(".reveal-portrait");
    if (img) img.addEventListener("error", () => { img.style.display = "none"; });
  }

  // ===================== reconnect sync =====================
  function syncMatch(m) {
    inGame = true; reconnecting = false; cfg = m.cfg;
    youNameEl.textContent = m.you || "You";
    oppNameEl.textContent = m.opponent || "Opponent";
    oppHeadEl.textContent = m.opponent || "Opponent";
    rankedTag.hidden = !m.ranked;
    setScore(m.score);
    hideAll(); duelEl.hidden = false;
    quitBtn.hidden = false; quitBtn.textContent = m.over ? "Quit" : "Resign";
    resultEl.hidden = true; cdOverlay.hidden = true;
    roundNoEl.textContent = "Round " + (m.roundNo || 1);
    if (m.round) {
      wordLen = m.round.length;
      winbyLabel.textContent = m.round.winBy === "guesses" ? "fewest guesses" : "fastest solve";
      buildBoard(boardYou, wordLen, false);
      buildBoard(boardOpp, wordLen, true);
      resetKeyboard();
      // my board
      const my = m.round.my;
      my.grid.forEach((g, r) => {
        const up = String(g).toUpperCase();
        for (let i = 0; i < wordLen; i++) {
          boardYou.children[r].children[i].textContent = up[i];
          boardYou.children[r].children[i].classList.add("filled", my.states[r][i]);
        }
        updateKeyboard(up, my.states[r]);
      });
      myRow = my.grid.length; myGuess = ""; myFinished = my.finished; isRevealing = false;
      // opponent colors
      const op = m.round.opp;
      (op.states || []).forEach((st, r) => {
        for (let i = 0; i < wordLen; i++) boardOpp.children[r].children[i].classList.add("filled", st[i]);
      });
      oppProgress.textContent = op.won ? "solved! 🥕" : op.finished ? "out of guesses" : (op.count || 0) + "/" + ROWS;
      setClock(m.round.remaining != null ? fmtClock(m.round.remaining) : (m.round.timeLimit ? fmtClock(m.round.timeLimit) : "∞"), m.round.remaining);
      roundLive = !myFinished;
      lock(false);
    } else {
      lock(true); roundLive = false;
    }
  }

  // ===================== auth =====================
  async function refreshMe() {
    try {
      const r = await fetch("/api/auth/me", { credentials: "same-origin" });
      const d = await r.json();
      account = d.account || null;
    } catch (_) { account = null; }
    renderAccount();
  }
  function renderAccount() {
    if (account) {
      acctChip.hidden = false;
      acctNameEl.textContent = account.name;
      acctRatingEl.textContent = account.rating + " ⚐";
      authBtn.textContent = "Sign out";
    } else {
      acctChip.hidden = true;
      authBtn.textContent = "Sign in";
    }
    // the guest name field only matters when signed out and on the lobby
    if (lobbyEl && !lobbyEl.hidden) guestRow.hidden = !!account;
  }
  let authMode = "login";
  function openAuth(mode) {
    authMode = mode || "login";
    $("tab-login").classList.toggle("on", authMode === "login");
    $("tab-register").classList.toggle("on", authMode === "register");
    $("auth-go").textContent = authMode === "login" ? "Sign in" : "Create account";
    authPassI.setAttribute("autocomplete", authMode === "login" ? "current-password" : "new-password");
    authErr.textContent = "";
    authModal.hidden = false;
    authNameI.focus();
  }
  async function submitAuth() {
    const name = (authNameI.value || "").trim();
    const password = authPassI.value || "";
    if (!name || !password) { authErr.textContent = "Enter a name and password."; return; }
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    try {
      const r = await fetch(path, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      const d = await r.json();
      if (!r.ok) { authErr.textContent = d.error || "Something went wrong."; return; }
      account = d.account; renderAccount();
      authModal.hidden = true; authPassI.value = "";
      toast(authMode === "login" ? "Welcome back, " + account.name + "!" : "Account created — good luck out there!");
    } catch (_) { authErr.textContent = "Connection error."; }
  }
  async function logout() {
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (_) {}
    account = null; renderAccount();
    toast("Signed out");
  }

  // ===================== leaderboard =====================
  async function openBoard() {
    boardModal.hidden = false;
    lbList.innerHTML = '<div class="lb-empty">Loading…</div>';
    try {
      const r = await fetch("/api/leaderboard", { credentials: "same-origin" });
      const d = await r.json();
      const rows = d.leaders || [];
      if (!rows.length) { lbList.innerHTML = '<div class="lb-empty">No ranked trainers yet. Be the first! 🥇</div>'; return; }
      lbList.innerHTML = rows.map((a, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".";
        const me = account && a.name.toLowerCase() === account.name.toLowerCase() ? " me" : "";
        return '<div class="lb-row' + me + '"><span class="lb-rank">' + medal + "</span>" +
          '<span class="lb-name">' + escapeHtml(a.name) + "</span>" +
          '<span class="lb-rating">' + a.rating + "</span>" +
          '<span class="lb-wl">' + a.wins + "W " + a.losses + "L</span></div>";
      }).join("");
    } catch (_) { lbList.innerHTML = '<div class="lb-empty">Could not load the ladder.</div>'; }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ===================== toast =====================
  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    toastWrap.appendChild(t); setTimeout(() => t.remove(), 2200);
  }

  // ===================== confetti =====================
  const CONFETTI = ["#E85D8B", "#F2A93B", "#4CA62E", "#F6C6D8", "#7C748F", "#F4D03F", "#5BB8E8"];
  function confettiBurst() {
    if (reduceMotion) return;
    const layer = $("confetti"), W = innerWidth, H = innerHeight;
    for (const side of ["left", "right"]) {
      const dir = side === "left" ? 1 : -1;
      for (let i = 0; i < 40; i++) {
        const el = document.createElement("div"); el.className = "cfetti";
        el.style.width = 6 + Math.random() * 6 + "px"; el.style.height = 9 + Math.random() * 9 + "px";
        el.style.background = CONFETTI[(Math.random() * CONFETTI.length) | 0];
        if (Math.random() < 0.4) el.style.borderRadius = "50%";
        el.style.bottom = 30 + Math.random() * 30 + "px"; el.style[side] = "0px";
        layer.appendChild(el);
        const ax = dir * (W * 0.12 + Math.random() * W * 0.5), ay = -(H * 0.25 + Math.random() * H * 0.4);
        const ex = ax + dir * (30 + Math.random() * 160), ey = H * 0.15 + Math.random() * H * 0.5;
        const spin = (360 + Math.random() * 720) * (Math.random() < 0.5 ? 1 : -1);
        el.animate([
          { transform: "translate(0,0) rotate(0)", opacity: 1, offset: 0, easing: "cubic-bezier(.15,.6,.4,1)" },
          { transform: "translate(" + ax + "px," + ay + "px) rotate(" + spin * 0.5 + "deg)", opacity: 1, offset: .45, easing: "cubic-bezier(.45,0,.7,.5)" },
          { transform: "translate(" + ex + "px," + ey + "px) rotate(" + spin + "deg)", opacity: 0, offset: 1 },
        ], { duration: 1400 + Math.random() * 900, fill: "forwards" }).onfinish = () => el.remove();
      }
    }
  }

  // ===================== wiring =====================
  $("mode-quick").addEventListener("click", startQuick);
  $("mode-create").addEventListener("click", () => showPanel(createPanel));
  $("mode-join").addEventListener("click", () => { showPanel(joinPanel); $("join-code").value = ""; $("join-code").focus(); });
  $("create-back").addEventListener("click", showLobby);
  $("join-back").addEventListener("click", showLobby);
  $("create-go").addEventListener("click", createRoom);
  $("join-go").addEventListener("click", joinRoom);
  $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("wait-cancel").addEventListener("click", () => { wsSend({ t: "leave" }); showLobby(); });
  ["set-rounds", "set-winby", "set-time"].forEach(wireSeg);

  quitBtn.addEventListener("click", () => {
    if (inGame) { wsSend({ t: "resign" }); } else wsSend({ t: "leave" });
    showLobby();
  });

  authBtn.addEventListener("click", () => { if (account) logout(); else openAuth("login"); });
  $("auth-x").addEventListener("click", () => { authModal.hidden = true; });
  authModal.addEventListener("click", (e) => { if (e.target === authModal) authModal.hidden = true; });
  $("tab-login").addEventListener("click", () => openAuth("login"));
  $("tab-register").addEventListener("click", () => openAuth("register"));
  $("auth-go").addEventListener("click", submitAuth);
  authPassI.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
  authNameI.addEventListener("keydown", (e) => { if (e.key === "Enter") authPassI.focus(); });

  boardBtn.addEventListener("click", openBoard);
  $("lb-x").addEventListener("click", () => { boardModal.hidden = true; });
  boardModal.addEventListener("click", (e) => { if (e.target === boardModal) boardModal.hidden = true; });

  document.addEventListener("keydown", (e) => {
    if (!authModal.hidden || !boardModal.hidden) { if (e.key === "Escape") { authModal.hidden = true; boardModal.hidden = true; } return; }
    if (duelEl.hidden) return;
    if (e.key === "Enter") submitGuess();
    else if (e.key === "Backspace") delLetter();
    else if (/^[a-zA-Z]$/.test(e.key)) addLetter(e.key.toUpperCase());
  });

  // ===================== boot =====================
  buildKeyboard();
  guestName.value = (function () { try { return localStorage.getItem("duel_name") || ""; } catch (_) { return ""; } })();
  showLobby();
  refreshMe();
  // resume a live duel if we navigated away and came back
  if (sessionStorage.getItem("duel_live")) { reconnecting = true; ensureConnected(); }

  // ===================== ambient petals =====================
  (function petals() {
    const layer = $("petals"); if (!layer || reduceMotion) return;
    const COLORS = ["#E85D8B", "#F2A93B", "#4CA62E", "#F6C6D8"];
    for (let i = 0; i < 20; i++) {
      const p = document.createElement("div"); p.className = "petal";
      const inner = document.createElement("i");
      const size = 8 + Math.random() * 10;
      inner.style.width = inner.style.height = size + "px";
      inner.style.background = COLORS[i % COLORS.length];
      inner.style.opacity = (0.16 + Math.random() * 0.2).toFixed(2);
      inner.style.animationDuration = (2 + Math.random() * 2.5).toFixed(2) + "s";
      p.appendChild(inner);
      p.style.left = (Math.random() * 100) + "vw";
      p.style.animationDuration = (9 + Math.random() * 8).toFixed(2) + "s";
      p.style.animationDelay = (-Math.random() * 16).toFixed(2) + "s";
      layer.appendChild(p);
    }
  })();
})();
