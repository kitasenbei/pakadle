// Tiny vector-ish flag renderer.
//
// Every flag is a stack of layers drawn in unit coordinates (x and y both in
// [0,1], hoist at x=0, top at y=0). To rasterise we walk the layers for each
// cell of a W x H grid and keep the last colour that claims it. The output is a
// grid of one-letter colour codes, which the page then maps to emoji squares or
// ASCII characters.
//
// Flags are 3:2, so anything that has to look round (circles, stars) divides its
// x offsets by AR. Thicknesses given in y-units get the same treatment when they
// run vertically.
"use strict";

(function (root) {
    const AR = 1.5; // flag width / height

    // ---- layer builders ----------------------------------------------------
    const F = (c) => ({ t: "f", c });
    const H = (...c) => ({ t: "h", c });
    const HW = (c, w) => ({ t: "h", c, w });
    const V = (...c) => ({ t: "v", c });
    const VW = (c, w) => ({ t: "v", c, w });
    const RECT = (x, y, w, h, c) => ({ t: "r", x, y, w, h, c });
    const CIR = (cx, cy, r, c) => ({ t: "c", cx, cy, r, c });
    const POLY = (pts, c) => ({ t: "p", pts, c });
    const LINE = (x1, y1, x2, y2, th, c) => ({ t: "l", x1, y1, x2, y2, th, c });

    // 5-pointed star (or any point count), pointing up unless rotated.
    function STAR(cx, cy, r, c, pts, rot) {
        pts = pts || 5;
        rot = rot || 0;
        const v = [];
        for (let i = 0; i < pts * 2; i++) {
            const rad = i % 2 === 0 ? r : r * 0.382;
            const a = rot + (i * Math.PI) / pts;
            v.push([cx + (rad * Math.sin(a)) / AR, cy - rad * Math.cos(a)]);
        }
        return POLY(v, c);
    }

    // Triangle jutting from the hoist, w deep.
    const TRI = (w, c) => POLY([[0, 0], [w, 0.5], [0, 1]], c);

    // Nordic-style offset cross: vertical bar centred on x, horizontal on y.
    // `box` ([x, y, w, h]) confines it to a canton or a shield; it covers the
    // whole field by default.
    const CROSS = (x, y, th, c, box) => {
        const [bx, by, bw, bh] = box || [0, 0, 1, 1];
        return [
            RECT(bx, y - th / 2, bw, th, c),
            RECT(x - th / AR / 2, by, th / AR, bh, c),
        ];
    };

    // Saltire (diagonal cross) across the whole field.
    const SALT = (th, c) => [
        LINE(0, 0, 1, 1, th, c),
        LINE(1, 0, 0, 1, th, c),
    ];

    // Crescent: a disc with a smaller disc of the background colour bitten out
    // of its fly side.
    const CRES = (cx, cy, r, c, bg) => [
        CIR(cx, cy, r, c),
        CIR(cx + (r * 0.28) / AR, cy, r * 0.82, bg),
    ];

    // Union Jack packed into an arbitrary rectangle, for the ex-British flags.
    // In a canton there are only a handful of cells to work with, so the red
    // diagonals get dropped: at that size they turn the whole square to mush.
    function UNION(x, y, w, h) {
        const px = (u) => x + u * w;
        const py = (u) => y + u * h;
        const small = w < 0.6;
        const dw = (small ? 0.2 : 0.3) * h;
        const cw = (small ? 0.3 : 0.38) * h;
        const rw = (small ? 0.16 : 0.22) * h;
        return [
            RECT(x, y, w, h, "B"),
            LINE(px(0), py(0), px(1), py(1), dw, "W"),
            LINE(px(1), py(0), px(0), py(1), dw, "W"),
            ...(small
                ? []
                : [
                      LINE(px(0), py(0), px(1), py(1), 0.12 * h, "R"),
                      LINE(px(1), py(0), px(0), py(1), 0.12 * h, "R"),
                  ]),
            RECT(x, py(0.5) - cw / 2, w, cw, "W"),
            RECT(px(0.5) - cw / AR / 2, y, cw / AR, h, "W"),
            RECT(x, py(0.5) - rw / 2, w, rw, "R"),
            RECT(px(0.5) - rw / AR / 2, y, rw / AR, h, "R"),
        ];
    }

    // ---- rasteriser --------------------------------------------------------
    function bands(layer, x, y) {
        const along = layer.t === "h" ? y : x;
        const w = layer.w || layer.c.map(() => 1);
        const total = w.reduce((a, b) => a + b, 0);
        let acc = 0;
        for (let i = 0; i < layer.c.length; i++) {
            acc += w[i] / total;
            if (along < acc) return layer.c[i];
        }
        return layer.c[layer.c.length - 1];
    }

    function inPoly(pts, x, y) {
        let hit = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const [xi, yi] = pts[i];
            const [xj, yj] = pts[j];
            if (
                yi > y !== yj > y &&
                x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
            )
                hit = !hit;
        }
        return hit;
    }

    function nearLine(l, x, y) {
        const ax = l.x1 * AR,
            ay = l.y1,
            bx = l.x2 * AR,
            by = l.y2;
        const px = x * AR - ax,
            py = y - ay;
        const dx = bx - ax,
            dy = by - ay;
        const len = dx * dx + dy * dy;
        let t = len ? (px * dx + py * dy) / len : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = px - t * dx,
            qy = py - t * dy;
        return Math.hypot(qx, qy) <= l.th / 2;
    }

    function colorAt(layers, x, y) {
        let out = "W";
        for (const l of layers) {
            switch (l.t) {
                case "f":
                    out = l.c;
                    break;
                case "h":
                case "v":
                    out = bands(l, x, y);
                    break;
                case "r":
                    if (
                        x >= l.x &&
                        x < l.x + l.w &&
                        y >= l.y &&
                        y < l.y + l.h
                    )
                        out = l.c;
                    break;
                case "c":
                    if (
                        Math.hypot((x - l.cx) * AR, y - l.cy) <= l.r
                    )
                        out = l.c;
                    break;
                case "p":
                    if (inPoly(l.pts, x, y)) out = l.c;
                    break;
                case "l":
                    if (nearLine(l, x, y)) out = l.c;
                    break;
            }
        }
        return out;
    }

    // Layer arrays may contain nested arrays (CROSS, SALT, UNION return lists).
    function flatten(spec) {
        const out = [];
        for (const l of spec) {
            if (Array.isArray(l)) out.push(...flatten(l));
            else out.push(l);
        }
        return out;
    }

    function render(spec, w, h) {
        const layers = flatten(spec);
        const rows = [];
        for (let j = 0; j < h; j++) {
            let row = "";
            for (let i = 0; i < w; i++) {
                row += colorAt(layers, (i + 0.5) / w, (j + 0.5) / h);
            }
            rows.push(row);
        }
        return rows;
    }

    root.FlagRender = {
        render,
        F, H, HW, V, VW, RECT, CIR, POLY, LINE, STAR, TRI, CROSS, SALT, CRES,
        UNION,
    };
})(typeof window !== "undefined" ? window : globalThis);
