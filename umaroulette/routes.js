// Umaroulette routes, mounted by the Pakadle server under /umaroulette.
// A pure-fun spinning wheel: press spin, the wheel lands on a random Umamusume.
// No daily lock, no persistence — it just serves the static page and the roster
// (name + portrait) pulled from the shared Pakadle word bank.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = function umaroulette(_db) {
    const ROOT = __dirname;

    // Roster lives one level up in the Pakadle word bank (name + portrait url).
    const UMA_WORDS = new Function(
        fs.readFileSync(path.join(ROOT, "..", "words.js"), "utf8") +
            "\nreturn UMA_WORDS;",
    )();

    const ROSTER = UMA_WORDS.map((u) => ({ name: u.name, img: u.img })).sort(
        (a, b) => a.name.localeCompare(b.name),
    );

    const MIME = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
    };

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

    function sendJson(res, obj, code = 200) {
        res.writeHead(code, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(obj));
    }

    return {
        handle(req, res, url) {
            const sub = url.pathname.slice("/umaroulette".length);

            if (sub === "" || sub === "/") return serveFile(res, "index.html");
            if (sub === "/style.css" || sub === "/game.js")
                return serveFile(res, sub.slice(1));

            if (sub === "/api/names" && req.method === "GET") {
                return sendJson(res, ROSTER);
            }

            res.writeHead(404);
            res.end("not found");
        },
    };
};
