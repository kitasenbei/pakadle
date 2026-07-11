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

    let guesses = [];
    let finished = false;
    let busy = false;

    let umas = [];
    let validSet = new Set();
    let suggestions = [];
    let activeIdx = -1;

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

    function lockInput(state) {
        input.disabled = state;
        guessBtn.disabled = state;
    }

    async function loadDaily() {
        const r = await fetch("/tailoftheday/api/daily");

        const d = await r.json();

        guesses = d.guesses.map((g, i) => ({
            text: g,
            correct: d.won && i === d.guesses.length - 1,
        }));
        finished = d.finished;

        subtitleEl.innerHTML = `Tail Of The Day #${d.number}: guess the Umamusume Tail`;

        guessesEl.innerHTML = "";

        guesses.forEach(addGuessRow);

        renderDots();

        setPortrait();

        if (finished) {
            lockInput(true);
        }
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

        const guessName = match ? match.word : text;

        busy = true;
        lockInput(true);

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

            lockInput(true);

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

        howtoEl.style.display = "flex";

        document.getElementById("how-close").onclick = () => {
            howtoEl.innerHTML = "";

            howtoEl.style.display = "none";
        };
    }

    howToBtn.onclick = openHowto;

    statsBtn.onclick = () => toast("Stats coming soon");

    function toast(msg) {
        const t = document.createElement("div");

        t.className = "toast";

        t.textContent = msg;

        toastWrap.appendChild(t);

        setTimeout(() => t.remove(), 2000);
    }

    // boot

    loadNames();

    loadDaily();
})();
