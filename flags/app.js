// /flags: search a country, get its flag as copy-pasteable text.
"use strict";

(function () {
    const { render } = window.FlagRender;
    const FLAGS = window.FLAGS;

    // Colour code -> output character. Light blue has no emoji square of its
    // own, so it borrows the blue one.
    const EMOJI = {
        R: "🟥", W: "⬜", B: "🟦", C: "🟦", G: "🟩",
        Y: "🟨", K: "⬛", O: "🟧", P: "🟪", N: "🟫",
    };
    const ASCII = {
        R: "#", W: ".", B: "%", C: "-", G: "&",
        Y: "*", K: "@", O: "+", P: "$", N: "o",
    };
    const NAMES = {
        R: "red", W: "white", B: "blue", C: "light blue", G: "green",
        Y: "yellow", K: "black", O: "orange", P: "purple", N: "brown",
    };

    // Emoji squares are roughly square, terminal characters are about half as
    // wide as they are tall, so each mode needs its own grid to land on 3:2.
    const SIZES = {
        S: { emoji: [12, 8], ascii: [30, 10] },
        M: { emoji: [18, 12], ascii: [45, 15] },
        L: { emoji: [27, 18], ascii: [66, 22] },
    };

    let size = "M";
    let selected = null;

    const $ = (id) => document.getElementById(id);
    const q = $("q");
    const list = $("list");
    const detail = $("detail");

    // Regional indicator pair, e.g. JP -> 🇯🇵.
    function emojiFlag(code) {
        if (code === "XK") return "🏳️";
        return String.fromCodePoint(
            ...code.split("").map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65),
        );
    }

    // A 13-stripe flag rasterised onto 12 rows comes out as mush, so nudge the
    // grid to a multiple of the flag's own band count where that is cheap. Only
    // the base layer counts, and only if it is not so finely striped that the
    // whole thing would have to grow.
    function bandCount(flag, type) {
        const l = flag.f[0];
        if (!l || l.t !== type) return 0;
        const w = l.w || l.c.map(() => 1);
        const sum = w.reduce((a, b) => a + b, 0);
        return sum <= 14 ? sum : 0;
    }

    function dims(flag, mode) {
        const [w0, h0] = SIZES[size][mode];
        const rh = bandCount(flag, "h");
        const h = rh ? Math.max(rh, Math.round(h0 / rh) * rh) : h0;
        let w = rh ? Math.round(h * (mode === "emoji" ? 1.5 : 3)) : w0;
        const rv = bandCount(flag, "v");
        if (rv) w = Math.max(rv, Math.round(w / rv) * rv);
        return [w, h];
    }

    function grid(flag, mode) {
        const [w, h] = dims(flag, mode);
        const map = mode === "emoji" ? EMOJI : ASCII;
        return render(flag.f, w, h)
            .map((row) => row.split("").map((c) => map[c]).join(""))
            .join("\n");
    }

    function legend(flag, mode) {
        const used = new Set();
        for (const row of render(flag.f, 24, 16)) for (const c of row) used.add(c);
        const map = mode === "emoji" ? EMOJI : ASCII;
        return [...used].map((c) => `${map[c]} ${NAMES[c]}`).join("   ");
    }

    // ---- search ------------------------------------------------------------
    function norm(s) {
        return s
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9 ]/g, "");
    }

    const INDEX = FLAGS.map((f) => ({
        f,
        keys: [norm(f.n), f.c.toLowerCase(), ...(f.alt || []).map(norm)],
    }));

    function search(term) {
        const t = norm(term).trim();
        if (!t) return FLAGS;
        const starts = [];
        const contains = [];
        for (const e of INDEX) {
            if (e.keys.some((k) => k.startsWith(t))) starts.push(e.f);
            else if (e.keys.some((k) => k.includes(t))) contains.push(e.f);
        }
        return starts.concat(contains);
    }

    function renderList() {
        const hits = search(q.value);
        list.innerHTML = "";
        if (!hits.length) {
            list.innerHTML = '<li class="empty">No country matches that.</li>';
            return;
        }
        for (const f of hits) {
            const li = document.createElement("li");
            li.innerHTML =
                `<button type="button" data-code="${f.c}">` +
                `<span class="fe">${emojiFlag(f.c)}</span>` +
                `<span class="fn">${f.n}</span>` +
                `<span class="fc">${f.c}</span></button>`;
            list.appendChild(li);
        }
    }

    // ---- detail ------------------------------------------------------------
    function block(label, hint, text, pre) {
        const wrap = document.createElement("section");
        wrap.className = "block";
        const head = document.createElement("div");
        head.className = "block-head";
        head.innerHTML = `<h3>${label}</h3><span class="hint">${hint}</span>`;
        const btn = document.createElement("button");
        btn.className = "copy";
        btn.textContent = "Copy";
        btn.addEventListener("click", () => copy(text, btn));
        head.appendChild(btn);
        const body = document.createElement(pre ? "pre" : "div");
        body.className = pre ? `art ${pre}` : "one-line";
        body.textContent = text;
        wrap.append(head, body);
        return wrap;
    }

    async function copy(text, btn) {
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try {
                ok = document.execCommand("copy");
            } catch {}
            ta.remove();
        }
        btn.textContent = ok ? "Copied!" : "Copy failed";
        btn.classList.toggle("ok", ok);
        setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("ok");
        }, 1400);
    }

    function renderDetail() {
        detail.innerHTML = "";
        if (!selected) {
            detail.innerHTML =
                '<p class="placeholder">Pick a country to get its flag as text.</p>';
            return;
        }
        const f = selected;

        const head = document.createElement("div");
        head.className = "detail-head";
        head.innerHTML =
            `<span class="big">${emojiFlag(f.c)}</span>` +
            `<h2>${f.n}</h2><span class="fc">${f.c}</span>`;
        detail.appendChild(head);

        const sizes = document.createElement("div");
        sizes.className = "sizes";
        sizes.innerHTML = ["S", "M", "L"]
            .map(
                (s) =>
                    `<button type="button" data-size="${s}"${
                        s === size ? ' class="on"' : ""
                    }>${s}</button>`,
            )
            .join("");
        detail.appendChild(sizes);

        detail.appendChild(
            block("Emoji flag", "one character, works in most chat apps", emojiFlag(f.c), false),
        );
        detail.appendChild(
            block("Emoji squares", "keeps its colours anywhere emoji render", grid(f, "emoji"), "emoji"),
        );
        const asciiArt = grid(f, "ascii");
        detail.appendChild(
            block("ASCII", legend(f, "ascii"), asciiArt, "mono"),
        );
    }

    // ---- wiring ------------------------------------------------------------
    q.addEventListener("input", renderList);

    list.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-code]");
        if (!btn) return;
        selected = FLAGS.find((f) => f.c === btn.dataset.code);
        renderDetail();
        detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    detail.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-size]");
        if (!btn) return;
        size = btn.dataset.size;
        renderDetail();
    });

    q.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const first = list.querySelector("button[data-code]");
        if (first) first.click();
    });

    renderList();
    renderDetail();
})();
