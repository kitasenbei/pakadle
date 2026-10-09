// Pakadoom: shareware Doom redrawn live from Umamusume tails.
//
// Doom itself is the Cloudflare WebAssembly build of Chocolate Doom. It draws
// into a hidden canvas. Each animation frame this script reads that canvas and
// rebuilds it as a photomosaic:
//   1. Downsample the frame to the chunk grid. Each pixel is the chunk's mean
//      colour.
//   2. Rank the chunks by luminance within the frame. The tiles are whole
//      tails on black, built by build-atlas.py, and they only span a dark
//      range, so the frame's own range is mapped onto the library's: the
//      lightest chunk gets the lightest tail, the darkest the darkest.
//   3. Pick the tail whose mean colour is nearest that target luminance and
//      the chunk's own hue, and draw it at full cell size.
// Umapple picks tails by darkness band and edge direction instead. Doom frames
// are full of texture rather than silhouette, so tone and hue read better.
"use strict";

(function () {
    const BASE = "/pakadoom";

    // Settings.
    const COLS_START = 200; // Columns in the chunk grid at load. Minus and plus change it.
    const COLS_MIN = 40, COLS_MAX = 320, COLS_STEP = 10;
    const CHROMA = 0.6; // Weight of hue against tone in the tile match.

    const source = document.getElementById("canvas");
    const screen = document.getElementById("screen");
    const sctx = screen.getContext("2d");
    // No context menu over the game. Done here rather than as an attribute,
    // which the site's Content Security Policy forbids.
    document.addEventListener("contextmenu", (e) => e.preventDefault());

    // Doom uses SDL's software renderer (force_software_renderer in the
    // config), so its canvas is a plain 2D canvas and can be read any time.
    // A WebGL canvas would come back black once composited.

    // The low-res canvas holds one pixel per chunk. The browser downsample gives
    // the mean colour of each chunk directly.
    const low = document.createElement("canvas");
    const lowctx = low.getContext("2d", { willReadFrequently: true });

    let COLS = COLS_START;
    let ROWS = Math.round(COLS * 3 / 4);

    // The tile set, with each tile's mean colour as luminance and chroma.
    let atlas = null, TILE = 64, ACOLS = 32;
    let tY = null, tCb = null, tCr = null, yMin = 0, yMax = 1;
    let ready = false;

    // Drawing is the cost, not matching: ten thousand drawImage calls a frame,
    // each scaling a 64px tile down to a cell. Instead the atlas is rescaled
    // once to the cell size and read back as pixels, the frame is assembled
    // in one pixel buffer by copying tile rows, and that buffer goes to the
    // screen with a single putImageData. A cell is only copied again when
    // its tile changes, so a still view costs almost nothing.
    const scaled = document.createElement("canvas");
    const scaledctx = scaled.getContext("2d", { willReadFrequently: true });
    let scaled32 = null, scaledStride = 0; // The rescaled atlas as 32-bit pixels.
    let scaledW = 0, scaledH = 0; // Cell size the scaled atlas was built for.
    let frameImg = null, frame32 = null; // The assembled frame, letterbox size.
    let lastTile = null; // Tile index in each cell, -1 for none.

    function rescaleAtlas(dw, dh) {
        const rows = Math.ceil(tY.length / ACOLS);
        scaled.width = ACOLS * dw; scaled.height = rows * dh;
        scaledctx.imageSmoothingEnabled = true;
        scaledctx.imageSmoothingQuality = "high";
        for (let t = 0; t < tY.length; t++) {
            scaledctx.drawImage(atlas, (t % ACOLS) * TILE, ((t / ACOLS) | 0) * TILE, TILE, TILE,
                (t % ACOLS) * dw, ((t / ACOLS) | 0) * dh, dw, dh);
        }
        const d = scaledctx.getImageData(0, 0, scaled.width, scaled.height).data;
        scaled32 = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
        scaledStride = scaled.width;
        scaledW = dw; scaledH = dh;
    }

    // Forget what is on screen, so the next frame assembles every cell.
    function invalidate() {
        lastTile = null;
        sctx.fillStyle = "#000";
        sctx.fillRect(0, 0, screen.width, screen.height);
    }

    // The part of the Doom canvas that holds the frame. SDL sizes the canvas
    // to the window times the device pixel ratio, but the software
    // framebuffer in this engine build writes the window size, so on a scaled
    // display the frame sits in the top-left corner with black to the right
    // and below. The probe looks for that black margin and crops it off.
    const WINDOW_W = 640, WINDOW_H = 400; // From default.cfg.
    const margin = document.createElement("canvas");
    margin.width = 1; margin.height = 16;
    const mctx = margin.getContext("2d", { willReadFrequently: true });
    let srcW = 0, srcH = 0, seenW = 0, seenH = 0, probeAt = -1e9;
    function frameSize() {
        if (source.width !== seenW || source.height !== seenH) {
            seenW = srcW = source.width; seenH = srcH = source.height;
            probeAt = -1e9;
        }
        if (source.width <= WINDOW_W || frame - probeAt < 60) return;
        probeAt = frame;
        // One column of the right margin, squeezed to 16 samples.
        mctx.drawImage(source, WINDOW_W + 1, 0, 1, source.height, 0, 0, 1, 16);
        const d = mctx.getImageData(0, 0, 1, 16).data;
        let lit = 0;
        for (let i = 0; i < 16; i++) if (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2] > 24) lit++;
        const cropped = lit === 0;
        srcW = cropped ? WINDOW_W : source.width;
        srcH = cropped ? WINDOW_H : source.height;
    }

    // The rectangle the whole frame fits in, centred in a W by H target. Doom
    // is 4:3 and screens are wider, so the frame is letterboxed, never cropped.
    function fitRect(W, H) {
        const vw = srcW, vh = srcH;
        const scale = Math.min(W / vw, H / vh);
        const fw = vw * scale, fh = vh * scale;
        return { x: (W - fw) / 2, y: (H - fh) / 2, w: fw, h: fh };
    }

    function setTiles(rgb) {
        const n = rgb.length;
        tY = new Float32Array(n); tCb = new Float32Array(n); tCr = new Float32Array(n);
        yMin = Infinity; yMax = -Infinity;
        rgb.forEach(([r, g, b], i) => {
            tY[i] = 0.299 * r + 0.587 * g + 0.114 * b;
            tCb[i] = b - tY[i]; tCr[i] = r - tY[i];
            if (tY[i] < yMin) yMin = tY[i];
            if (tY[i] > yMax) yMax = tY[i];
        });
    }

    // The luminance rank of each chunk within the frame, 0 lightest, 1 darkest.
    function lumRanks(p, n) {
        const hist = new Uint32Array(256), y = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            y[i] = Math.min(255, (0.299 * p[i * 4] + 0.587 * p[i * 4 + 1] + 0.114 * p[i * 4 + 2]) | 0);
            hist[y[i]]++;
        }
        const rankAt = new Float32Array(256);
        let seen = 0;
        for (let v = 0; v < 256; v++) { rankAt[v] = (seen + hist[v] / 2) / n; seen += hist[v]; }
        const rank = new Float32Array(n);
        for (let i = 0; i < n; i++) rank[i] = 1 - rankAt[y[i]];
        return rank;
    }

    // The tail nearest a target luminance and the chunk's chroma. Answers are
    // cached by quantised input, filled in as colours first appear.
    const Q_Y = 64, Q_C = 16;
    const pickCache = new Int16Array(Q_Y * Q_C * Q_C).fill(-1);
    function pickTile(targetY, r, g, b) {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const cb = b - y, cr = r - y;
        const qy = Math.min(Q_Y - 1, ((targetY - yMin) / (yMax - yMin + 1e-6) * Q_Y) | 0);
        const qcb = Math.min(Q_C - 1, Math.max(0, ((cb + 128) / 256 * Q_C) | 0));
        const qcr = Math.min(Q_C - 1, Math.max(0, ((cr + 128) / 256 * Q_C) | 0));
        const key = (qy * Q_C + qcb) * Q_C + qcr;
        let pick = pickCache[key];
        if (pick >= 0) return pick;
        // Match on the cell centre, so every colour in the cell gets the same answer.
        const ty = yMin + (qy + 0.5) / Q_Y * (yMax - yMin);
        const ccb = ((qcb + 0.5) / Q_C * 256 - 128) * CHROMA, ccr = ((qcr + 0.5) / Q_C * 256 - 128) * CHROMA;
        let best = Infinity;
        pick = 0;
        for (let i = 0; i < tY.length; i++) {
            const dy = tY[i] - ty, dcb = tCb[i] * CHROMA - ccb, dcr = tCr[i] * CHROMA - ccr;
            const d = dy * dy + dcb * dcb + dcr * dcr;
            if (d < best) { best = d; pick = i; }
        }
        pickCache[key] = pick;
        return pick;
    }

    function resize() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        screen.width = Math.max(1, Math.round(window.innerWidth * dpr));
        screen.height = Math.max(1, Math.round(window.innerHeight * dpr));
        invalidate();
    }

    // The grid covers the frame, not the screen. Chunks stay square because the
    // frame rectangle keeps the source aspect.
    function gridSize() {
        frameSize();
        ROWS = Math.max(1, Math.round(COLS * srcH / srcW));
        if (low.width !== COLS || low.height !== ROWS) {
            low.width = COLS; low.height = ROWS;
            invalidate();
        }
    }

    let started = false;
    let frame = 0;

    function render() {
        if (started && ready && source.width > 0) {
            gridSize();
            const W = COLS, H = ROWS;
            lowctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, W, H);
            const p = lowctx.getImageData(0, 0, W, H).data;
            const rank = lumRanks(p, W * H);
            const f = fitRect(screen.width, screen.height);
            const fw = Math.round(f.w), fh = Math.round(f.h);
            const cw = fw / W, ch = fh / H;
            const dw = Math.ceil(cw), dh = Math.ceil(ch);
            if (dw !== scaledW || dh !== scaledH) { rescaleAtlas(dw, dh); lastTile = null; }
            if (!lastTile || frameImg.width !== fw || frameImg.height !== fh) {
                lastTile = new Int16Array(W * H).fill(-1);
                frameImg = sctx.createImageData(fw, fh);
                frame32 = new Uint32Array(frameImg.data.buffer, frameImg.data.byteOffset, frameImg.data.length >> 2);
            }
            let changed = false;
            for (let cy = 0; cy < H; cy++) {
                const y0 = Math.round(cy * ch), y1 = Math.min(fh, Math.round((cy + 1) * ch));
                for (let cx = 0; cx < W; cx++) {
                    const c = cy * W + cx, i = c * 4;
                    const t = pickTile(yMin + (1 - rank[c]) * (yMax - yMin), p[i], p[i + 1], p[i + 2]);
                    if (t === lastTile[c]) continue;
                    lastTile[c] = t;
                    changed = true;
                    const x0 = Math.round(cx * cw), x1 = Math.min(fw, Math.round((cx + 1) * cw));
                    const w = x1 - x0;
                    let src = ((t / ACOLS) | 0) * dh * scaledStride + (t % ACOLS) * dw;
                    let dst = y0 * fw + x0;
                    for (let yy = y0; yy < y1; yy++) {
                        frame32.set(scaled32.subarray(src, src + w), dst);
                        src += scaledStride; dst += fw;
                    }
                }
            }
            if (changed) sctx.putImageData(frameImg, Math.round(f.x), Math.round(f.y));
        }
        if (started && source.width > 0 && (frame++ % 15) === 0) musicTick();
        requestAnimationFrame(render);
    }

    // ---- readiness checks ----
    const boot = document.getElementById("boot");
    const chkP = document.getElementById("chkP");
    const chkD = document.getElementById("chkD");
    const loading = document.getElementById("loading");
    const startBtn = document.getElementById("start");

    let portraitsReady = false, doomReady = false;

    function checkReady() {
        chkP.classList.toggle("ok", portraitsReady);
        chkD.classList.toggle("ok", doomReady);
        if (portraitsReady && doomReady) {
            loading.hidden = true;
            startBtn.hidden = false;
        }
    }

    Promise.all([
        fetch(BASE + "/tiles.json").then((r) => r.json()),
        new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = BASE + "/atlas.png"; }),
    ]).then(([data, img]) => {
        atlas = img; TILE = data.tile; ACOLS = data.cols;
        setTiles(data.rgb);
        ready = true; portraitsReady = true;
        checkReady();
    });

    // ---- music ----
    // The engine's own synth cannot run here (see -nomusic below), so the page
    // plays the music itself. It reads the MUS lump for the level out of the
    // WAD and runs it through an OPL3 emulator with the WAD's own GENMIDI
    // instruments, which is the same chain Chocolate Doom uses natively.
    //
    // The engine does not report level changes, so the page watches the
    // frame instead: the status bar vanishes during the intermission, and the
    // next level starts when it comes back. The secret exit on E1M3 is not
    // tracked, so E1M9 plays the E1M4 music.
    const music = { lumps: null, player: null, track: null, level: 1, inter: false, muted: false };
    const MUSIC_VOLUME = 2; // The emulator's output is quiet.

    // The lump directory of a WAD, as name to ArrayBuffer.
    function parseWad(buf) {
        const dv = new DataView(buf);
        const n = dv.getInt32(4, true), dir = dv.getInt32(8, true);
        const lumps = new Map();
        for (let i = 0; i < n; i++) {
            const at = dir + i * 16;
            const pos = dv.getInt32(at, true), size = dv.getInt32(at + 4, true);
            let name = "";
            for (let k = 0; k < 8; k++) {
                const c = dv.getUint8(at + 8 + k);
                if (!c) break;
                name += String.fromCharCode(c);
            }
            lumps.set(name, buf.slice(pos, pos + size));
        }
        return lumps;
    }

    fetch(BASE + "/doom1.wad").then((r) => r.arrayBuffer()).then((buf) => { music.lumps = parseWad(buf); });

    // Play one lump, looped, replacing whatever plays now.
    function playTrack(name) {
        if (!music.lumps || !window.OPL3 || music.track === name) return;
        const mus = music.lumps.get(name);
        if (!mus) return;
        if (music.player) music.player.pause();
        music.track = name;
        const player = new OPL3.Player(OPL3.format.MUS, {
            instruments: music.lumps.get("GENMIDI").slice(0),
            prebuffer: 1500,
            volume: music.muted ? 0 : MUSIC_VOLUME,
        });
        let rendered = false;
        player.on("end", () => { rendered = true; });
        player.on("position", (ms) => { if (rendered && ms >= player.length) player.seek(0); });
        player.on("error", (err) => console.error("music:", err));
        player.play(mus.slice(0));
        music.player = player;
    }

    // Whether the status bar is on screen. The strip just below the view is
    // grey stone when the bar is there, and anything else when it is not.
    const probe = document.createElement("canvas");
    probe.width = 32; probe.height = 1;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    function statusBarVisible() {
        const h = srcH, w = srcW;
        pctx.drawImage(source, 0, Math.round(h * 169 / 200), w, Math.max(1, Math.round(h / 200)), 0, 0, 32, 1);
        const d = pctx.getImageData(0, 0, 32, 1).data;
        let grey = 0;
        for (let i = 0; i < 32; i++) {
            const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
            if (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 40 && r < 150) grey++;
        }
        return grey >= 26;
    }

    let barGone = 0;
    function musicTick() {
        if (!statusBarVisible()) {
            barGone++;
            if (barGone > 20 && !music.inter) { music.inter = true; playTrack("D_INTER"); }
            return;
        }
        barGone = 0;
        if (music.inter) { music.inter = false; music.level = Math.min(8, music.level + 1); }
        playTrack("D_E1M" + music.level);
    }

    // ---- Doom ----
    // The Emscripten glue reads this global. The wad and config are preloaded
    // into its virtual filesystem, and the game is started by the button so the
    // click doubles as the user gesture the audio needs.
    // The same file serves as both configs. Chocolate Doom keeps the vanilla
    // variables in default.cfg and its own, such as force_software_renderer,
    // in the extra config, and skips unknown names in each.
    // -nomusic is required. The OPL music driver starts a timer thread, and
    // this build has no threads, so without the flag the start click hangs
    // inside music init and the game never appears. Sound effects still play.
    // -warp skips the title loop and starts E1M1 single player at once. The
    // title loop plays the shareware demos, and the third one is a four-player
    // deathmatch recording, which looks like a multiplayer game nobody asked for.
    const ARGS = ["-iwad", "doom1.wad", "-window", "-nogui", "-nomusic",
        "-config", "default.cfg", "-extraconfig", "default.cfg",
        "-warp", "1", "1", "-skill", "3"];
    window.Module = {
        canvas: source,
        noInitialRun: true,
        locateFile: (file) => BASE + "/" + file,
        preRun: [() => {
            window.Module.FS.createPreloadedFile("", "doom1.wad", BASE + "/doom1.wad", true, true);
            window.Module.FS.createPreloadedFile("", "default.cfg", BASE + "/default.cfg", true, true);
        }],
        onRuntimeInitialized: () => { doomReady = true; checkReady(); },
        print: (text) => console.log(text),
        printErr: (text) => console.error(text),
        setStatus: () => {},
    };

    resize();
    window.addEventListener("resize", resize);
    requestAnimationFrame(render);

    function start() {
        if (started || !portraitsReady || !doomReady) return;
        started = true;
        boot.hidden = true;
        window.callMain(ARGS);
        source.focus();
    }
    startBtn.addEventListener("click", start);

    // Press V to show the real Doom frame in the corner. Press M to mute the
    // music. Minus and plus make the tails bigger and smaller.
    document.addEventListener("keydown", (e) => {
        if (e.key === "v" || e.key === "V") document.body.classList.toggle("peek");
        if (e.key === "-" || e.key === "_") COLS = Math.max(COLS_MIN, COLS - COLS_STEP);
        if (e.key === "+" || e.key === "=") COLS = Math.min(COLS_MAX, COLS + COLS_STEP);
        if (e.key === "m" || e.key === "M") {
            music.muted = !music.muted;
            if (music.player) music.player.volume = music.muted ? 0 : MUSIC_VOLUME;
        }
    });
})();
