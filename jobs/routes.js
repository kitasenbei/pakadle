// Careers page routes, mounted by the Pakadle server under /jobs. Static only:
// the listings live in index.html and nothing here talks to the database.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = function jobs(_db) {
    const ROOT = __dirname;

    const MIME = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
    };

    const ALLOWED = new Set(["index.html", "style.css"]);

    function serveFile(res, name) {
        fs.readFile(path.join(ROOT, name), (err, buf) => {
            if (err) {
                res.writeHead(404);
                return res.end("not found");
            }
            res.writeHead(200, {
                "Content-Type":
                    MIME[path.extname(name)] || "application/octet-stream",
            });
            res.end(buf);
        });
    }

    return {
        handle(req, res, url) {
            const sub = url.pathname.slice("/jobs".length);

            if (sub === "" || sub === "/") return serveFile(res, "index.html");

            const name = sub.slice(1);
            if (ALLOWED.has(name)) return serveFile(res, name);

            res.writeHead(404);
            res.end("not found");
        },
    };
};
