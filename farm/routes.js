// Tact Farm Cooperation Center routes, mounted by the Pakadle server under
// /farm. A placeholder page for now: the title and the house styling, no more.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = function farm(_db) {
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
            const sub = url.pathname.slice("/farm".length);

            if (sub === "" || sub === "/") return serveFile(res, "index.html");

            const name = sub.slice(1);
            if (ALLOWED.has(name)) return serveFile(res, name);

            res.writeHead(404);
            res.end("not found");
        },
    };
};
