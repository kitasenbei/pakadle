// Umapple routes, mounted by the Pakadle server under /umapple.
// The client renders the mosaic. The server sends the sprite atlas once and
// streams the source video, so nothing is rendered server side.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = function umapple(_db) {
    const ROOT = __dirname;

    const MIME = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
    };

    // The code files the page loads.
    const CODE = new Set(["index.html", "game.js", "style.css"]);

    function serveFile(res, name, cache) {
        fs.readFile(path.join(ROOT, name), (err, buf) => {
            if (err) {
                res.writeHead(404);
                return res.end("not found");
            }
            const head = {
                "Content-Type": MIME[path.extname(name)] || "application/octet-stream",
            };
            if (cache) head["Cache-Control"] = cache;
            res.writeHead(200, head);
            res.end(buf);
        });
    }

    // Stream the source video with range support, so the browser can seek and loop.
    function serveVideo(req, res, name) {
        const fp = path.join(ROOT, name);
        fs.stat(fp, (err, st) => {
            if (err) {
                res.writeHead(404);
                return res.end("not found");
            }
            const size = st.size;
            const range = req.headers.range;
            if (range) {
                const m = /bytes=(\d+)-(\d*)/.exec(range);
                const start = m ? parseInt(m[1], 10) : 0;
                const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
                res.writeHead(206, {
                    "Content-Type": "video/mp4",
                    "Accept-Ranges": "bytes",
                    "Content-Length": end - start + 1,
                    "Content-Range": `bytes ${start}-${end}/${size}`,
                });
                fs.createReadStream(fp, { start, end }).pipe(res);
            } else {
                res.writeHead(200, {
                    "Content-Type": "video/mp4",
                    "Accept-Ranges": "bytes",
                    "Content-Length": size,
                });
                fs.createReadStream(fp).pipe(res);
            }
        });
    }

    return {
        handle(req, res, url) {
            const sub = url.pathname.slice("/umapple".length);
            if (sub === "" || sub === "/") return serveFile(res, "index.html");

            const name = sub.slice(1);
            if (name === "badapple.mp4") return serveVideo(req, res, "badapple.mp4");
            // The atlas and descriptors ship once and cache for a week.
            if (name === "atlas.png") {
                return serveFile(res, "atlas.png", "public, max-age=604800, immutable");
            }
            if (name === "horses.json") {
                return serveFile(res, "horses.json", "public, max-age=604800");
            }
            if (CODE.has(name)) return serveFile(res, name);

            res.writeHead(404);
            res.end("not found");
        },
    };
};
