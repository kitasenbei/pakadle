// Pakeiba client — lobby + paddock + the race. The server owns every horse's
// position; this file just renders what it's told and forwards taps. Positions
// arrive ~10x/sec and CSS transitions smooth them into a gallop.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ----- elements -----
  const lobbyEl = $("lobby"), roomEl = $("room");
  const guestName = $("guest-name");
  const modeCreate = $("mode-create"), modeJoin = $("mode-join");
  const codePanel = $("code-panel"), codeTitle = $("code-title"), roomCodeInput = $("room-code");
  const codeBack = $("code-back"), codeGo = $("code-go"), menuGrid = lobbyEl.querySelector(".menu-grid");
  const quitBtn = $("quit-btn");

  const roomCodeShow = $("room-code-show"), shareCode = $("share-code"), runnerCount = $("runner-count");
  const paddock = $("paddock"), rosterEl = $("roster");
  const hostControls = $("host-controls"), waitHost = $("wait-host");
  const addBotBtn = $("add-bot"), startBtn = $("start-race");
  const trackWrap = $("track-wrap"), trackEl = $("track"), raceStatus = $("race-status");
  const runBtn = $("run-btn");
  const cdOverlay = $("countdown"), cdNum = $("cd-num"), resultEl = $("result");
  const toastWrap = $("toast-wrap");

  // ----- state -----
  let ws = null;
  let myPid = null, isHost = false, racing = false, raceOver = false;
  let runners = [];               // [{id,name,bot,silk}]
  const laneEls = {};             // id -> { row, horse, badge }

  // ===================== networking =====================
  function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function connect(cb) {
    if (ws && ws.readyState === 1) { if (cb) cb(); return; }
    if (ws && ws.readyState === 0) { if (cb) ws.addEventListener("open", cb, { once: true }); return; }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/pakeiba/ws");
    ws.onopen = () => { wsSend({ t: "hello" }); if (cb) cb(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } handle(m); };
    ws.onclose = () => { if (inRoom()) setTimeout(() => connect(), 1500); };
    ws.onerror = () => {};
  }
  const inRoom = () => !roomEl.hidden;

  function handle(m) {
    switch (m.t) {
      case "idle": showLobby(); break;
      case "room": onRoom(m); break;
      case "error": toast(m.msg || "Something went wrong"); break;
      case "raceInit": onRaceInit(m); break;
      // race-phase messages only matter while we're actually in a room view;
      // a stray one (e.g. a reconnect crossing the lobby) must never leak the
      // full-screen overlay over the lobby and lock the player out.
      case "countdown": if (inRoom()) showCountdown(m.n); break;
      case "go": onGo(); break;
      case "positions": if (inRoom()) applyPositions(m.pos); break;
      case "crossed": if (inRoom()) onCrossed(m); break;
      case "results": if (inRoom()) showResults(m.order); break;
    }
  }

  // ===================== lobby =====================
  function nameForJoin() {
    const n = (guestName.value || "").trim().slice(0, 24) || "Trainer";
    guestName.value = n;
    try { localStorage.setItem("pakeiba_name", n); } catch (_) {}
    return n;
  }

  function showLobby() {
    racing = false; raceOver = false;
    roomEl.hidden = true; lobbyEl.hidden = false;
    menuGrid.hidden = false; codePanel.hidden = true;
    quitBtn.hidden = true;
    hideCountdown(); resultEl.hidden = true;
  }
  function showCodePanel(mode) {
    codeTitle.textContent = mode === "create" ? "Create a room" : "Join a room";
    codeGo.textContent = mode === "create" ? "Create" : "Join";
    menuGrid.hidden = true; codePanel.hidden = false;
    if (mode === "create") roomCodeInput.value = randomCode();
    roomCodeInput.focus();
  }
  function randomCode() {
    const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = ""; for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }

  function doJoin() {
    const code = (roomCodeInput.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!code) { toast("Enter a room code."); return; }
    const name = nameForJoin();
    connect(() => wsSend({ t: "join", code, name }));
  }

  // ===================== room / paddock =====================
  function onRoom(m) {
    myPid = m.you; isHost = m.host; racing = m.racing;
    runners = m.runners || [];
    lobbyEl.hidden = true; roomEl.hidden = false;
    quitBtn.hidden = false;
    roomCodeShow.textContent = m.code;
    shareCode.textContent = m.code;
    runnerCount.textContent = m.count;

    if (racing) { showTrack(); return; }
    raceOver = false;
    // back in the paddock (fresh room or after a rematch reset)
    paddock.hidden = false; trackWrap.hidden = true;
    resultEl.hidden = true; hideCountdown();
    renderRoster();
    hostControls.hidden = !isHost;
    waitHost.hidden = isHost;
    startBtn.disabled = runners.length < 1;
  }

  function renderRoster() {
    rosterEl.innerHTML = "";
    runners.forEach((r) => {
      const card = document.createElement("div");
      card.className = "runner-card" + (r.id === myPid ? " me" : "");
      card.innerHTML =
        `<span class="silk" style="background:${r.silk}"></span>` +
        `<span class="rn-emoji">🐎</span>` +
        `<span class="rn-name">${esc(r.name)}</span>` +
        (r.bot ? `<span class="rn-tag bot">BOT</span>` : "") +
        (r.id === myPid ? `<span class="rn-tag you">YOU</span>` : "");
      if (isHost && r.bot && !racing) {
        const x = document.createElement("button");
        x.className = "rn-remove"; x.textContent = "×"; x.title = "Remove bot";
        x.onclick = () => wsSend({ t: "removeBot", id: r.id });
        card.appendChild(x);
      }
      rosterEl.appendChild(card);
    });
  }

  // ===================== the race =====================
  function showTrack() {
    paddock.hidden = true; trackWrap.hidden = false;
    resultEl.hidden = true;
    buildTrack();
    raceStatus.textContent = "Racing!";
    // reconnect mid-race: let them run. The server drops any taps that land
    // before the gate opens, so enabling early is harmless.
    runBtn.disabled = false;
  }

  function onRaceInit(m) {
    runners = m.runners || [];
    racing = true; raceOver = false;
    paddock.hidden = true; trackWrap.hidden = false;
    resultEl.hidden = true;
    buildTrack();
    runBtn.disabled = true;
    raceStatus.textContent = "Get ready…";
  }

  function buildTrack() {
    trackEl.innerHTML = "";
    Object.keys(laneEls).forEach((k) => delete laneEls[k]);
    runners.forEach((r) => {
      const lane = document.createElement("div");
      lane.className = "lane";
      const horse = document.createElement("div");
      horse.className = "horse";
      horse.textContent = "🐎";
      horse.style.filter = `drop-shadow(0 0 0 ${r.silk})`;
      const tag = document.createElement("span");
      tag.className = "lane-name" + (r.id === myPid ? " me" : "");
      tag.style.color = r.silk;
      tag.textContent = r.name + (r.id === myPid ? " (you)" : "");
      const badge = document.createElement("span");
      badge.className = "place-badge"; badge.hidden = true;
      lane.appendChild(tag);
      lane.appendChild(horse);
      lane.appendChild(badge);
      const finish = document.createElement("div");
      finish.className = "finish-line";
      lane.appendChild(finish);
      trackEl.appendChild(lane);
      laneEls[r.id] = { lane, horse, badge };
    });
  }

  function onGo() {
    racing = true; raceOver = false;
    raceStatus.textContent = "GO! 🏁";
    runBtn.disabled = false;
    hideCountdown();
    flashGo();
  }

  function applyPositions(pos) {
    for (const id in pos) {
      const el = laneEls[id];
      if (!el) continue;
      const p = Math.max(0, Math.min(100, pos[id].p));
      // horse travels across the lane; 6% reserved at the right for the finish post
      el.horse.style.left = (p * 0.92) + "%";
    }
  }

  function onCrossed(m) {
    const el = laneEls[m.id];
    if (el) {
      el.badge.hidden = false;
      el.badge.textContent = ordinal(m.place);
      el.badge.className = "place-badge p" + Math.min(m.place, 4);
    }
    if (m.id === myPid) {
      runBtn.disabled = true;
      raceStatus.textContent = "You finished " + ordinal(m.place) + "!";
    }
  }

  function tap() {
    if (!racing || raceOver) return;
    if (runBtn.disabled) return;
    wsSend({ t: "tap" });
    runBtn.classList.remove("pulse");
    void runBtn.offsetWidth;
    runBtn.classList.add("pulse");
  }

  // ===================== results =====================
  function showResults(order) {
    raceOver = true; racing = false;
    runBtn.disabled = true;
    raceStatus.textContent = "Photo finish!";
    const medals = ["🥇", "🥈", "🥉"];
    const rows = order.map((r, i) =>
      `<div class="res-row${r.id === myPid ? " me" : ""}">` +
        `<span class="res-place">${medals[i] || ordinal(r.place)}</span>` +
        `<span class="silk" style="background:${r.silk}"></span>` +
        `<span class="res-name">${esc(r.name)}</span>` +
        (r.bot ? `<span class="rn-tag bot">BOT</span>` : "") +
      `</div>`
    ).join("");
    const winner = order[0];
    const youWon = winner && winner.id === myPid;
    resultEl.innerHTML =
      `<div class="result-card">` +
        `<h2>${youWon ? "🏆 You win!" : "🏁 Results"}</h2>` +
        `<div class="res-list">${rows}</div>` +
        `<div class="row-btns">` +
          (isHost ? `<button class="primary-btn" id="again-btn">Race again 🔄</button>`
                  : `<p class="wait-host" style="display:block">Waiting for the host to race again…</p>`) +
          `<button class="ghost-btn" id="leave-btn">Leave room</button>` +
        `</div>` +
      `</div>`;
    resultEl.hidden = false;
    const again = $("again-btn"); if (again) again.onclick = () => { resultEl.hidden = true; wsSend({ t: "again" }); };
    const leave = $("leave-btn"); if (leave) leave.onclick = () => doLeave();
    if (youWon) confettiBurst();
  }

  function doLeave() {
    wsSend({ t: "leave" });
    showLobby();
  }

  // ===================== overlays / fx =====================
  let cdWatchdog = null;
  function showCountdown(n) {
    cdOverlay.hidden = false;
    cdNum.textContent = n > 0 ? n : "GO";
    cdNum.classList.remove("pop"); void cdNum.offsetWidth; cdNum.classList.add("pop");
    raceStatus.textContent = "Get ready… " + n;
    // failsafe: if "go" never lands, never leave the overlay up
    clearTimeout(cdWatchdog);
    cdWatchdog = setTimeout(() => { cdOverlay.hidden = true; }, (n + 2) * 1000);
  }
  function hideCountdown() { clearTimeout(cdWatchdog); cdOverlay.hidden = true; }
  function flashGo() {
    cdNum.textContent = "GO!";
    cdOverlay.hidden = false;
    cdNum.classList.remove("pop"); void cdNum.offsetWidth; cdNum.classList.add("pop");
    setTimeout(() => { cdOverlay.hidden = true; }, 500);
  }

  function toast(text) {
    const el = document.createElement("div");
    el.className = "toast"; el.textContent = text;
    toastWrap.appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, 2200);
  }

  function confettiBurst() {
    for (let i = 0; i < 40; i++) {
      const c = document.createElement("div");
      c.className = "confetti-bit";
      c.style.left = Math.random() * 100 + "vw";
      c.style.background = SILKS[i % SILKS.length];
      c.style.animationDelay = (Math.random() * 0.4) + "s";
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 2600);
    }
  }
  const SILKS = ["#E85D8B", "#F2A93B", "#4CA62E", "#7C748F", "#3FA7D6", "#C9466F"];

  // ===================== helpers =====================
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  // ===================== events =====================
  modeCreate.onclick = () => showCodePanel("create");
  modeJoin.onclick = () => showCodePanel("join");
  codeBack.onclick = () => { codePanel.hidden = true; menuGrid.hidden = false; };
  codeGo.onclick = doJoin;
  roomCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
  addBotBtn.onclick = () => wsSend({ t: "addBot" });
  startBtn.onclick = () => wsSend({ t: "start" });
  quitBtn.onclick = () => doLeave();

  // tap to run — pointer + keyboard (Space)
  runBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); tap(); });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && racing && !raceOver) { e.preventDefault(); tap(); }
  });

  // restore saved name
  try { const n = localStorage.getItem("pakeiba_name"); if (n) guestName.value = n; } catch (_) {}

  // ===================== boot =====================
  // belt-and-braces: never let a stale overlay survive a page load
  cdOverlay.hidden = true; resultEl.hidden = true;
  showLobby();
  connect();
})();
