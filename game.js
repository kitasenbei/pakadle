// Pakadle — daily Umamusume word game. Talks to the SQLite backend (server.js):
//   GET  /api/daily   → today's puzzle + your saved progress + stats
//   POST /api/result  → persist today's outcome (once per day)
(function () {
  "use strict";

  const ROWS = 6;
  const FLIP_STAGGER = 250; // ms between each tile starting its flip
  const FLIP_HALF = 250;    // ms to mid-flip, when the color is swapped in
  const FLIP_DUR = 500;     // total flip duration (matches CSS)

  // priority so a key keeps its best-known state
  const RANK = { absent: 1, present: 2, correct: 3 };

  // ----- DOM refs -----
  const boardEl = document.getElementById("board");
  const keyboardEl = document.getElementById("keyboard");
  const subtitleEl = document.getElementById("subtitle");
  const toastWrap = document.getElementById("toast-wrap");
  const modalEl = document.getElementById("modal");
  const statsBtn = document.getElementById("new-game");
  const howtoEl = document.getElementById("howto");
  const howToBtn = document.getElementById("how-to");

  const KEY_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "↵ZXCVBNM⌫"];

  // ----- state -----
  const keyEls = {}; // letter -> button element

  let answer = "";
  let answerEntry = null;   // { word, name, quote, img }
  let wordLen = 0;
  let currentRow = 0;
  let guess = "";
  let submitted = [];       // the words guessed so far (persisted to the server)
  let isRevealing = false;
  let gameOver = false;
  let lastWon = false;
  let serverStats = null;
  let countdownTimer = null;

  // ===== build the on-screen keyboard once =====
  function buildKeyboard() {
    KEY_ROWS.forEach((rowStr) => {
      const rowEl = document.createElement("div");
      rowEl.className = "krow";
      for (const ch of rowStr) {
        const btn = document.createElement("button");
        btn.className = "key";
        if (ch === "↵") {
          btn.textContent = "Enter";
          btn.classList.add("wide");
          btn.addEventListener("click", submitGuess);
        } else if (ch === "⌫") {
          btn.textContent = "⌫";
          btn.classList.add("wide");
          btn.addEventListener("click", delLetter);
        } else {
          btn.textContent = ch;
          keyEls[ch] = btn;
          btn.addEventListener("click", () => addLetter(ch));
        }
        rowEl.appendChild(btn);
      }
      keyboardEl.appendChild(rowEl);
    });
  }

  // ===== load today's puzzle from the backend =====
  async function loadDaily() {
    let data;
    try {
      const res = await fetch("/api/daily");
      if (!res.ok) throw new Error("bad response");
      data = await res.json();
    } catch (e) {
      boardEl.innerHTML = "";
      subtitleEl.innerHTML =
        '⚠️ Backend not reachable — run <b>node server.js</b> and open <b>http://localhost:3000</b>';
      return;
    }

    answerEntry = { word: data.word, name: data.name, quote: data.quote, img: data.img };
    answer = data.word.toUpperCase();
    wordLen = data.length;
    currentRow = 0;
    guess = "";
    submitted = [];
    isRevealing = false;
    gameOver = false;
    serverStats = data.stats || null;

    new Image().src = answerEntry.img; // warm the portrait cache
    subtitleEl.innerHTML = `Pakadle <b>#${data.number}</b> — guess the <b>${wordLen}</b>-letter Umamusume`;
    buildBoard();
    resetKeyboard();
    closeModal();

    if (data.result) {
      // already played today → restore the finished board and lock input
      restoreFinished(data.result.grid);
      gameOver = true;
      lastWon = data.result.won;
      setTimeout(() => showModal({ reveal: true, won: lastWon, finished: true }), 350);
    }

    // first-ever visit → show the onboarding (on top of everything)
    let seen = false;
    try { seen = !!localStorage.getItem("pakadle_howto_seen"); } catch (e) {}
    if (!seen) openHowto();
  }

  function buildBoard() {
    boardEl.innerHTML = "";
    boardEl.style.maxWidth = wordLen * 64 + "px";
    for (let r = 0; r < ROWS; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "row";
      rowEl.style.setProperty("--cols", wordLen);
      for (let c = 0; c < wordLen; c++) {
        const tile = document.createElement("div");
        tile.className = "tile enter";
        tile.style.animationDelay = (r * wordLen + c) * 0.022 + "s";
        rowEl.appendChild(tile);
      }
      boardEl.appendChild(rowEl);
    }
    // drop the entrance class once it has played so it can't clash with pop/flip
    setTimeout(() => {
      boardEl.querySelectorAll(".tile.enter").forEach((t) => {
        t.classList.remove("enter");
        t.style.animationDelay = "";
      });
    }, 1400);
  }

  // paint a previously-played board instantly (no animation)
  function restoreFinished(grid) {
    grid.forEach((word, r) => {
      const up = String(word).toUpperCase();
      const states = evaluate(up);
      const tiles = boardEl.children[r].children;
      for (let i = 0; i < wordLen; i++) {
        tiles[i].textContent = up[i];
        tiles[i].classList.remove("enter");
        tiles[i].classList.add("filled", states[i]);
      }
      updateKeyboard(up, states);
    });
    currentRow = grid.length;
    submitted = grid.map(String);
  }

  function resetKeyboard() {
    for (const k in keyEls) {
      const el = keyEls[k];
      el.classList.remove("correct", "present", "absent");
      delete el.dataset.state;
    }
  }

  // ===== typing =====
  function addLetter(ch) {
    if (isRevealing || gameOver || guess.length >= wordLen) return;
    const tile = boardEl.children[currentRow].children[guess.length];
    tile.textContent = ch;
    tile.classList.add("filled", "pop");
    setTimeout(() => tile.classList.remove("pop"), 120);
    guess += ch;
  }

  function delLetter() {
    if (isRevealing || gameOver || guess.length === 0) return;
    guess = guess.slice(0, -1);
    const tile = boardEl.children[currentRow].children[guess.length];
    tile.textContent = "";
    tile.classList.remove("filled");
  }

  // ===== evaluation (two-pass, handles duplicate letters) =====
  function evaluate(g) {
    const states = new Array(wordLen).fill("absent");
    const counts = {};
    for (const ch of answer) counts[ch] = (counts[ch] || 0) + 1;

    for (let i = 0; i < wordLen; i++) {
      if (g[i] === answer[i]) {
        states[i] = "correct";
        counts[g[i]]--;
      }
    }
    for (let i = 0; i < wordLen; i++) {
      if (states[i] === "correct") continue;
      const ch = g[i];
      if (counts[ch] > 0) {
        states[i] = "present";
        counts[ch]--;
      }
    }
    return states;
  }

  // ===== submit a guess =====
  function submitGuess() {
    if (isRevealing || gameOver) return;
    if (guess.length < wordLen) {
      shakeRow();
      toast("Not enough letters");
      return;
    }

    const states = evaluate(guess);
    const rowEl = boardEl.children[currentRow];
    const tiles = rowEl.children;
    isRevealing = true;

    for (let i = 0; i < wordLen; i++) {
      setTimeout(() => {
        tiles[i].classList.add("flip");
        setTimeout(() => tiles[i].classList.add(states[i]), FLIP_HALF);
      }, i * FLIP_STAGGER);
    }

    const total = (wordLen - 1) * FLIP_STAGGER + FLIP_DUR;
    const finishedGuess = guess;
    setTimeout(() => {
      updateKeyboard(finishedGuess, states);
      isRevealing = false;
      submitted.push(finishedGuess);
      const won = finishedGuess === answer;
      if (won) {
        winBounce(rowEl);
        finishRound(true);
      } else {
        currentRow++;
        guess = "";
        if (currentRow >= ROWS) finishRound(false);
      }
    }, total);
  }

  function updateKeyboard(g, states) {
    for (let i = 0; i < wordLen; i++) {
      const el = keyEls[g[i]];
      if (!el) continue;
      const cur = el.dataset.state;
      if (!cur || RANK[states[i]] > RANK[cur]) {
        el.dataset.state = states[i];
        el.classList.remove("correct", "present", "absent");
        el.classList.add(states[i]);
      }
    }
  }

  function shakeRow() {
    const rowEl = boardEl.children[currentRow];
    rowEl.classList.add("shake");
    rowEl.addEventListener("animationend", () => rowEl.classList.remove("shake"), { once: true });
  }

  function winBounce(rowEl) {
    const tiles = rowEl.children;
    for (let i = 0; i < tiles.length; i++) {
      setTimeout(() => {
        tiles[i].classList.add("bounce");
        tiles[i].addEventListener("animationend", () => tiles[i].classList.remove("bounce"), { once: true });
      }, i * 90);
    }
    confettiBurst();
  }

  // ===== petals =====
  const PETAL_COLORS = ["var(--sakura)", "var(--gold)", "var(--turf)", "#F6C6D8"];

  function makePetal({ size, left, color, fall, sway, delay, opacity, fixed }) {
    const p = document.createElement("div");
    p.className = "petal";
    const inner = document.createElement("i");
    inner.style.width = inner.style.height = size + "px";
    inner.style.background = color;
    inner.style.opacity = opacity;
    inner.style.animationDuration = sway + "s";
    p.appendChild(inner);
    p.style.left = left + "vw";
    p.style.animationDuration = fall + "s";
    p.style.animationDelay = delay + "s";
    if (fixed) p.classList.add("fixed");
    return p;
  }

  // gentle, infinite background drift
  function spawnAmbientPetals(n) {
    const layer = document.getElementById("petals");
    for (let i = 0; i < n; i++) {
      layer.appendChild(
        makePetal({
          size: 8 + Math.random() * 10,
          left: Math.random() * 100,
          color: PETAL_COLORS[i % PETAL_COLORS.length],
          fall: 9 + Math.random() * 8,
          sway: 2 + Math.random() * 2.5,
          delay: -Math.random() * 16,
          opacity: 0.18 + Math.random() * 0.22,
          fixed: true,
        })
      );
    }
  }

  // ===== confetti cannons (win) =====
  const CONFETTI_COLORS = ["#E85D8B", "#F2A93B", "#4CA62E", "#F6C6D8", "#7C748F", "#F4D03F", "#5BB8E8"];

  function confettiBurst() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    confettiCannon("left");
    confettiCannon("right");
  }

  // shoots a spray of confetti up-and-inward from one bottom corner
  function confettiCannon(side) {
    const layer = document.getElementById("confetti");
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dir = side === "left" ? 1 : -1;

    for (let i = 0; i < 50; i++) {
      const el = document.createElement("div");
      el.className = "confetti";
      const w = 6 + Math.random() * 6;
      const h = 9 + Math.random() * 9;
      el.style.width = w + "px";
      el.style.height = h + "px";
      el.style.background = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
      if (Math.random() < 0.4) el.style.borderRadius = "50%";
      el.style.bottom = 30 + Math.random() * 30 + "px";
      el.style[side] = "0px";
      layer.appendChild(el);

      // parabolic arc: launch out to an apex, then fall past the bottom while fading
      const apexX = dir * (W * 0.12 + Math.random() * W * 0.5);
      const apexY = -(H * 0.25 + Math.random() * H * 0.4);
      const endX = apexX + dir * (30 + Math.random() * 160);
      const endY = H * 0.15 + Math.random() * H * 0.5;
      const spin = (360 + Math.random() * 720) * (Math.random() < 0.5 ? 1 : -1);
      const dur = 1400 + Math.random() * 900;

      const anim = el.animate(
        [
          { transform: "translate(0,0) rotate(0deg)", opacity: 1, offset: 0, easing: "cubic-bezier(.15,.6,.4,1)" },
          { transform: `translate(${apexX}px, ${apexY}px) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.45, easing: "cubic-bezier(.45,0,.7,.5)" },
          { transform: `translate(${endX}px, ${endY}px) rotate(${spin}deg)`, opacity: 0, offset: 1 },
        ],
        { duration: dur, fill: "forwards" }
      );
      anim.onfinish = () => el.remove();
    }
  }

  // ===== end of round: persist to the backend, then reveal =====
  async function finishRound(won) {
    gameOver = true;
    lastWon = won;
    try {
      const res = await fetch("/api/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ won, grid: submitted }),
      });
      if (res.ok) serverStats = await res.json();
    } catch (e) {
      /* offline — fall back to whatever stats we already have */
    }
    const delay = won ? 700 : 400;
    setTimeout(() => showModal({ reveal: true, won, finished: true }), delay);
  }

  // ===== toast =====
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    toastWrap.appendChild(t);
    setTimeout(() => t.remove(), 2000);
  }

  // ===== modal =====
  // opts: { reveal: show the answer/character, won, finished: show countdown }
  function showModal(opts) {
    const { reveal, won, finished } = opts;
    const s = serverStats || { played: 0, winRate: 0, streak: 0, maxStreak: 0 };
    const cardClass = reveal ? (won ? "win" : "lose") : "lose";
    const badgeText = reveal ? (won ? "WIN! 🥕" : "NEXT TIME") : "STATS";

    const hero = reveal
      ? `<div class="hero">
           <div class="char">
             <img class="portrait" src="${answerEntry.img}" alt="${answerEntry.name}"
                  onerror="this.style.display='none'; this.closest('.char').classList.add('noimg');" />
           </div>
           <div class="info">
             <div class="answer">${answer}</div>
             <div class="full">${answerEntry.name}</div>
             <div class="quote">${answerEntry.quote}</div>
           </div>
         </div>`
      : `<div class="info" style="text-align:center;padding:14px 0 6px;">
           <div class="answer" style="color:var(--ink)">Keep guessing!</div>
         </div>`;

    const footer = finished
      ? `<div class="countdown" id="countdown">Next Pakadle in …</div>`
      : `<button id="modal-close">Got it</button>`;

    modalEl.innerHTML = `
      <div class="card ${cardClass}">
        <div class="badge ${cardClass}">${badgeText}</div>
        ${hero}
        <div class="stats">
          <div class="stat"><span class="num">${s.played}</span><span class="lbl">Played</span></div>
          <div class="stat"><span class="num">${s.winRate}</span><span class="lbl">Win %</span></div>
          <div class="stat"><span class="num">${s.streak}</span><span class="lbl">Streak</span></div>
          <div class="stat"><span class="num">${s.maxStreak}</span><span class="lbl">Best</span></div>
        </div>
        ${footer}
        <div class="shine" aria-hidden="true"></div>
      </div>`;
    modalEl.classList.add("open");

    if (finished) startCountdown();
    else document.getElementById("modal-close").addEventListener("click", closeModal);
  }

  function startCountdown() {
    const el = document.getElementById("countdown");
    function tick() {
      const now = new Date();
      const next = new Date(now);
      next.setHours(24, 0, 0, 0); // next local midnight
      const ms = next - now;
      if (ms <= 0) {
        location.reload();
        return;
      }
      const h = Math.floor(ms / 3.6e6);
      const m = Math.floor((ms % 3.6e6) / 6e4);
      const sec = Math.floor((ms % 6e4) / 1000);
      const pad = (n) => String(n).padStart(2, "0");
      if (el) el.textContent = `Next Pakadle in ${pad(h)}:${pad(m)}:${pad(sec)}`;
    }
    clearInterval(countdownTimer);
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function closeModal() {
    modalEl.classList.remove("open");
    clearInterval(countdownTimer);
  }

  function openStats() {
    showModal({ reveal: gameOver, won: lastWon, finished: gameOver });
  }

  // ===== how-to-play onboarding (multi-step) =====
  const HOWTO_STEPS = [
    // 1 — welcome
    `<h2>How to Play</h2>
     <p>Guess the daily <b>Umamusume</b> in <b>6 tries</b>.</p>
     <div class="ex-row">
       <div class="ex-tile">U</div><div class="ex-tile">M</div><div class="ex-tile">A</div>
     </div>
     <p class="sub">Type letters, then press <b>Enter</b> to submit. Each guess has to fill the whole row.</p>`,

    // 2 — colors (uses the real board palette)
    `<h2>Read the colors</h2>
     <p>After each guess, every tile changes color:</p>
     <div class="ex-row">
       <div class="ex-tile correct">V</div><div class="ex-tile">O</div><div class="ex-tile">D</div><div class="ex-tile">K</div><div class="ex-tile">A</div>
     </div>
     <p class="cap"><b class="pink">V</b> is in the word and in the right spot.</p>
     <div class="ex-row">
       <div class="ex-tile">O</div><div class="ex-tile present">G</div><div class="ex-tile">U</div><div class="ex-tile">R</div><div class="ex-tile">I</div>
     </div>
     <p class="cap"><b class="gold">G</b> is in the word, but in the wrong spot.</p>
     <div class="ex-row">
       <div class="ex-tile">H</div><div class="ex-tile">A</div><div class="ex-tile">L</div><div class="ex-tile absent">O</div>
     </div>
     <p class="cap"><b class="slate">O</b> is not in the word.</p>`,

    // 3 — the twist: answers are words taken from a character's full name
    `<h2>Answers hide in names</h2>
     <p>The catch: the answer is a <b>word taken from a character's full name</b> — not always a name on its own.</p>
     <div class="namecard"><span class="hl">Special</span> <span class="dim">Week</span></div>
     <div class="ex-row">
       <div class="ex-tile correct">S</div><div class="ex-tile correct">P</div><div class="ex-tile correct">E</div><div class="ex-tile correct">C</div><div class="ex-tile correct">I</div><div class="ex-tile correct">A</div><div class="ex-tile correct">L</div>
     </div>
     <p class="cap">A 7-letter answer might be <b>SPECIAL</b> — from <b>Special Week</b>. There's no uma simply named "Special"!</p>
     <p class="sub">Same goes for <b>GOLD</b> (Gold Ship), <b>SUZUKA</b> (Silence Suzuka)… any word inside an uma's name counts.</p>`,

    // 4 — daily
    `<h2>One puzzle a day</h2>
     <p>A brand-new Umamusume every day, and <b>everyone gets the same one</b>.</p>
     <p>Win in fewer guesses to grow your <b>streak</b>. Tap <b>Stats</b> anytime to see how you're doing.</p>
     <p class="sub">🥕 Come back after midnight for the next Pakadle!</p>`,
  ];
  let howtoStep = 0;

  function openHowto() {
    howtoStep = 0;
    renderHowto();
    howtoEl.classList.add("open");
  }
  function closeHowto() {
    howtoEl.classList.remove("open");
    try { localStorage.setItem("pakadle_howto_seen", "1"); } catch (e) {}
  }
  function renderHowto() {
    const last = howtoStep === HOWTO_STEPS.length - 1;
    const dots = HOWTO_STEPS.map((_, i) => `<span class="dot${i === howtoStep ? " on" : ""}"></span>`).join("");
    howtoEl.innerHTML = `
      <div class="howto-card">
        <button class="howto-x" id="howto-x" aria-label="Close">×</button>
        <div class="howto-body">${HOWTO_STEPS[howtoStep]}</div>
        <div class="howto-nav">
          <button class="howto-back" id="howto-back"${howtoStep === 0 ? " disabled" : ""}>Back</button>
          <div class="dots">${dots}</div>
          <button class="howto-next" id="howto-next">${last ? "Play! 🥕" : "Next"}</button>
        </div>
      </div>`;
    document.getElementById("howto-x").addEventListener("click", closeHowto);
    document.getElementById("howto-back").addEventListener("click", () => {
      if (howtoStep > 0) { howtoStep--; renderHowto(); }
    });
    document.getElementById("howto-next").addEventListener("click", () => {
      if (last) closeHowto();
      else { howtoStep++; renderHowto(); }
    });
  }

  // ===== physical keyboard =====
  document.addEventListener("keydown", (e) => {
    if (howtoEl.classList.contains("open")) {
      if (e.key === "Escape") closeHowto();
      else if (e.key === "Enter") document.getElementById("howto-next").click();
      return;
    }
    if (modalEl.classList.contains("open")) {
      if (e.key === "Enter" || e.key === "Escape") closeModal();
      return;
    }
    if (e.key === "Enter") submitGuess();
    else if (e.key === "Backspace") delLetter();
    else if (/^[a-zA-Z]$/.test(e.key)) addLetter(e.key.toUpperCase());
  });

  statsBtn.addEventListener("click", openStats);
  howToBtn.addEventListener("click", openHowto);
  howtoEl.addEventListener("click", (e) => {
    if (e.target === howtoEl) closeHowto();
  });

  // ===== boot =====
  buildKeyboard();
  spawnAmbientPetals(16);
  loadDaily();
})();
