// Uma Roulette: press SPIN, the wheel lands on a random Umamusume. Pure fun,
// no daily lock or persistence. The wheel shows 12 sampled umas each spin but
// the winner is chosen uniformly from the whole roster.
(function () {
    "use strict";

    const canvas = document.getElementById("wheel");
    const ctx = canvas.getContext("2d");
    const spinBtn = document.getElementById("spin-btn");
    const againBtn = document.getElementById("again-btn");
    const resultEl = document.getElementById("result");
    const subtitleEl = document.getElementById("subtitle");
    const howtoEl = document.getElementById("howto");
    const howToBtn = document.getElementById("how-to");

    const SEGMENTS = 12;
    const TWO_PI = Math.PI * 2;
    const SEG = TWO_PI / SEGMENTS;
    const SLICE_COLORS = [
        "#E85D8B",
        "#F2A93B",
        "#4CA62E",
        "#7C748F",
        "#5BB8E8",
        "#F4D03F",
    ];

    let roster = [];
    let segUmas = []; // the 12 umas currently drawn on the wheel
    let rot = 0; // current wheel rotation in radians
    let spinning = false;

    const norm = (s) => String(s).replace(/[&<>"]/g, "");

    async function loadRoster() {
        try {
            const r = await fetch("/umaroulette/api/names");
            if (!r.ok) throw 0;
            roster = await r.json();
        } catch (e) {
            roster = [];
        }
        if (!roster.length) {
            subtitleEl.textContent =
                "⚠️ Couldn't load the roster. Refresh to try again.";
            spinBtn.disabled = true;
            return;
        }
        segUmas = sample(SEGMENTS);
        drawWheel();
    }

    // pick n distinct random umas from the roster
    function sample(n) {
        const pool = roster.slice();
        const out = [];
        for (let i = 0; i < n && pool.length; i++) {
            const j = Math.floor(Math.random() * pool.length);
            out.push(pool.splice(j, 1)[0]);
        }
        return out;
    }

    function drawWheel() {
        const size = canvas.width;
        const cx = size / 2;
        const cy = size / 2;
        const R = size / 2;
        ctx.clearRect(0, 0, size, size);

        for (let i = 0; i < SEGMENTS; i++) {
            const a0 = i * SEG;
            const a1 = a0 + SEG;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, R, a0, a1);
            ctx.closePath();
            ctx.fillStyle = SLICE_COLORS[i % SLICE_COLORS.length];
            ctx.fill();

            // label
            const uma = segUmas[i];
            if (!uma) continue;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(a0 + SEG / 2);
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#fff";
            ctx.font = "700 22px 'Baloo 2', system-ui, sans-serif";
            ctx.shadowColor = "rgba(0,0,0,.25)";
            ctx.shadowBlur = 3;
            ctx.fillText(fit(uma.name), R - 22, 0);
            ctx.restore();
        }

        // hub ring
        ctx.beginPath();
        ctx.arc(cx, cy, 52, 0, TWO_PI);
        ctx.fillStyle = "rgba(255,255,255,.9)";
        ctx.fill();
    }

    // trim long names so they fit inside a slice
    function fit(name) {
        return name.length > 16 ? name.slice(0, 15) + "…" : name;
    }

    function spin() {
        if (spinning || !roster.length) return;
        spinning = true;
        spinBtn.disabled = true;
        againBtn.hidden = true;
        resultEl.className = "";
        resultEl.innerHTML = "";

        // choose the real winner from the whole roster, then place it on a
        // random slice and fill the rest with other umas
        const winner = roster[Math.floor(Math.random() * roster.length)];
        const winSeg = Math.floor(Math.random() * SEGMENTS);
        const others = sample(SEGMENTS).filter((u) => u.name !== winner.name);
        segUmas = [];
        for (let i = 0; i < SEGMENTS; i++) {
            segUmas[i] = i === winSeg ? winner : others.pop();
        }
        drawWheel();

        // land the winning slice's centre under the pointer (top = -90°)
        const base = -Math.PI / 2 - (winSeg + 0.5) * SEG;
        const delta = (((base - rot) % TWO_PI) + TWO_PI) % TWO_PI;
        const turns = 5 + Math.floor(Math.random() * 3);
        const target = rot + turns * TWO_PI + delta;

        const start = rot;
        const dur = 4200;
        let t0 = null;
        const ease = (x) => 1 - Math.pow(1 - x, 3);

        function frame(ts) {
            if (t0 === null) t0 = ts;
            const p = Math.min((ts - t0) / dur, 1);
            rot = start + (target - start) * ease(p);
            canvas.style.transform = `rotate(${rot}rad)`;
            if (p < 1) {
                requestAnimationFrame(frame);
            } else {
                rot = ((target % TWO_PI) + TWO_PI) % TWO_PI;
                canvas.style.transform = `rotate(${rot}rad)`;
                reveal(winner);
            }
        }
        requestAnimationFrame(frame);
    }

    function reveal(uma) {
        resultEl.innerHTML = `
            <span class="r-label">The wheel picked</span>
            <img class="r-img" src="${norm(uma.img || "")}" alt="${norm(uma.name)}" onerror="this.style.display='none'" />
            <span class="r-name">${norm(uma.name)}</span>`;
        // force the pop animation to replay
        void resultEl.offsetWidth;
        resultEl.className = "show";
        confettiBurst();
        spinning = false;
        spinBtn.disabled = false;
        againBtn.hidden = false;
    }

    spinBtn.addEventListener("click", spin);
    againBtn.addEventListener("click", spin);

    // ===== how-to =====
    function openHowto() {
        howtoEl.innerHTML = `
            <div class="card">
                <div class="result">Uma Roulette 🎡</div>
                <p>Give the wheel a spin and see which <b>Umamusume</b> it lands on.</p>
                <p>That's the whole game. Spin as many times as you like!</p>
                <button class="cta" id="how-close">Let's spin 🐎</button>
            </div>`;
        howtoEl.style.cssText =
            "position:fixed;inset:0;background:rgba(58,46,57,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50";
        document.getElementById("how-close").onclick = () => {
            howtoEl.innerHTML = "";
            howtoEl.style.display = "none";
            try {
                localStorage.setItem("umaroulette_howto_seen", "1");
            } catch (e) {}
        };
    }
    howToBtn.onclick = openHowto;

    // ===== petals (ambient) =====
    const PETAL_COLORS = ["var(--sakura)", "var(--gold)", "var(--turf)", "#F6C6D8"];
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
            p.appendChild(inner);
            p.style.left = Math.random() * 100 + "vw";
            p.style.animationDuration = 9 + Math.random() * 8 + "s";
            p.style.animationDelay = -Math.random() * 16 + "s";
            layer.appendChild(p);
        }
    }

    // ===== confetti (on reveal) =====
    const CONF = ["#E85D8B", "#F2A93B", "#4CA62E", "#F6C6D8", "#7C748F", "#F4D03F", "#5BB8E8"];
    function confettiBurst() {
        if (
            window.matchMedia &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
        )
            return;
        const layer = document.getElementById("confetti");
        if (!layer) return;
        const W = innerWidth,
            H = innerHeight;
        for (let i = 0; i < 70; i++) {
            const el = document.createElement("div");
            el.className = "confetti";
            el.style.width = 6 + Math.random() * 6 + "px";
            el.style.height = 9 + Math.random() * 9 + "px";
            el.style.background = CONF[(Math.random() * CONF.length) | 0];
            if (Math.random() < 0.4) el.style.borderRadius = "50%";
            el.style.top = "40%";
            el.style.left = W / 2 + "px";
            layer.appendChild(el);
            const ax = (Math.random() - 0.5) * W * 1.1;
            const ay = -(H * 0.2 + Math.random() * H * 0.35);
            const ex = ax * 1.2;
            const ey = H * 0.55 + Math.random() * H * 0.4;
            const spin = (360 + Math.random() * 720) * (Math.random() < 0.5 ? 1 : -1);
            const anim = el.animate(
                [
                    { transform: "translate(0,0) rotate(0)", opacity: 1, offset: 0, easing: "cubic-bezier(.15,.6,.4,1)" },
                    { transform: `translate(${ax}px,${ay}px) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.4, easing: "cubic-bezier(.45,0,.7,.5)" },
                    { transform: `translate(${ex}px,${ey}px) rotate(${spin}deg)`, opacity: 0, offset: 1 },
                ],
                { duration: 1500 + Math.random() * 900, fill: "forwards" },
            );
            anim.onfinish = () => el.remove();
        }
    }

    // ===== boot =====
    spawnPetals(16);
    loadRoster();

    let seen = false;
    try {
        seen = !!localStorage.getItem("umaroulette_howto_seen");
    } catch (e) {}
    if (!seen) openHowto();
})();
