// Umapple: the Bad Apple silhouette redrawn live from Umamusume portraits.
//
// The client does the whole render. The server sends the sprite atlas once, so
// each frame only measures the video and looks up tiles.
//
// Per frame:
//   1. Downsample the video to the chunk grid. Each pixel is the chunk darkness.
//   2. Build a direction field with gradient vector flow (GVF), warm-started
//      from the last frame so few iterations converge and the flow stays smooth.
//   3. Estimate motion (normal flow) and blend it into the direction.
//   4. Pick one raw portrait per chunk by darkness band and angle slot.
"use strict";

(function () {
    const BASE = "/umapple";

    // Fixed settings. No dynamic sizing.
    const COLS_FIXED = 48; // Columns in the chunk grid.
    const B = 6; // Darkness bands.
    const MW = 2.5; // Motion weight in the direction blend.
    const GVF_MU = 0.15; // GVF diffusion strength.
    const GVF_ITER = 12; // GVF iterations per warm frame.
    const TANGENT = true; // Flow along the contour, not across it.

    const video = document.getElementById("src");
    const screen = document.getElementById("screen");
    const sctx = screen.getContext("2d");

    // The low-res canvas holds one pixel per chunk. The browser downsample gives
    // the mean darkness of each chunk directly.
    const low = document.createElement("canvas");
    const lowctx = low.getContext("2d", { willReadFrequently: true });

    let COLS = COLS_FIXED;
    let ROWS = Math.round(COLS * 3 / 4);

    // Temporal state carried across frames.
    let prevDark = null; // The last frame darkness, for motion.
    let gvfU = null, gvfV = null; // The last GVF field, for the warm-start.

    // The active portrait set.
    let atlas = null, TILE = 64, ACOLS = 32;
    let hr = null, hux = null, huy = null, hang = null, bands = null, cuts = null;
    let ready = false;

    // Return the unit direction of a gradient. Rotate it to the tangent.
    function gradDir(gx, gy, gm) {
        if (gm <= 1e-4) return [0, 0];
        const dx = TANGENT ? -gy : gx, dy = TANGENT ? gx : gy;
        return [dx / gm, dy / gm];
    }

    // Draw the video into the grid with a cover crop, so a 4:3 source fills a
    // wider grid. The grid keeps the display aspect, so chunks stay square.
    function drawCover(ctx, W, H) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw) return;
        const targetAR = W / H, videoAR = vw / vh;
        let sx, sy, sw, sh;
        if (videoAR > targetAR) {
            sh = vh; sw = vh * targetAR; sx = (vw - sw) / 2; sy = 0;
        } else {
            sw = vw; sh = vw / targetAR; sx = 0; sy = (vh - sh) / 2;
        }
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
    }

    // Read the mean darkness of each chunk from the browser downsample.
    function lowDarkness() {
        const W = COLS, H = ROWS;
        if (low.width !== W || low.height !== H) { low.width = W; low.height = H; }
        drawCover(lowctx, W, H);
        const p = lowctx.getImageData(0, 0, W, H).data;
        const dark = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) {
            const lum = (0.299 * p[i * 4] + 0.587 * p[i * 4 + 1] + 0.114 * p[i * 4 + 2]) / 255;
            dark[i] = 1 - lum;
        }
        return dark;
    }

    // Build the unit direction field with gradient vector flow.
    // The seed is the darkness gradient. Jacobi iterations diffuse it into the
    // flat regions. The warm-start reuses the field of the last frame.
    function directionField(dark, W, H) {
        const dux = new Float32Array(W * H), duy = new Float32Array(W * H);
        const fx = new Float32Array(W * H), fy = new Float32Array(W * H), b = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const l = Math.max(x - 1, 0), r = Math.min(x + 1, W - 1);
                const u = Math.max(y - 1, 0), dn = Math.min(y + 1, H - 1);
                const gx = dark[y * W + r] - dark[y * W + l];
                const gy = dark[dn * W + x] - dark[u * W + x];
                fx[i] = gx; fy[i] = gy; b[i] = gx * gx + gy * gy;
            }
        }
        const warm = gvfU && gvfU.length === W * H;
        let u = warm ? gvfU : fx.slice();
        let v = warm ? gvfV : fy.slice();
        let un = new Float32Array(W * H), vn = new Float32Array(W * H);
        const dt = 0.5, ITER = warm ? GVF_ITER : 40;
        for (let it = 0; it < ITER; it++) {
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = y * W + x;
                    const l = Math.max(x - 1, 0), r = Math.min(x + 1, W - 1);
                    const up = Math.max(y - 1, 0), dn = Math.min(y + 1, H - 1);
                    const lapU = u[y * W + l] + u[y * W + r] + u[up * W + x] + u[dn * W + x] - 4 * u[i];
                    const lapV = v[y * W + l] + v[y * W + r] + v[up * W + x] + v[dn * W + x] - 4 * v[i];
                    un[i] = u[i] + dt * (GVF_MU * lapU - b[i] * (u[i] - fx[i]));
                    vn[i] = v[i] + dt * (GVF_MU * lapV - b[i] * (v[i] - fy[i]));
                }
            }
            let t = u; u = un; un = t; t = v; v = vn; vn = t;
        }
        gvfU = u; gvfV = v;
        for (let i = 0; i < W * H; i++) {
            const [dx, dy] = gradDir(u[i], v[i], Math.hypot(u[i], v[i]));
            dux[i] = dx; duy[i] = dy;
        }
        return { dux, duy };
    }

    // Prepare the portrait set. Sort the horses into equal-count darkness bands.
    // Sort each band by angle so every portrait owns an equal angle slice.
    function buildSet(data, img) {
        atlas = img; TILE = data.tile; ACOLS = data.cols;
        const n = data.n;
        hr = new Float32Array(n); hux = new Float32Array(n); huy = new Float32Array(n);
        hang = new Float32Array(n);
        data.horses.forEach((h, i) => {
            hr[i] = h.ratio; hux[i] = h.ux; huy[i] = h.uy;
            let a = Math.atan2(h.uy, h.ux);
            if (a < 0) a += 2 * Math.PI;
            hang[i] = a;
        });
        const order = [...Array(n).keys()].sort((a, b2) => hr[a] - hr[b2]);
        bands = []; cuts = [];
        for (let bi = 0; bi < B; bi++) {
            const start = Math.floor(bi * n / B), end = Math.floor((bi + 1) * n / B);
            if (bi > 0) cuts.push(hr[order[start]]);
            bands.push(order.slice(start, end).sort((p, q) => hang[p] - hang[q]));
        }
    }

    // Pick a portrait by darkness band, then by angle slot within the band.
    function pickHorse(ratio, ang, hasDir, cx, cy) {
        let b = 0;
        while (b < cuts.length && ratio >= cuts[b]) b++;
        const seg = bands[b];
        let slot;
        if (hasDir) {
            let a = ang % (2 * Math.PI);
            if (a < 0) a += 2 * Math.PI;
            slot = Math.min(seg.length - 1, Math.floor(a / (2 * Math.PI) * seg.length));
        } else {
            slot = (((cx * 73856093) ^ (cy * 19349663)) >>> 0) % seg.length;
        }
        return seg[slot];
    }

    // Size the canvas backing store to the display in device pixels. The grid
    // keeps the display aspect. This avoids any rescale, so the result is crisp.
    function resize() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        screen.width = Math.max(1, Math.round(window.innerWidth * dpr));
        screen.height = Math.max(1, Math.round(window.innerHeight * dpr));
        COLS = COLS_FIXED;
        ROWS = Math.max(1, Math.round(COLS * screen.height / screen.width));
        low.width = COLS; low.height = ROWS;
        prevDark = null; gvfU = null; gvfV = null;
    }

    // Draw one portrait mosaic frame.
    function render() {
        if (video.readyState >= 2 && ready) {
            const W = COLS, H = ROWS;
            const dark = lowDarkness();
            const { dux, duy } = directionField(dark, W, H);
            const cw = screen.width / W, ch = screen.height / H;
            const dw = Math.ceil(cw), dh = Math.ceil(ch);

            for (let cy = 0; cy < H; cy++) {
                for (let cx = 0; cx < W; cx++) {
                    const i = cy * W + cx;
                    const ratio = dark[i];
                    const l = Math.max(cx - 1, 0), r = Math.min(cx + 1, W - 1);
                    const u = Math.max(cy - 1, 0), dn = Math.min(cy + 1, H - 1);
                    const ux = dux[i], uy = duy[i];

                    let mx = 0, my = 0;
                    const Dx = dark[cy * W + r] - dark[cy * W + l];
                    const Dy = dark[dn * W + cx] - dark[u * W + cx];
                    const Dm = Math.hypot(Dx, Dy);
                    if (prevDark && Dm > 1e-3) {
                        const Dt = dark[i] - prevDark[i];
                        mx = -Dt * Dx / Dm; my = -Dt * Dy / Dm;
                    }

                    let bx = ux + MW * mx, by = uy + MW * my;
                    const bm = Math.hypot(bx, by);
                    if (bm > 1e-6) { bx /= bm; by /= bm; } else { bx = ux; by = uy; }

                    const hasDir = ux !== 0 || uy !== 0 || mx !== 0 || my !== 0;
                    const h = pickHorse(ratio, Math.atan2(by, bx), hasDir, cx, cy);
                    const sx = (h % ACOLS) * TILE, sy = ((h / ACOLS) | 0) * TILE;
                    sctx.drawImage(atlas, sx, sy, TILE, TILE, cx * cw, cy * ch, dw, dh);
                }
            }
            prevDark = dark;
        }
        requestAnimationFrame(render);
    }

    // ---- readiness checks ----
    // The app starts only after the portraits and the video are both ready.
    const boot = document.getElementById("boot");
    const chkP = document.getElementById("chkP");
    const chkV = document.getElementById("chkV");
    const loading = document.getElementById("loading");
    const startBtn = document.getElementById("start");
    const hint = document.getElementById("hint");

    let portraitsReady = false, videoReady = false, started = false;

    function checkReady() {
        chkP.classList.toggle("ok", portraitsReady);
        chkV.classList.toggle("ok", videoReady);
        if (portraitsReady && videoReady && ready) {
            loading.hidden = true;
            startBtn.hidden = false;
        }
    }

    // Portrait check: the atlas image and the descriptors load.
    Promise.all([
        fetch(BASE + "/horses.json").then((r) => r.json()),
        new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = BASE + "/atlas.png"; }),
    ]).then(([data, img]) => {
        buildSet(data, img);
        ready = true; portraitsReady = true;
        checkReady();
    });

    // Video check: the browser buffers enough to play. Poll as a fallback in
    // case the canplaythrough event does not fire.
    function markVideoReady() { videoReady = true; checkReady(); }
    video.addEventListener("canplaythrough", markVideoReady);
    const vpoll = setInterval(() => {
        if (video.readyState >= 3) { markVideoReady(); clearInterval(vpoll); }
    }, 250);

    resize();
    window.addEventListener("resize", resize);
    requestAnimationFrame(render);

    // ---- start ----
    function start() {
        if (started || !portraitsReady || !videoReady) return;
        started = true;
        boot.hidden = true;
        hint.hidden = false;
        video.currentTime = 0; // Start the sound with the motion, from the top.
        video.muted = false;
        video.play();
    }
    startBtn.addEventListener("click", start);

    // Press P to pause. Press P again to play.
    document.addEventListener("keydown", (e) => {
        if (e.key === "p" || e.key === "P") {
            if (!started) return;
            if (video.paused) video.play(); else video.pause();
        }
    });
})();
