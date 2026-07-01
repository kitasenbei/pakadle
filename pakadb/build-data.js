// PakaDB data ingestion: pulls rich Umamusume data from gametora's public
// /data store and normalizes it into local JSON + self-hosted portraits.
//
// This is a BUILD-TIME tool, run manually to refresh the dataset. The Pakadle
// server never talks to gametora at runtime; it only reads pakadb/data/*.json.
// Deliberately kept separate from words.js (the Pakadle puzzle roster).
//
//   run:  node pakadb/build-data.js
//         node pakadb/build-data.js --no-images   (data only, skip portraits)
//
// Source: gametora.com single-page app data files, indexed by a manifest that
// maps each data file to a content hash. We resolve the manifest fresh on every
// run so we survive gametora rebuilds.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HOST = "https://gametora.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125 Safari/537.36";
const DIR = __dirname;
const DATA_DIR = path.join(DIR, "data");
const RAW_DIR = path.join(DATA_DIR, "raw");
const IMG_DIR = path.join(DIR, "assets", "uma");
const ICON_DIR = path.join(DIR, "assets", "skill_icons");

const SKIP_IMAGES = process.argv.includes("--no-images");

// Field orders used across gametora's arrays.
const APT = ["turf", "dirt", "short", "mile", "medium", "long", "front", "pace", "late", "end"];
const STATS = ["speed", "stamina", "power", "guts", "wit"];

function log(...a) { console.log(...a); }

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

async function getBuffer(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  log(`  wrote ${path.relative(DIR, file)} (${fs.statSync(file).size.toLocaleString()} bytes)`);
}

// Map a 10-length aptitude grade array into a labeled, grouped object.
function mapAptitude(arr) {
  const g = {};
  APT.forEach((k, i) => { g[k] = arr[i]; });
  return {
    surface: { turf: g.turf, dirt: g.dirt },
    distance: { short: g.short, mile: g.mile, medium: g.medium, long: g.long },
    style: { front: g.front, pace: g.pace, late: g.late, end: g.end },
  };
}

function mapStats(arr) {
  if (!arr) return null;
  const o = {};
  STATS.forEach((k, i) => { o[k] = arr[i]; });
  return o;
}

async function main() {
  mkdirp(RAW_DIR);
  if (!SKIP_IMAGES) mkdirp(IMG_DIR);

  log("1/5  Fetching data manifest…");
  const manifest = await getJSON(`${HOST}/data/manifests/umamusume.json`);
  const ver = (name) => {
    const v = manifest[name];
    if (!v) throw new Error(`manifest missing "${name}"`);
    return v;
  };
  const dataUrl = (name) => `${HOST}/data/umamusume/${name}.${ver(name)}.json`;

  log("2/5  Fetching source data files…");
  const [characters, cards, skills, succRelation, succMember] = await Promise.all([
    getJSON(dataUrl("characters")),
    getJSON(dataUrl("character-cards")),
    getJSON(dataUrl("skills")),
    getJSON(dataUrl("db-files/succession_relation")),
    getJSON(dataUrl("db-files/succession_relation_member")),
  ]);
  log(`     characters=${characters.length} cards=${cards.length} skills=${skills.length} ` +
      `succession=${succRelation.length} members=${succMember.length}`);

  // Persist raw source of truth so we never need to re-scrape to rebuild.
  writeJSON(path.join(RAW_DIR, "manifest.json"), manifest);
  writeJSON(path.join(RAW_DIR, "characters.json"), characters);
  writeJSON(path.join(RAW_DIR, "character-cards.json"), cards);
  writeJSON(path.join(RAW_DIR, "skills.json"), skills);
  writeJSON(path.join(RAW_DIR, "succession_relation.json"), succRelation);
  writeJSON(path.join(RAW_DIR, "succession_relation_member.json"), succMember);

  log("3/5  Building lookups…");
  // skill id -> compact record
  const skillById = new Map();
  for (const s of skills) {
    skillById.set(s.id, {
      id: s.id,
      name: s.name_en || s.enname || s.jpname || String(s.id),
      desc: s.endesc || s.desc_en || "",
      rarity: s.rarity,
      type: s.type,
      iconId: s.iconid,
    });
  }
  const resolve = (ids) => (ids || []).map((id) => skillById.get(id) || { id, name: `#${id}`, desc: "" });
  const resolveEvo = (arr) => (arr || []).map((e) => ({
    old: skillById.get(e.old) || { id: e.old },
    new: skillById.get(e.new) || { id: e.new },
  }));

  // representative (original) card per char_id = smallest card_id
  // all cards per character (sorted; lowest card_id = the original/base outfit)
  const cardsByChar = new Map();
  for (const c of cards) {
    if (!cardsByChar.has(c.char_id)) cardsByChar.set(c.char_id, []);
    cardsByChar.get(c.char_id).push(c);
  }
  for (const list of cardsByChar.values()) list.sort((a, b) => a.card_id - b.card_id);

  // one card (outfit) -> normalized object; portraits keyed by costume id
  const cardObj = (card) => ({
    cardId: card.card_id,
    tid: card.tid,
    title: card.title || null,
    costume: card.costume,
    rarity: card.rarity,
    obtained: card.obtained || null,
    image: `assets/uma/${card.card_id}.png`,
    thumb: `assets/uma/${card.card_id}_thumb.png`,
    statsBase: mapStats(card.base_stats),
    statsMax: mapStats(card.five_star_stats || card.four_star_stats),
    growth: mapStats(card.stat_bonus),
    aptitude: mapAptitude(card.aptitude),
    skills: {
      unique: resolve(card.skills_unique),
      innate: resolve(card.skills_innate),
      awakening: resolve(card.skills_awakening),
      event: resolve(card.skills_event),
      evo: resolveEvo(card.skills_evo),
    },
  });

  // breeding: char -> relation_types, and relation_type -> points
  const relationPoints = {};
  for (const r of succRelation) relationPoints[r.relation_type] = r.relation_point;
  const members = {};
  for (const m of succMember) {
    (members[m.chara_id] = members[m.chara_id] || []).push(m.relation_type);
  }

  log("4/5  Normalizing playable equines…");
  // Playable equines only: excludes trainers/humans and manga/anime/founding-sire
  // NPCs (all in the 9xxx range) and mob umas (2xxx, which are not playable).
  const playable = characters
    .filter((c) => c.playable === true && c.char_id < 9000)
    .sort((a, b) => (a.en_name || "").localeCompare(b.en_name || ""));

  const umas = [];
  const costumes = new Set(); // (char_id, costume) portraits to fetch
  for (const c of playable) {
    const list = cardsByChar.get(c.char_id);
    if (!list || !list.length) { log(`     ! no card for ${c.char_id} ${c.en_name}, skipping`); continue; }

    const alts = list.map(cardObj);            // every outfit, base first
    const base = alts[0];
    list.forEach((card) => costumes.add(c.char_id + "|" + card.card_id));

    umas.push({
      id: c.char_id,
      name: c.en_name,
      nameJp: c.jp_name,
      urlName: list[0].url_name,
      bio: {
        birthday: (c.birth_year || c.birth_month || c.birth_day)
          ? { year: c.birth_year || null, month: c.birth_month || null, day: c.birth_day || null } : null,
        height: c.height || null,
        sex: c.sex,
        threeSizes: c.three_sizes || null,
        vaJa: c.va_ja || null,
        vaEn: c.va_en || null,
        realLife: c.rl || null,
      },
      // base outfit surfaced at the top level (grid, breeding, default drawer)
      cardId: base.cardId,
      title: base.title,
      rarity: base.rarity,
      image: base.image,
      thumb: base.thumb,
      statsBase: base.statsBase,
      statsMax: base.statsMax,
      growth: base.growth,
      aptitude: base.aptitude,
      skills: base.skills,
      alts: alts,                              // full outfit list (includes base)
      relationTypes: members[c.char_id] || [],
    });
  }

  const altTotal = umas.reduce((s, u) => s + u.alts.length, 0);
  writeJSON(path.join(DATA_DIR, "umas.json"), umas);
  writeJSON(path.join(DATA_DIR, "skills.json"), Array.from(skillById.values()));
  writeJSON(path.join(DATA_DIR, "breeding.json"), { relationPoints, members });
  log(`     normalized ${umas.length} playable equines (${altTotal} outfits incl. alts)`);

  if (SKIP_IMAGES) { log("5/5  Skipping images (--no-images)."); return; }

  const jobs = Array.from(costumes).map((k) => { const p = k.split("|"); return { charId: p[0], cardId: p[1] }; });
  log(`5/5  Downloading portraits (${jobs.length} outfits)…`);
  let ok = 0, skipped = 0, failed = 0;
  for (const j of jobs) {
    const full = `${HOST}/images/umamusume/characters/chara_stand_${j.charId}_${j.cardId}.png`;
    const thumb = `${HOST}/images/umamusume/characters/thumb/chara_stand_${j.charId}_${j.cardId}.png`;
    const fullPath = path.join(IMG_DIR, `${j.cardId}.png`);
    const thumbPath = path.join(IMG_DIR, `${j.cardId}_thumb.png`);
    if (fs.existsSync(fullPath) && fs.existsSync(thumbPath)) { skipped++; continue; }
    try {
      if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, await getBuffer(full));
      if (!fs.existsSync(thumbPath)) fs.writeFileSync(thumbPath, await getBuffer(thumb));
      ok++;
      if (ok % 30 === 0) log(`     …${ok} downloaded`);
    } catch (e) {
      failed++;
      log(`     ! card ${j.cardId}: ${e.message}`);
    }
  }
  log(`     portraits: ${ok} downloaded, ${skipped} already present, ${failed} failed`);

  // skill icons (small set of shared icons, keyed by iconId)
  mkdirp(ICON_DIR);
  var iconIds = Array.from(new Set(skills.map((s) => s.iconid).filter(Boolean)));
  log(`     downloading ${iconIds.length} skill icons…`);
  let iok = 0, iskip = 0, ifail = 0;
  for (const iid of iconIds) {
    const dest = path.join(ICON_DIR, iid + ".png");
    if (fs.existsSync(dest)) { iskip++; continue; }
    try {
      fs.writeFileSync(dest, await getBuffer(`${HOST}/images/umamusume/skill_icons/utx_ico_skill_${iid}.png`));
      iok++;
    } catch (e) { ifail++; log(`     ! skill icon ${iid}: ${e.message}`); }
  }
  log(`     skill icons: ${iok} downloaded, ${iskip} already present, ${ifail} failed`);

  // stat icons (Speed/Stamina/Power/Guts/Wit): sourced from game8 (gametora renders
  // these via CSS/SVG, so no clean asset URL). Fixed set, rarely changes.
  const STAT_ICON_DIR = path.join(DIR, "assets", "stat_icons");
  mkdirp(STAT_ICON_DIR);
  const STAT_ICONS = {
    speed: "https://img.game8.co/4215860/6dd970fab835ef46f73bd46253ca2d70.png/show",
    stamina: "https://img.game8.co/4215861/da59c92924fdef527d5bd04184ff87c7.png/show",
    power: "https://img.game8.co/4215858/c83b8057c62356630b3bd293e272354b.png/show",
    guts: "https://img.game8.co/4215859/b02b8c92b20c8e3026c5bc2e7f02fcf7.png/show",
    wit: "https://img.game8.co/4215862/63bcaa618b84baf84439e9a2fe65fb87.png/show",
  };
  let sok = 0;
  for (const k of Object.keys(STAT_ICONS)) {
    const dest = path.join(STAT_ICON_DIR, k + ".png");
    if (fs.existsSync(dest)) { continue; }
    try { fs.writeFileSync(dest, await getBuffer(STAT_ICONS[k])); sok++; }
    catch (e) { log(`     ! stat icon ${k}: ${e.message}`); }
  }
  log(`     stat icons: ${sok} downloaded`);
  log("Done.");
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
