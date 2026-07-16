(function () {
    "use strict";

    const boardImg = document.getElementById("portrait");
    const subtitleEl = document.getElementById("subtitle");
    const dotsEl = document.getElementById("dots");
    const form = document.getElementById("guess-form");
    const input = document.getElementById("guess-input");
    const guessBtn = document.getElementById("guess-btn");
    const guessesEl = document.getElementById("guesses");
    const suggestEl = document.getElementById("suggest");
    const toastWrap = document.getElementById("toast-wrap");
    const modalEl = document.getElementById("modal");
    const howtoEl = document.getElementById("howto");
    const howToBtn = document.getElementById("how-to");
    const statsBtn = document.getElementById("stats-btn");

    const MAX = 6;

    let number = 0;
    let guesses = [];
    let finished = false;
    let busy = false;
    let stats = null;
    let reveal = null;
    let lastWon = null;
    let rolloverTarget = 0;
    let countdownTimer = null;
    let umas = [];
    let validSet = new Set();
    let suggestions = [];
    let activeIdx = -1;
    let testMode = false;

    const norm = (s) =>
        String(s)
            .toLowerCase()
            .replace(/[^a-z]/g, "");

    async function loadNames() {
        try {
            const r = await fetch("/tailoftheday/api/names");

            umas = await r.json();

            umas.forEach((u) => {
                u.n = norm(u.name);
                u.w = norm(u.word);

                validSet.add(u.n);
                validSet.add(u.w);
            });
        } catch {
            umas = [];
        }
    }

    function setPortrait() {
        boardImg.src = `/tailoftheday/api/portrait?t=${Date.now()}`;
    }

    function renderDots() {
        dotsEl.innerHTML = "";

        for (let i = 0; i < MAX; i++) {
            const d = document.createElement("div");

            d.className = "dot";

            if (i < guesses.length) {
                d.classList.add(guesses[i].correct ? "win" : "used");
            }

            dotsEl.appendChild(d);
        }
    }

    function addGuessRow(g) {
        const row = document.createElement("div");

        row.className = "guess-row " + (g.correct ? "right" : "wrong");

        row.innerHTML = `
            <span class="mark">
                ${g.correct ? "✓" : "✗"}
            </span>
            <span>
                ${escapeHtml(g.text)}
            </span>
            `;

        guessesEl.appendChild(row);
    }

    function closeModal() {
        modalEl.classList.remove("open");
        clearInterval(countdownTimer);
    }
    function escapeHtml(s) {
        return String(s).replace(
            /[&<>"]/g,
            (c) =>
                ({
                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                })[c],
        );
    }

    // ===== result / stats modal =====
    function showResult() {
        const s = stats || { played: 0, winRate: 0, streak: 0 };
        const won = lastWon;
        const revealSrc =
            reveal && reveal.image
                ? `${reveal.image}?t=${Date.now()}`
                : `/tailoftheday/api/portrait?t=${Date.now()}`;
        modalEl.innerHTML = `
      <div class="card">
        <button class="card-x" id="card-x" aria-label="Close">×</button>
        <div class="result ${won ? "win" : "lose"}">${won ? "Got it! 🥕" : "So close…"}</div>
        <img class="reveal-img" src="${revealSrc}" alt="${reveal ? escapeHtml(reveal.name) : ""}" />
        <div class="who">${reveal ? escapeHtml(reveal.name) : ""}</div>
        ${reveal && reveal.quote ? `<div class="quote">${escapeHtml(reveal.quote)}</div>` : ""}
        <div class="stats">
          <div class="stat"><span class="num">${s.played}</span><span class="lbl">Played</span></div>
          <div class="stat"><span class="num">${s.winRate}</span><span class="lbl">Win %</span></div>
          <div class="stat"><span class="num">${s.streak}</span><span class="lbl">Streak</span></div>
        </div>
        ${
            testMode
                ? `<button class="cta" id="again-btn">Next random 🎲</button>`
                : `<button class="cta" id="share-btn">Share 🔗</button><div class="countdown" id="countdown">Next Tail Of The Day in …</div>`
        }
      </div>`;
        modalEl.classList.add("open");
        document.getElementById("card-x").addEventListener("click", closeModal);
        if (testMode) {
            document
                .getElementById("again-btn")
                .addEventListener("click", () => location.reload());
        } else {
            document
                .getElementById("share-btn")
                .addEventListener("click", doShare);
            startCountdown();
        }
    }

    function openStats() {
        if (finished) {
            showResult();
            return;
        }
        const s = stats || { played: 0, winRate: 0, streak: 0 };
        modalEl.innerHTML = `
      <div class="card">
        <div class="result win">Stats</div>
        <div class="stats">
          <div class="stat"><span class="num">${s.played}</span><span class="lbl">Played</span></div>
          <div class="stat"><span class="num">${s.winRate}</span><span class="lbl">Win %</span></div>
          <div class="stat"><span class="num">${s.streak}</span><span class="lbl">Streak</span></div>
        </div>
        <button class="cta" id="close-btn">Keep guessing</button>
      </div>`;
        modalEl.classList.add("open");
        document
            .getElementById("close-btn")
            .addEventListener("click", closeModal);
    }

    function shareText() {
        const n = guesses.length;
        const score = lastWon ? n : "X";
        const sq = lastWon ? "⬜".repeat(n - 1) + "🟪" : "⬜".repeat(MAX);
        return `Tail Of The Day #${number}  ${score}/6\n${sq}\nhttps://pakadle.fun/tailoftheday`;
    }

    async function doShare() {
        const text = shareText();
        if (navigator.share) {
            try {
                await navigator.share({ title: "Tail Of The Day", text });
                return;
            } catch (e) {
                if (e && e.name === "AbortError") return;
            }
        }
        try {
            await navigator.clipboard.writeText(text);
            toast("Copied to clipboard!");
        } catch (e) {
            toast("Couldn't copy");
        }
    }

    function startCountdown() {
        const el = document.getElementById("countdown");
        function tick() {
            const ms = rolloverTarget - Date.now();
            if (ms <= 0) {
                location.reload();
                return;
            }
            const h = Math.floor(ms / 3.6e6),
                m = Math.floor((ms % 3.6e6) / 6e4),
                s = Math.floor((ms % 6e4) / 1000);
            const p = (n) => String(n).padStart(2, "0");
            if (el)
                el.textContent = `Next Tail Of The Day in ${p(h)}:${p(m)}:${p(s)}`;
        }
        clearInterval(countdownTimer);
        tick();
        countdownTimer = setInterval(tick, 1000);
    }

    function lockInput(state) {
        input.disabled = state;
        guessBtn.disabled = state;
    }

    async function loadDaily() {
        let d;
        try {
            const r = await fetch("/tailoftheday/api/daily");
            if (!r.ok) throw 0;
            d = await r.json();
        } catch (e) {
            subtitleEl.innerHTML =
                '⚠️ Couldn\'t load today\'s puzzle. Check your connection and <a href="" onclick="location.reload();return false;"><b>try again</b></a>.';
            return;
        }

        number = d.number;
        testMode = !!d.test;
        finished = d.finished;
        lastWon = d.won;
        stats = d.stats;
        reveal = d.reveal || null;
        rolloverTarget = Date.now() + (d.secondsUntilRollover || 0) * 1000;

        guesses = (d.guesses || []).map((g, i, arr) => ({
            text: g,
            correct: d.won && i === arr.length - 1,
        }));

        subtitleEl.innerHTML = testMode
            ? `Tail Of The Day: <b>practice</b> (random uma each reload)`
            : `Tail Of The Day <b>#${number}</b>: guess the Umamusume Tail`;

        guessesEl.innerHTML = "";

        guesses.forEach(addGuessRow);

        renderDots();

        setPortrait();

        if (finished) {
            lockInput(true);
            setTimeout(() => showResult(), 400);
        }

        let seen = false;
        try {
            seen = !!localStorage.getItem("totd_howto_seen");
        } catch (e) {}
        if (!seen && !finished) openHowto();
    }

    async function doGuess(text) {
        if (busy || finished) return;

        text = String(text).trim();

        if (!text) return;

        const match = umas.find(
            (u) => u.n === norm(text) || u.w === norm(text),
        );

        if (umas.length && !match) {
            toast("Pick an Umamusume from the list");
            return;
        }

        const guessName = match ? match.name : text;

        busy = true;
        lockInput(true);
        closeSuggest();

        let d;

        try {
            const r = await fetch("/tailoftheday/api/guess", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    guess: guessName,
                }),
            });

            d = await r.json();
        } catch {
            toast("Connection error");

            busy = false;
            lockInput(false);
            return;
        }

        const g = {
            text: match ? match.name : text,

            correct: !!d.correct,
        };

        guesses.push(g);
        addGuessRow(g);
        renderDots();
        input.value = "";

        if (d.finished) {
            finished = true;
            if (d.won) confettiBurst();
            lockInput(true);
            lastWon = d.won;
            stats = d.stats;
            reveal = d.reveal;
            setTimeout(() => showResult(), d.won ? 650 : 350);
            if (d.won) {
                toast("Correct! 🐎");
            } else {
                toast("Out of guesses");
            }
        } else {
            lockInput(false);

            input.focus();
        }

        busy = false;
    }

    form.addEventListener("submit", (e) => {
        e.preventDefault();

        doGuess(input.value);
    });

    // ===== petals (ambient) =====
    const PETAL_COLORS = [
        "var(--sakura)",
        "var(--gold)",
        "var(--turf)",
        "#F6C6D8",
    ];
    function spawnPetals(n) {
        const layer = document.getElementById("petals");
        if (!layer) return;
        for (let i = 0; i < n; i++) {
            const p = document.createElement("div");
            p.className = "petal";
            const inner = document.createElement("i");
            const size = 8 + Math.random() * 10;
            inner.style.width = inner.style.height = size + "px";
            inner.style.background = PETAL_COLORS[i % PETAL_COLORS.length];
            inner.style.opacity = 0.18 + Math.random() * 0.22;
            inner.style.animationDuration = 2 + Math.random() * 2.5 + "s";
            p.appendChild(inner);
            p.style.left = Math.random() * 100 + "vw";
            p.style.animationDuration = 9 + Math.random() * 8 + "s";
            p.style.animationDelay = -Math.random() * 16 + "s";
            layer.appendChild(p);
        }
    }

    // ===== confetti (win) =====
    const CONF = [
        "#E85D8B",
        "#F2A93B",
        "#4CA62E",
        "#F6C6D8",
        "#7C748F",
        "#F4D03F",
        "#5BB8E8",
    ];
    function confettiBurst() {
        if (
            window.matchMedia &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
        )
            return;
        ["left", "right"].forEach((side) => {
            const layer = document.getElementById("confetti");
            const W = innerWidth,
                H = innerHeight,
                dir = side === "left" ? 1 : -1;
            for (let i = 0; i < 45; i++) {
                const el = document.createElement("div");
                el.className = "confetti";
                el.style.width = 6 + Math.random() * 6 + "px";
                el.style.height = 9 + Math.random() * 9 + "px";
                el.style.background = CONF[(Math.random() * CONF.length) | 0];
                if (Math.random() < 0.4) el.style.borderRadius = "50%";
                el.style.bottom = 30 + Math.random() * 30 + "px";
                el.style[side] = "0px";
                layer.appendChild(el);
                const ax = dir * (W * 0.12 + Math.random() * W * 0.5),
                    ay = -(H * 0.25 + Math.random() * H * 0.4);
                const ex = ax + dir * (30 + Math.random() * 160),
                    ey = H * 0.15 + Math.random() * H * 0.5;
                const spin =
                    (360 + Math.random() * 720) *
                    (Math.random() < 0.5 ? 1 : -1);
                const anim = el.animate(
                    [
                        {
                            transform: "translate(0,0) rotate(0)",
                            opacity: 1,
                            offset: 0,
                            easing: "cubic-bezier(.15,.6,.4,1)",
                        },
                        {
                            transform: `translate(${ax}px,${ay}px) rotate(${spin * 0.5}deg)`,
                            opacity: 1,
                            offset: 0.45,
                            easing: "cubic-bezier(.45,0,.7,.5)",
                        },
                        {
                            transform: `translate(${ex}px,${ey}px) rotate(${spin}deg)`,
                            opacity: 0,
                            offset: 1,
                        },
                    ],
                    { duration: 1400 + Math.random() * 900, fill: "forwards" },
                );
                anim.onfinish = () => el.remove();
            }
        });
    }

    // -----------------
    // autocomplete
    // -----------------

    function highlightName(name, raw) {
        if (!raw) return escapeHtml(name);

        const i = name.toLowerCase().indexOf(raw.toLowerCase());

        if (i < 0) return escapeHtml(name);

        return (
            escapeHtml(name.slice(0, i)) +
            "<span class='hl'>" +
            escapeHtml(name.slice(i, i + raw.length)) +
            "</span>" +
            escapeHtml(name.slice(i + raw.length))
        );
    }

    function renderSuggest() {
        const raw = input.value.trim();

        const q = norm(raw);

        suggestions = q
            ? umas.filter((u) => u.n.includes(q) || u.w.includes(q)).slice(0, 8)
            : [];

        activeIdx = -1;

        if (!q) {
            closeSuggest();
            return;
        }

        suggestEl.innerHTML = suggestions
            .map(
                (u, i) =>
                    `
                        <li data-i="${i}">
                            ${highlightName(u.name, raw)}
                        </li>
                        `,
            )
            .join("");

        suggestEl.classList.add("open");
    }

    function closeSuggest() {
        suggestEl.classList.remove("open");

        suggestEl.innerHTML = "";

        suggestions = [];

        activeIdx = -1;
    }
    function highlight() {
        [...suggestEl.children].forEach((li, i) => {
            li.classList.toggle("active", i === activeIdx);
        });

        const el = suggestEl.children[activeIdx];

        if (el) {
            el.scrollIntoView({
                block: "nearest",
            });
        }
    }
    input.addEventListener("input", renderSuggest);
    input.addEventListener("keydown", (e) => {
        if (!suggestions.length) return;

        if (e.key === "ArrowDown") {
            e.preventDefault();

            activeIdx = Math.min(activeIdx + 1, suggestions.length - 1);

            highlight();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();

            activeIdx = Math.max(activeIdx - 1, 0);

            highlight();
        } else if (e.key === "Enter" && activeIdx >= 0) {
            e.preventDefault();

            input.value = suggestions[activeIdx].name;

            closeSuggest();
        } else if (e.key === "Escape") {
            closeSuggest();
        }
    });
    suggestEl.addEventListener("mousedown", (e) => {
        const li = e.target.closest("li");

        if (!li) return;

        e.preventDefault();

        const u = suggestions[Number(li.dataset.i)];

        if (u) {
            input.value = u.name;

            closeSuggest();

            doGuess(u.name);
        }
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".input-wrap")) {
            closeSuggest();
        }
    });

    // -----------------
    // how to
    // -----------------

    function openHowto() {
        howtoEl.innerHTML = `
        <div class="card">
            <div class="result win">
                How to Play
            </div>

            <p>
                Guess the Umamusume from her tail.
            </p>

            <p>
                You have 6 guesses.
            </p>

            <button
                class="cta"
                id="how-close"
            >
                Let's go 🐎
            </button>
        </div>
        `;

        howtoEl.style.cssText =
            "position:fixed;inset:0;background:rgba(58,46,57,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50";

        document.getElementById("how-close").onclick = () => {
            howtoEl.innerHTML = "";

            howtoEl.style.display = "none";

            try {
                localStorage.setItem("totd_howto_seen", "1");
            } catch (e) {}
        };
    }

    howToBtn.onclick = openHowto;

    statsBtn.onclick = openStats;

    modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl) closeModal();
    });

    function toast(msg) {
        const t = document.createElement("div");

        t.className = "toast";

        t.textContent = msg;

        toastWrap.appendChild(t);

        setTimeout(() => t.remove(), 2000);
    }

    // boot

    spawnPetals(16);

    loadNames();

    loadDaily();
})();
