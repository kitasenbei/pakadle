// Pakadoom routes, mounted by the Pakadle server under /pakadoom.
// Shareware Doom runs in the browser as WebAssembly (the Cloudflare build of
// Chocolate Doom). The page reads its frames and redraws them with the
// Umapple portrait mosaic, so the server only hands out files.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = function pakadoom(_db) {
    const ROOT = __dirname;

    const MIME = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".png": "image/png",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".wad": "application/octet-stream",
        ".cfg": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
    };

    // The code files, which change with the page and are never cached.
    const CODE = new Set(["index.html", "game.js", "style.css", "COPYING.md", "README.md"]);
    // The engine and its data, which change only when Doom is rebuilt.
    const ENGINE = new Set(["websockets-doom.js", "websockets-doom.wasm", "doom1.wad", "default.cfg", "opl3.min.js", "atlas.png", "tiles.json"]);

    function serveFile(res, name, cache) {
        const fp = path.join(ROOT, name);
        const stream = fs.createReadStream(fp);
        stream.on("open", () => {
            const head = {
                "Content-Type": MIME[path.extname(name)] || "application/octet-stream",
            };
            if (cache) head["Cache-Control"] = cache;
            res.writeHead(200, head);
            stream.pipe(res);
        });
        stream.on("error", (err) => {
            if (res.headersSent) return res.destroy();
            res.writeHead(err.code === "ENOENT" ? 404 : 500);
            res.end(err.code === "ENOENT" ? "not found" : "error");
        });
    }

    return {
        handle(req, res, url) {
            const sub = url.pathname.slice("/pakadoom".length);
            if (sub === "" || sub === "/") return serveFile(res, "index.html");

            const name = sub.slice(1);
            if (ENGINE.has(name)) return serveFile(res, name, "public, max-age=86400");
            if (CODE.has(name)) return serveFile(res, name);

            res.writeHead(404);
            res.end("not found");
        },
    };
};
