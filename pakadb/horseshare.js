// Horseshare: a lightweight social feed for bred horses. A logged-in Pakadle
// account can POST a horse (one pedigree from the PakaDB breeding tool) together
// with a trainer ID; anyone can browse the feed and rate each post 1–5 stars.
//
// SECURITY POSTURE — user input is treated as hostile. Per post we accept EXACTLY:
//   1) a trainer ID   -> digits only, length-bounded
//   2) one bred horse -> only structured, whitelisted, game-referenced data
//      (numeric character/card IDs, enum-keyed factor stars, white skills
//      resolved to KNOWN skill IDs). Every free-text field the breeding tool
//      stores (names, notes, timestamps, white-skill *names*) is discarded.
//   3) a star rating  -> integer 1..5
// Unknown keys are dropped; structural violations are rejected.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

module.exports = function horseshare(db, accountFromReq) {
    const ROOT = __dirname;

    const SLOTS = ["foal", "p1", "p2", "gp11", "gp12", "gp21", "gp22"];
    const STAT_KEYS = ["speed", "stamina", "power", "guts", "wit"];
    const APT_KEYS = [
        "turf", "dirt", "short", "mile", "medium",
        "long", "front", "pace", "late", "end",
    ];
    const MAX_POSTS_PER_ACCOUNT = 50;
    const MAX_WHITE = 40;
    const MAX_STAR = 9;
    const ID_RE = /^\d{1,7}$/;

    // white-skill name <-> canonical numeric id (name never stored; id->name used
    // for server-side skill-name filtering).
    const SKILL_ID_BY_NAME = new Map();
    const SKILL_NAME_BY_ID = new Map();
    (() => {
        try {
            const skills = JSON.parse(
                fs.readFileSync(path.join(ROOT, "data", "skills.json"), "utf8"),
            );
            for (const s of skills) {
                if (s && s.name != null && s.id != null) {
                    SKILL_ID_BY_NAME.set(normName(s.name), String(s.id));
                    SKILL_NAME_BY_ID.set(String(s.id), normName(s.name));
                }
            }
        } catch (e) {
            /* no skills data -> white skills won't resolve */
        }
    })();

    function normName(s) {
        return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    // fixed G1 race catalog (mirrors pakadb.js) — white RACE sparks resolve here,
    // since race names never appear in skills.json.
    const RACES = [
        ["Asahi Hai Futurity Stakes", 1022], ["Hanshin Juvenile Fillies", 1021],
        ["Hopeful Stakes", 1024], ["Oka Sho", 1004], ["Satsuki Sho", 1005],
        ["NHK Mile Cup", 1007], ["Japanese Oaks", 1009],
        ["Tokyo Yushun (Japanese Derby)", 1010], ["Yasuda Kinen", 1011],
        ["Takarazuka Kinen", 1012], ["Japan Dirt Derby", 1102],
        ["Sprinters Stakes", 1013], ["Kikuka Sho", 1015], ["Shuka Sho", 1014],
        ["Tenno Sho (Autumn)", 1016], ["JBC Classic", 1105],
        ["JBC Ladies' Classic", 1103], ["JBC Sprint", 1104],
        ["Queen Elizabeth II Cup", 1017], ["Japan Cup", 1019],
        ["Mile Championship", 1018], ["Champions Cup", 1020],
        ["Arima Kinen", 1023], ["Tokyo Daishoten", 1106],
        ["February Stakes", 1001], ["Osaka Hai", 1003],
        ["Takamatsunomiya Kinen", 1002], ["Tenno Sho (Spring)", 1006],
        ["Victoria Mile", 1008], ["Teio Sho", 1101],
    ];
    const RACE_ID_BY_NAME = new Map(RACES.map((r) => [normName(r[0]), String(r[1])]));
    const RACE_IDS = new Set(RACES.map((r) => String(r[1])));

    db.exec(`
    CREATE TABLE IF NOT EXISTS pakadb_horse_posts (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      trainer_id TEXT NOT NULL,
      horse      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pakadb_horse_ratings (
      post_id    TEXT NOT NULL,
      account_id TEXT NOT NULL,
      stars      INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (post_id, account_id)
    );
  `);

    // ---------------- validation ----------------
    class ValidationError extends Error {}

    function vTrainerId(raw) {
        const digits = String(raw == null ? "" : raw).replace(/\D/g, "");
        if (digits.length !== 12) {
            throw new ValidationError("trainer ID must be exactly 12 digits");
        }
        return digits;
    }
    function vNumId(x) {
        const s = String(x == null ? "" : x);
        return ID_RE.test(s) ? s : null;
    }
    function vStar(x) {
        const n = Number(x);
        if (!Number.isInteger(n) || n <= 0) return 0;
        return n > MAX_STAR ? MAX_STAR : n;
    }
    function vRatingStars(x) {
        const n = Number(x);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
            throw new ValidationError("rating must be 1–5 stars");
        }
        return n;
    }
    function vSpark(sp) {
        if (!sp || typeof sp !== "object") return null;
        const out = {};
        const blue = {};
        for (const k of STAT_KEYS) { const v = vStar(sp.blue && sp.blue[k]); if (v) blue[k] = v; }
        if (Object.keys(blue).length) out.blue = blue;
        const pink = {};
        for (const k of APT_KEYS) { const v = vStar(sp.pink && sp.pink[k]); if (v) pink[k] = v; }
        if (Object.keys(pink).length) out.pink = pink;
        const green = vStar(sp.green);
        if (green) out.green = green;
        if (Array.isArray(sp.white)) {
            const white = [];
            for (const w of sp.white.slice(0, MAX_WHITE)) {
                if (!w || typeof w !== "object") continue;
                const lvl = vStar(w.lvl);
                if (!lvl) continue;
                let entry = null;
                // resolve by name first (authoritative): a G1 race, else a skill
                if (w.name != null) {
                    const rid = RACE_ID_BY_NAME.get(normName(w.name));
                    if (rid) entry = { kind: "race", id: rid, lvl };
                    else {
                        const sid = SKILL_ID_BY_NAME.get(normName(w.name));
                        if (sid) entry = { kind: "skill", id: sid, lvl };
                    }
                }
                // fallback: an already-normalized {kind,id} payload
                if (!entry) {
                    const id = vNumId(w.id);
                    if (id && w.kind === "race" && RACE_IDS.has(id)) entry = { kind: "race", id, lvl };
                    else if (id && (w.kind === "skill" || w.kind == null)) entry = { kind: "skill", id, lvl };
                }
                if (entry) white.push(entry);
            }
            if (white.length) out.white = white;
        }
        return Object.keys(out).length ? out : null;
    }
    function vHorse(h) {
        if (!h || typeof h !== "object") throw new ValidationError("horse must be an object");
        const slots = {};
        const src = h.slots || {};
        for (const k of SLOTS) { const id = vNumId(src[k]); if (id) slots[k] = id; }
        if (!slots.foal) throw new ValidationError("the horse needs a foal");
        const sparks = {};
        const sp = h.sparks || {};
        for (const k of SLOTS) { if (sp[k] == null) continue; const v = vSpark(sp[k]); if (v) sparks[k] = v; }
        const cards = {};
        const cd = h.cards || {};
        for (const k of SLOTS) { if (!slots[k]) continue; const id = vNumId(cd[k]); if (id) cards[k] = id; }
        return { slots, sparks, cards };
    }

    // ---------------- http helpers ----------------
    function sendJson(res, obj, code = 200) {
        res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(obj));
    }
    function readBody(req, cb) {
        let d = "";
        req.on("data", (c) => { d += c; if (d.length > 1e6) req.destroy(); });
        req.on("end", () => cb(d));
    }

    // ---------------- feed (server-side filtering) ----------------
    const FEED_LIMIT = 200;

    // reduce a horse to the facets we filter on
    function horseFacets(horse) {
        const stats = {}, apts = {}, races = new Set(), skills = [];
        let green = false, anc = 0;
        const slots = horse.slots || {};
        const umaIds = new Set();
        for (const s of SLOTS) {
            if (slots[s] != null) {
                umaIds.add(String(slots[s]));
                if (s !== "foal") anc++;
            }
        }
        const sp = horse.sparks || {};
        for (const k of Object.keys(sp)) {
            const b = sp[k]; if (!b) continue;
            if (b.blue) for (const kk of Object.keys(b.blue)) stats[kk] = 1;
            if (b.pink) for (const kk of Object.keys(b.pink)) apts[kk] = 1;
            if (b.green) green = true;
            if (b.white) for (const w of b.white) {
                if (w.kind === "race") races.add(String(w.id));
                else skills.push(SKILL_NAME_BY_ID.get(String(w.id)) || "");
            }
        }
        return { stats, apts, races, skills, green, anc, umaIds };
    }

    function passesFilter(horse, avg, owner, F) {
        if (F.minRating && avg < F.minRating) return false;
        if (F.owner && normName(owner).indexOf(F.owner) < 0) return false;
        const fx = horseFacets(horse);
        if (F.uma && !fx.umaIds.has(F.uma)) return false;
        if (F.green && !fx.green) return false;
        if (F.race && !fx.races.has(F.race)) return false;
        if (F.minAnc && fx.anc < F.minAnc) return false;
        for (const k of F.stats) if (!fx.stats[k]) return false;
        for (const k of F.apts) if (!fx.apts[k]) return false;
        if (F.skill && !fx.skills.some((n) => n && n.indexOf(F.skill) >= 0)) return false;
        return true;
    }

    function buildFeed(viewerId, F) {
        const rows = db
            .prepare(
                `SELECT p.id, p.account_id, p.trainer_id, p.horse, p.created_at,
                        a.name AS owner,
                        COALESCE(AVG(r.stars), 0) AS avg,
                        COUNT(r.stars) AS cnt
                 FROM pakadb_horse_posts p
                 JOIN accounts a ON a.id = p.account_id
                 LEFT JOIN pakadb_horse_ratings r ON r.post_id = p.id
                 GROUP BY p.id`,
            )
            .all();

        let mine = {};
        if (viewerId) {
            const mr = db
                .prepare("SELECT post_id, stars FROM pakadb_horse_ratings WHERE account_id = ?")
                .all(viewerId);
            mr.forEach((r) => { mine[r.post_id] = r.stars; });
        }

        let list = rows.map((r) => ({ r, avg: Math.round(r.avg * 10) / 10, horse: JSON.parse(r.horse) }));
        list = list.filter((x) => passesFilter(x.horse, x.avg, x.r.owner, F));

        const sort = F.sort;
        if (sort === "old") list.sort((a, b) => (a.r.created_at < b.r.created_at ? -1 : a.r.created_at > b.r.created_at ? 1 : 0));
        else if (sort === "top") list.sort((a, b) => b.avg - a.avg || b.r.cnt - a.r.cnt);
        else if (sort === "mostrated") list.sort((a, b) => b.r.cnt - a.r.cnt || b.avg - a.avg);
        else list.sort((a, b) => (a.r.created_at < b.r.created_at ? 1 : a.r.created_at > b.r.created_at ? -1 : 0)); // new

        return list.slice(0, FEED_LIMIT).map((x) => ({
            id: x.r.id,
            owner: x.r.owner,
            trainerId: x.r.trainer_id,
            horse: x.horse,
            avg: x.avg,
            count: x.r.cnt,
            createdAt: x.r.created_at,
            mine: viewerId != null && x.r.account_id === viewerId,
            myRating: mine[x.r.id] || 0,
        }));
    }

    // parse ?params into a normalized filter object
    function parseFilter(sp) {
        const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
        return {
            uma: (sp.get("uma") || "").replace(/[^0-9]/g, ""),
            owner: normName(sp.get("owner") || ""),
            skill: normName(sp.get("skill") || ""),
            sort: ["new", "old", "top", "mostrated"].indexOf(sp.get("sort")) >= 0 ? sp.get("sort") : "new",
            minRating: Math.max(0, Math.min(5, Number(sp.get("minRating")) || 0)),
            stats: csv(sp.get("stats")).filter((k) => STAT_KEYS.indexOf(k) >= 0),
            apts: csv(sp.get("apts")).filter((k) => APT_KEYS.indexOf(k) >= 0),
            green: sp.get("green") === "1",
            race: RACE_IDS.has(sp.get("race") || "") ? sp.get("race") : "",
            minAnc: Math.max(0, Math.min(6, Number(sp.get("minAnc")) || 0)),
        };
    }

    function postById(id) {
        return db
            .prepare("SELECT id, account_id FROM pakadb_horse_posts WHERE id = ?")
            .get(id);
    }

    // ---------------- router ----------------
    return {
        handle(req, res, url) {
            const sub = url.pathname.slice("/api/pakadb/horseshare".length);
            const account = accountFromReq(req);

            // public feed (server-side filtering via query params)
            if (sub === "/feed" && req.method === "GET") {
                return sendJson(res, {
                    account: account ? { name: account.name } : null,
                    posts: buildFeed(account ? account.id : null, parseFilter(url.searchParams)),
                });
            }

            // everything else needs the pakadle account
            if (!account) {
                return sendJson(res, { error: "Log in with your Pakadle account." }, 401);
            }

            // create a post
            if (sub === "/posts" && req.method === "POST") {
                return readBody(req, (raw) => {
                    let body;
                    try { body = JSON.parse(raw || "{}"); } catch { return sendJson(res, { error: "bad json" }, 400); }
                    let trainerId, horse;
                    try {
                        trainerId = vTrainerId(body.trainerId);
                        horse = vHorse(body.horse);
                    } catch (e) {
                        if (e instanceof ValidationError) return sendJson(res, { error: e.message }, 400);
                        return sendJson(res, { error: "invalid" }, 400);
                    }
                    const n = db
                        .prepare("SELECT COUNT(*) AS c FROM pakadb_horse_posts WHERE account_id = ?")
                        .get(account.id).c;
                    if (n >= MAX_POSTS_PER_ACCOUNT) {
                        return sendJson(res, { error: "You've reached the max of " + MAX_POSTS_PER_ACCOUNT + " posts." }, 400);
                    }
                    db.prepare(
                        "INSERT INTO pakadb_horse_posts (id, account_id, trainer_id, horse, created_at) VALUES (?, ?, ?, ?, ?)",
                    ).run(crypto.randomUUID(), account.id, trainerId, JSON.stringify(horse), new Date().toISOString());
                    return sendJson(res, { ok: true });
                });
            }

            // rate a post 1–5
            const mRate = sub.match(/^\/posts\/([A-Za-z0-9-]+)\/rate$/);
            if (mRate && req.method === "POST") {
                return readBody(req, (raw) => {
                    let body;
                    try { body = JSON.parse(raw || "{}"); } catch { return sendJson(res, { error: "bad json" }, 400); }
                    const post = postById(mRate[1]);
                    if (!post) return sendJson(res, { error: "post not found" }, 404);
                    if (post.account_id === account.id) {
                        return sendJson(res, { error: "You can't rate your own horse." }, 400);
                    }
                    let stars;
                    try { stars = vRatingStars(body.stars); } catch (e) { return sendJson(res, { error: e.message }, 400); }
                    db.prepare(
                        `INSERT INTO pakadb_horse_ratings (post_id, account_id, stars, updated_at)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(post_id, account_id) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at`,
                    ).run(post.id, account.id, stars, new Date().toISOString());
                    return sendJson(res, { ok: true });
                });
            }

            // delete your own post
            const mDel = sub.match(/^\/posts\/([A-Za-z0-9-]+)$/);
            if (mDel && req.method === "DELETE") {
                const post = postById(mDel[1]);
                if (!post) return sendJson(res, { error: "post not found" }, 404);
                if (post.account_id !== account.id) {
                    return sendJson(res, { error: "Not your post." }, 403);
                }
                db.prepare("DELETE FROM pakadb_horse_ratings WHERE post_id = ?").run(post.id);
                db.prepare("DELETE FROM pakadb_horse_posts WHERE id = ?").run(post.id);
                return sendJson(res, { ok: true });
            }

            res.writeHead(404);
            res.end("not found");
        },
    };
};
