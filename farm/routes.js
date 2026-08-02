// Tact Farm Cooperation Center routes, mounted by the Pakadle server under
// /farm. A placeholder page for now: it serves index.html and nothing else.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = function farm(_db) {
    const ROOT = __dirname;

    return {
        handle(req, res, url) {
            const sub = url.pathname.slice("/farm".length);

            if (sub !== "" && sub !== "/") {
                res.writeHead(404);
                return res.end("not found");
            }

            fs.readFile(path.join(ROOT, "index.html"), (err, buf) => {
                if (err) {
                    res.writeHead(404);
                    return res.end("not found");
                }
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                });
                res.end(buf);
            });
        },
    };
};
