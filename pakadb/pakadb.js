/* PakaDB control panel: renders the gametora-sourced dataset (pakadb/data/umas.json).
   Read-only character DB today; the scaffolding (breeding.json) is in place for the
   breeding tool to layer on later. Vanilla JS, no deps. */
(function () {
  "use strict";

  var GRADES = ["S", "A", "B", "C", "D", "E", "F", "G"];
  var GRANK = {}; GRADES.forEach(function (g, i) { GRANK[g] = GRADES.length - i; });
  var STAT_KEYS = ["speed", "stamina", "power", "guts", "wit"];
  var STAT_NAME = { speed: "Speed", stamina: "Stamina", power: "Power", guts: "Guts", wit: "Wit" };
  var STAT_NAME = { speed: "Speed", stamina: "Stamina", power: "Power", guts: "Guts", wit: "Wit" };

  var $ = function (id) { return document.getElementById(id); };
  // show/hide with CSS animations: opening plays the element's own keyframe;
  // closing adds .anim-out, then hides once the animation finishes.
  function showEl(el) { el.classList.remove("anim-out"); el.hidden = false; }
  function hideEl(el) {
    if (el.hidden) return;
    el.classList.add("anim-out");
    var done = function () { el.hidden = true; el.classList.remove("anim-out"); el.removeEventListener("animationend", done); clearTimeout(t); };
    var t = setTimeout(done, 240);
    el.addEventListener("animationend", done);
  }
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function gradeCls(g) { return "g-" + (g && GRANK[g] ? g : "null"); }
  function gradeTxt(g) { return g && GRANK[g] ? g : "-"; }

  var UMAS = [];
  var SKILL_INDEX = [];   // unique skills across the roster, for the skill filter picker
  var ALL_SKILLS = [];    // full skill catalog (skills.json) for the white-spark picker
  var WHITE_CATALOG = []; // deduped {name, iconId} skill list, sorted
  var WHITE_ICON = {};    // name -> iconId across the full catalog
  var BYID = {};
  var BREED = { relationPoints: {}, members: {} };
  // white RACE sparks: fixed G1 catalog, each with its self-hosted banner id
  // (banner art mirrored from gametora into assets/races/{id}.png)
  var RACES = [
    { name: "Asahi Hai Futurity Stakes", id: 1022 }, { name: "Hanshin Juvenile Fillies", id: 1021 },
    { name: "Hopeful Stakes", id: 1024 }, { name: "Oka Sho", id: 1004 }, { name: "Satsuki Sho", id: 1005 },
    { name: "NHK Mile Cup", id: 1007 }, { name: "Japanese Oaks", id: 1009 },
    { name: "Tokyo Yushun (Japanese Derby)", id: 1010 }, { name: "Yasuda Kinen", id: 1011 },
    { name: "Takarazuka Kinen", id: 1012 }, { name: "Japan Dirt Derby", id: 1102 },
    { name: "Sprinters Stakes", id: 1013 }, { name: "Kikuka Sho", id: 1015 }, { name: "Shuka Sho", id: 1014 },
    { name: "Tenno Sho (Autumn)", id: 1016 }, { name: "JBC Classic", id: 1105 },
    { name: "JBC Ladies' Classic", id: 1103 }, { name: "JBC Sprint", id: 1104 },
    { name: "Queen Elizabeth II Cup", id: 1017 }, { name: "Japan Cup", id: 1019 },
    { name: "Mile Championship", id: 1018 }, { name: "Champions Cup", id: 1020 },
    { name: "Arima Kinen", id: 1023 }, { name: "Tokyo Daishoten", id: 1106 },
    { name: "February Stakes", id: 1001 }, { name: "Osaka Hai", id: 1003 },
    { name: "Takamatsunomiya Kinen", id: 1002 }, { name: "Tenno Sho (Spring)", id: 1006 },
    { name: "Victoria Mile", id: 1008 }, { name: "Teio Sho", id: 1101 },
  ];
  var RACE_BANNER = {}; RACES.forEach(function (r) { RACE_BANNER[r.name] = r.id; });
  function raceBannerImg(id, cls) {
    return '<img class="' + (cls || "wp-banner") + '" loading="lazy" src="/pakadb/assets/races/' + id + '.png" alt="" />';
  }
  var STATMAX = { speed: 1, stamina: 1, power: 1, guts: 1, wit: 1 };
  // filter state: aptMin[key]=grade (require >=), rarity[] set, growth[] stats,
  // statMin{stat:n}, skill substring.
  var state = { q: "", sort: "name", advOpen: false, aptMin: {}, rarity: [], growth: [], statMin: {}, skills: [] };

  // aptitude groups (cat + [key,label]); keys are unique across groups.
  var APT_DEFS = [
    { label: "SURFACE", cat: "surface", keys: [["turf", "Turf"], ["dirt", "Dirt"]] },
    { label: "DISTANCE", cat: "distance", keys: [["short", "Sprint"], ["mile", "Mile"], ["medium", "Medium"], ["long", "Long"]] },
    { label: "STYLE", cat: "style", keys: [["front", "Front"], ["pace", "Pace"], ["late", "Late"], ["end", "End"]] },
  ];
  var KEY_CAT = {}; APT_DEFS.forEach(function (g) { g.keys.forEach(function (k) { KEY_CAT[k[0]] = g.cat; }); });
  var KEY_LABEL = {}; APT_DEFS.forEach(function (g) { g.keys.forEach(function (k) { KEY_LABEL[k[0]] = k[1]; }); });
  var GRADE_OPTS = ["S", "A", "B", "C", "D"]; // selectable minimum grades
  function aptGrade(u, key) { var c = KEY_CAT[key]; return u.aptitude && u.aptitude[c] && u.aptitude[c][key]; }
  function buildSkillIndex() {
    var seen = {};
    function add(sk) { if (!sk || !sk.name || seen[sk.name]) return; seen[sk.name] = 1; SKILL_INDEX.push({ name: sk.name, iconId: sk.iconId }); }
    UMAS.forEach(function (u) {
      var s = u.skills || {};
      ["unique", "innate", "awakening", "event"].forEach(function (g) { (s[g] || []).forEach(add); });
      (s.evo || []).forEach(function (e) { if (e.new) add(e.new); if (e.old) add(e.old); });
    });
    SKILL_INDEX.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  // full skill catalog (skills.json, falling back to the uma-derived index) for white sparks
  function buildWhiteCatalog() {
    WHITE_CATALOG = []; WHITE_ICON = {};
    var seen = {};
    function add(name, iconId) {
      if (!name || seen[name]) return; seen[name] = 1;
      if (iconId) WHITE_ICON[name] = iconId;
      WHITE_CATALOG.push({ name: name, iconId: iconId || null });
    }
    ALL_SKILLS.forEach(function (s) { add(s.name, s.iconId); });
    SKILL_INDEX.forEach(function (s) { add(s.name, s.iconId); });   // safety net if skills.json failed
    WHITE_CATALOG.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function umaSkillNames(u) {
    var s = u.skills || {}, out = [];
    ["unique", "innate", "awakening", "event"].forEach(function (g) { (s[g] || []).forEach(function (x) { out.push(x.name); }); });
    (s.evo || []).forEach(function (e) { if (e.new) out.push(e.new.name); if (e.old) out.push(e.old.name); });
    return out.join(" ").toLowerCase();
  }

  function load() {
    Promise.all([
      fetch("/pakadb/data/umas.json").then(function (r) { if (!r.ok) throw new Error("umas " + r.status); return r.json(); }),
      fetch("/pakadb/data/breeding.json").then(function (r) { return r.ok ? r.json() : { relationPoints: {}, members: {} }; }),
      fetch("/pakadb/data/skills.json").then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
    ]).then(function (res) {
      UMAS = res[0]; BREED = res[1] || BREED; ALL_SKILLS = res[2] || [];
      BYID = {}; UMAS.forEach(function (u) { BYID[u.id] = u; });
      STAT_KEYS.forEach(function (k) {
        STATMAX[k] = UMAS.reduce(function (m, u) { return Math.max(m, (u.statsMax && u.statsMax[k]) || 0); }, 1);
      });
      buildSkillIndex();
      buildWhiteCatalog();
      buildFilters();
      render();
    }).catch(function (e) {
      $("cp-grid").innerHTML = "";
      var p = $("cp-empty"); p.hidden = false; p.textContent = "DATA LOAD FAILED: " + e.message;
    });
  }

  function buildFilters() {
    // quick rail: SURFACE/DIST/STYLE A+ chips + ADVANCED toggle + CLEAR
    var quick = APT_DEFS.map(function (grp) {
      var chips = grp.keys.map(function (k) {
        return '<button class="chip" data-quick="' + k[0] + '">' + k[1].toUpperCase() + "</button>";
      }).join("");
      return '<div class="fgroup"><span class="fgroup-l">' + grp.label + "</span>" + chips + "</div>";
    }).join("");
    $("cp-filters").innerHTML = quick +
      '<button class="chip adv-toggle" id="cp-adv-toggle" style="margin-left:auto">ADVANCED <span class="pd-dd-caret" style="display:inline-block;vertical-align:middle;margin-left:4px"></span></button>' +
      '<button class="chip" id="cp-clear">CLEAR</button>';
    buildAdvanced();
    syncFilterUI();
  }

  function gradeBtns(key) {
    return GRADE_OPTS.map(function (g) {
      return '<button class="adv-g v-' + g + '" data-apt="' + key + '" data-grade="' + g + '">' + g + "+</button>";
    }).join("");
  }

  function buildAdvanced() {
    var apt = APT_DEFS.map(function (grp) {
      var rows = grp.keys.map(function (k) {
        return '<div class="adv-row"><span class="adv-k">' + k[1] + '</span><div class="adv-gset">' + gradeBtns(k[0]) + "</div></div>";
      }).join("");
      return '<div class="adv-sub"><div class="adv-sub-h">' + grp.label + " APTITUDE</div>" + rows + "</div>";
    }).join("");
    var rarity = [3, 2, 1].map(function (r) {
      return '<button class="chip" data-rarity="' + r + '">' + "★".repeat(r) + "</button>";
    }).join("");
    var growth = STAT_KEYS.map(function (k) {
      return '<button class="chip" data-growth="' + k + '">' + STAT_NAME[k] + " +</button>";
    }).join("");
    var statMin = STAT_KEYS.map(function (k) {
      var v = state.statMin[k] || "";
      return '<div class="adv-num"><span>' + STAT_NAME[k] + " ≥</span>" +
        '<div class="numc">' +
          '<button class="numc-btn" type="button" data-step="-5" data-stat="' + k + '" aria-label="decrease">−</button>' +
          '<input class="numc-val" type="text" inputmode="numeric" data-statmin="' + k + '" value="' + v + '" placeholder="' + STATMAX[k] + '" />' +
          '<button class="numc-btn" type="button" data-step="5" data-stat="' + k + '" aria-label="increase">+</button>' +
        "</div></div>";
    }).join("");
    $("cp-adv").innerHTML =
      apt +
      '<div class="adv-sub"><div class="adv-sub-h">RARITY</div><div class="adv-chips">' + rarity + "</div></div>" +
      '<div class="adv-sub"><div class="adv-sub-h">GROWTH BONUS</div><div class="adv-chips">' + growth + "</div></div>" +
      '<div class="adv-sub"><div class="adv-sub-h">MIN STAT (5★ base)</div><div class="adv-nums">' + statMin + "</div></div>" +
      '<div class="adv-sub"><div class="adv-sub-h">SKILL</div>' +
        '<button id="cp-skill-trigger" class="skill-trigger' + (state.skills.length ? " on" : "") + '">' +
          esc(skillTriggerLabel()) + "</button></div>";
  }

  // reflect state onto controls (on/off + selected grade)
  function syncFilterUI() {
    $("cp-adv").hidden = !state.advOpen;
    $("cp-adv-toggle").classList.toggle("on", state.advOpen);
    // quick chips: on when that aptitude has any min set
    Array.prototype.forEach.call(document.querySelectorAll("[data-quick]"), function (b) {
      b.classList.toggle("on", !!state.aptMin[b.getAttribute("data-quick")]);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".adv-g"), function (b) {
      b.classList.toggle("on", state.aptMin[b.getAttribute("data-apt")] === b.getAttribute("data-grade"));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-rarity]"), function (b) {
      b.classList.toggle("on", state.rarity.indexOf(Number(b.getAttribute("data-rarity"))) >= 0);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-growth]"), function (b) {
      b.classList.toggle("on", state.growth.indexOf(b.getAttribute("data-growth")) >= 0);
    });
  }

  function clearFilters() {
    state.aptMin = {}; state.rarity = []; state.growth = []; state.statMin = {}; state.skills = [];
    Array.prototype.forEach.call(document.querySelectorAll("[data-statmin]"), function (i) { i.value = ""; });
    updateSkillTrigger();
    syncFilterUI(); render();
  }

  function passes(u) {
    if (state.q && u.name.toLowerCase().indexOf(state.q) === -1) return false;
    for (var key in state.aptMin) {
      if (!(GRANK[aptGrade(u, key)] >= GRANK[state.aptMin[key]])) return false;
    }
    if (state.rarity.length && state.rarity.indexOf(u.rarity) < 0) return false;
    for (var i = 0; i < state.growth.length; i++) {
      if (!(u.growth && u.growth[state.growth[i]] > 0)) return false;
    }
    for (var s in state.statMin) {
      if (!((u.statsMax && u.statsMax[s]) >= state.statMin[s])) return false;
    }
    for (var si = 0; si < state.skills.length; si++) {
      if (umaSkillNames(u).indexOf(state.skills[si].toLowerCase()) === -1) return false;
    }
    return true;
  }

  function sortUmas(list) {
    var s = state.sort;
    return list.sort(function (a, b) {
      if (s === "name") return a.name.localeCompare(b.name);
      if (s === "rarity") return (b.rarity - a.rarity) || a.name.localeCompare(b.name);
      var av = (a.statsMax && a.statsMax[s]) || 0, bv = (b.statsMax && b.statsMax[s]) || 0;
      return (bv - av) || a.name.localeCompare(b.name);
    });
  }

  function gcell(g, label) {
    return '<div class="grade ' + gradeCls(g) + '">' + gradeTxt(g) + "<small>" + label + "</small></div>";
  }

  function unitCard(u) {
    var ap = u.aptitude || { surface: {}, distance: {}, style: {} };
    var row1 = '<div class="apt-row">' +
      gcell(ap.surface.turf, "TRF") + gcell(ap.surface.dirt, "DRT") +
      gcell(ap.distance.short, "SPR") + gcell(ap.distance.mile, "MIL") +
      gcell(ap.distance.medium, "MED") + gcell(ap.distance.long, "LNG") + "</div>";
    var row2 = '<div class="apt-row">' +
      gcell(ap.style.front, "FRN") + gcell(ap.style.pace, "PCE") +
      gcell(ap.style.late, "LAT") + gcell(ap.style.end, "END") + "</div>";
    return '<div class="unit" data-id="' + u.id + '">' +
      '<div class="unit-top">' +
        '<img class="unit-img" loading="lazy" src="/pakadb/' + esc(u.thumb) + '" alt="" ' +
          'onerror="this.src=\'/pakadb/' + esc(u.image) + "'\" />" +
        '<div class="unit-id">' +
          '<div class="unit-name">' + esc(u.name) + "</div>" +
          '<div class="unit-sub"><span class="unit-star">' + "★".repeat(u.rarity || 0) + "</span>" +
            (u.alts && u.alts.length > 1 ? ' <span class="unit-alts">+' + (u.alts.length - 1) + " Alts</span>" : "") +
          "</div>" +
        "</div>" +
      "</div>" + row1 + row2 + "</div>";
  }

  function render() {
    var list = sortUmas(UMAS.filter(passes));
    var grid = $("cp-grid");
    grid.innerHTML = list.map(unitCard).join("");
    $("cp-count").textContent = list.length + " / " + UMAS.length + " beautiful mares";
    $("cp-empty").hidden = list.length > 0;
  }

  // ---- detail drawer ----
  function statBar(u, k) {
    var v = (u.statsMax && u.statsMax[k]) || 0;
    var g = (u.growth && u.growth[k]) || 0;
    var pct = Math.round((v / STATMAX[k]) * 100);
    return '<div class="stat"><span class="stat-l">' +
      '<img class="stat-ico" src="/pakadb/assets/stat_icons/' + k + '.png" alt="' + STAT_NAME[k] + '" data-tip="' + STAT_NAME[k] + '" />' +
      (g ? '<span class="growth-tag">+' + g + "%</span>" : "") + "</span>" +
      '<span class="stat-bar"><span class="stat-fill f-' + k + '" style="width:' + pct + '%"></span></span>' +
      '<span class="stat-n">' + v + "</span></div>";
  }

  // grouped aptitude (Surface / Distance / Strategy)
  var APT_ROWS = [
    { cat: "Surface", items: [["turf", "Turf"], ["dirt", "Dirt"]] },
    { cat: "Distance", items: [["short", "Sprint"], ["mile", "Mile"], ["medium", "Medium"], ["long", "Long"]] },
    { cat: "Strategy", items: [["front", "Front"], ["pace", "Pace"], ["late", "Late"], ["end", "End"]] },
  ];
  function aptRows(ap) {
    return APT_ROWS.map(function (row) {
      var items = row.items.map(function (it) {
        var key = it[0], label = it[1];
        var g = ap[KEY_CAT[key]] && ap[KEY_CAT[key]][key];
        return '<div class="apt2-item">' +
          '<span class="apt2-k">' + label + "</span>" +
          '<span class="apt2-g ' + gradeCls(g) + '">' + gradeTxt(g) + "</span></div>";
      }).join("");
      return '<div class="apt2-row"><span class="apt2-cat">' + row.cat + "</span>" +
        '<div class="apt2-items">' + items + "</div></div>";
    }).join("");
  }

  // name -> iconId, built lazily from the uma skill index (unique/innate/etc.)
  var SKILL_ICON_MAP = null;
  function iconByName(name) {
    if (WHITE_ICON[name]) return WHITE_ICON[name];
    if (!SKILL_ICON_MAP) { SKILL_ICON_MAP = {}; SKILL_INDEX.forEach(function (s) { if (s.iconId && !SKILL_ICON_MAP[s.name]) SKILL_ICON_MAP[s.name] = s.iconId; }); }
    return SKILL_ICON_MAP[name] || null;
  }
  function skillIconImg(iconId) {
    return iconId ? '<img class="fac-ico sk" loading="lazy" src="/pakadb/assets/skill_icons/' + esc(iconId) + '.png" alt="" onerror="this.style.display=\'none\'" />' : "";
  }

  function skillIcon(s) {
    if (!s || !s.iconId) return "";
    return '<img class="skill-ico" loading="lazy" src="/pakadb/assets/skill_icons/' + esc(s.iconId) +
      '.png" alt="" onerror="this.style.display=\'none\'" />';
  }

  function skillRow(s, type) {
    return '<div class="skill"><div class="skill-h">' + skillIcon(s) +
      '<span class="skill-tag t-' + type + '">' + type + "</span>" +
      '<span class="skill-n">' + esc(s.name) + "</span></div>" +
      (s.desc ? '<div class="skill-d">' + esc(s.desc) + "</div>" : "") + "</div>";
  }

  function evoRow(e) {
    return '<div class="skill"><div class="skill-h">' + skillIcon(e.new) +
      '<span class="skill-tag t-evo">evolution</span>' +
      '<span class="skill-n">' + esc(e.old && e.old.name) +
      ' <span class="skill-arrow">▸</span> ' + esc(e.new && e.new.name) + "</span></div>" +
      (e.new && e.new.desc ? '<div class="skill-d">' + esc(e.new.desc) + "</div>" : "") + "</div>";
  }

  function bioRow(k, v) { return '<div class="bio-row"><span class="bio-k">' + k + '</span><span class="bio-v">' + esc(v) + "</span></div>"; }

  function openDrawer(u, idx) {
    idx = idx || 0;
    var alts = (u.alts && u.alts.length) ? u.alts : [u];
    if (idx >= alts.length) idx = 0;
    var cur = alts[idx];                    // selected outfit (aptitude/stats/skills/portrait)
    var ap = cur.aptitude || { surface: {}, distance: {}, style: {} };
    var sk = cur.skills || {};
    var bio = u.bio || {};

    var skillsHtml = "";
    (sk.unique || []).forEach(function (s) { skillsHtml += skillRow(s, "unique"); });
    (sk.innate || []).forEach(function (s) { skillsHtml += skillRow(s, "innate"); });
    (sk.awakening || []).forEach(function (s) { skillsHtml += skillRow(s, "awakening"); });
    (sk.evo || []).forEach(function (e) { skillsHtml += evoRow(e); });
    (sk.event || []).forEach(function (s) { skillsHtml += skillRow(s, "event"); });

    // outfit switcher (only when the mare has alts)
    var outfitHtml = "";
    if (alts.length > 1) {
      outfitHtml = '<div class="dh-outfits">' + alts.map(function (a, i) {
        return '<button class="dh-outfit' + (i === idx ? " on" : "") + '" data-alt="' + i + '">' +
          '<img src="/pakadb/' + esc(a.thumb) + '" alt="" onerror="this.src=\'/pakadb/' + esc(a.image) + "'\" />" +
          "</button>";
      }).join("") + "</div>";
    }

    var bd = bio.birthday;
    var bioHtml = "";
    if (bd) bioHtml += bioRow("Birthday", (bd.month || "?") + "/" + (bd.day || "?"));
    if (bio.height) bioHtml += bioRow("Height", bio.height + " cm");
    if (bio.vaJa) bioHtml += bioRow("VA (JP)", bio.vaJa);
    if (bio.realLife && bio.realLife.active) bioHtml += bioRow("RL active", bio.realLife.active);
    if (bio.realLife && bio.realLife.country) bioHtml += bioRow("RL country", String(bio.realLife.country).toUpperCase());

    $("cp-drawer-inner").innerHTML =
      '<div class="dh">' +
        '<img class="dh-img" src="/pakadb/' + esc(cur.image) + '" alt="" />' +
        '<div class="dh-meta">' +
          '<div class="dh-name">' + esc(u.name) + "</div>" +
          '<div class="dh-jp">' + esc(u.nameJp || "") + " <span class='unit-star'>" + "★".repeat(cur.rarity || 0) + "</span></div>" +
          (cur.title ? '<div class="dh-title">' + esc(cur.title) + "</div>" : "") +
        "</div>" +
        '<button class="dh-x" id="cp-close">✕</button>' +
      "</div>" +
      outfitHtml +
      '<div class="sect"><div class="sect-h">Aptitude</div>' +
        '<div class="apt2">' + aptRows(ap) + "</div></div>" +
      '<div class="sect"><div class="sect-h">Stats (5★ base) + growth</div>' +
        STAT_KEYS.map(function (k) { return statBar(cur, k); }).join("") + "</div>" +
      '<div class="sect"><div class="sect-h">Skills</div>' + (skillsHtml || '<div class="skill-d">None listed.</div>') + "</div>" +
      (bioHtml ? '<div class="sect"><div class="sect-h">Profile</div>' + bioHtml + "</div>" : "");

    Array.prototype.forEach.call($("cp-drawer-inner").querySelectorAll(".dh-outfit"), function (b) {
      b.addEventListener("click", function () { openDrawer(u, Number(b.getAttribute("data-alt"))); });
    });

    $("cp-drawer").classList.add("open");
    $("cp-drawer").setAttribute("aria-hidden", "false");
    document.body.classList.add("drawer-open");
    $("cp-close").addEventListener("click", closeDrawer);
  }

  function closeDrawer() {
    $("cp-drawer").classList.remove("open");
    $("cp-drawer").setAttribute("aria-hidden", "true");
    document.body.classList.remove("drawer-open");
    var s = document.querySelector(".unit.sel"); if (s) s.classList.remove("sel");
  }

  // ================= BREEDING PLANNER =================
  // Affinity = compat(C,P1)+compat(C,P2)+compat(P1,P2)+compat(C,each grandparent),
  // where compat(x,y) sums relation_point over relation types both belong to.
  // This mirrors gametora's succession calc (i.e. the in-game formula).
  var bstate = { foal: null, p1: null, p2: null, gp11: null, gp12: null, gp21: null, gp22: null, active: null };

  // ---- sparks / factors (layered alongside bstate; affinity code untouched) ----
  var SLOTS = ["foal", "p1", "p2", "gp11", "gp12", "gp21", "gp22"];
  var ANCESTORS = ["p1", "p2", "gp11", "gp12", "gp21", "gp22"]; // inheritance pool for the foal
  var APT_KEYS = Object.keys(KEY_LABEL);
  var slotSpark = {};                          // slot -> sparks object (from a saved uma)
  var slotCard = {};                           // slot -> chosen outfit cardId (for the node portrait)
  var savedUmas = [];                          // personal roster (localStorage)
  var editing = null;                          // spark object being edited

  function emptySparks() {
    var blue = {}, pink = {};
    STAT_KEYS.forEach(function (k) { blue[k] = 0; });
    APT_KEYS.forEach(function (k) { pink[k] = 0; });
    return { charId: null, name: "", blue: blue, pink: pink, green: 0, white: [] };
  }
  function loadRoster() { try { savedUmas = JSON.parse(localStorage.getItem("pakadb_umas") || "[]"); } catch (e) { savedUmas = []; } }
  function persistRoster() { try { localStorage.setItem("pakadb_umas", JSON.stringify(savedUmas)); } catch (e) {} }

  // aggregate the inheritable factor pool across the foal's 6 ancestors
  function inheritableFactors() {
    var blue = {}, pink = {}, green = {}, white = {};
    ANCESTORS.forEach(function (slot) {
      var sp = slotSpark[slot]; if (!sp) return;
      STAT_KEYS.forEach(function (k) { if (sp.blue && sp.blue[k]) blue[k] = (blue[k] || 0) + sp.blue[k]; });
      APT_KEYS.forEach(function (k) { if (sp.pink && sp.pink[k]) pink[k] = (pink[k] || 0) + sp.pink[k]; });
      if (sp.green) {
        var u = bstate[slot] ? BYID[bstate[slot]] : null;
        var nm = (u && u.skills && u.skills.unique && u.skills.unique[0]) ? u.skills.unique[0].name : (sp.name || "Unique");
        green[nm] = (green[nm] || 0) + sp.green;
      }
      (sp.white || []).forEach(function (w) { if (w.name) white[w.name] = (white[w.name] || 0) + (w.lvl || 0); });
    });
    return { blue: blue, pink: pink, green: green, white: white };
  }

  function compatDetail(x, y) {
    if (!x || !y) return { pts: 0, bonds: 0 };
    var a = BREED.members[x], b = BREED.members[y], p = BREED.relationPoints;
    if (!a || !b) return { pts: 0, bonds: 0 };
    var set = {}; a.forEach(function (t) { set[t] = 1; });
    var pts = 0, bonds = 0;
    b.forEach(function (t) { if (set[t]) { pts += p[t] || 0; bonds++; } });
    return { pts: pts, bonds: bonds };
  }
  function compat(x, y) { return compatDetail(x, y).pts; }

  // pedigree geometry (ported from the Pigsty tree)
  var NODE_W = 188, NODE_H = 66, COL_W = 224, GAP_Y = 14, PAD = 8;

  function pedigree() {
    var mk = function (key, gen, role, children) {
      return { key: key, gen: gen, role: role, uma: bstate[key] ? BYID[bstate[key]] : null, children: children || [] };
    };
    return mk("foal", 0, "Foal", [
      mk("p1", 1, "Parent 1", [mk("gp11", 2, "Grandparent"), mk("gp12", 2, "Grandparent")]),
      mk("p2", 1, "Parent 2", [mk("gp21", 2, "Grandparent"), mk("gp22", 2, "Grandparent")]),
    ]);
  }

  function layout(root) {
    var leafY = 0;
    (function place(node, depth) {
      node.x = depth * COL_W;
      if (!node.children.length) { node.y = leafY; leafY += NODE_H + GAP_Y; }
      else {
        node.children.forEach(function (c) { place(c, depth + 1); });
        node.y = (node.children[0].y + node.children[node.children.length - 1].y) / 2;
      }
    })(root, 0);
    return Math.max(0, leafY - GAP_Y);
  }

  function flatten(root) {
    var nodes = [], edges = [];
    (function walk(n) { nodes.push(n); n.children.forEach(function (c) { edges.push([n, c]); walk(c); }); })(root);
    return { nodes: nodes, edges: edges };
  }

  function edgePath(a, b) {
    var sx = a.x + NODE_W + PAD, sy = a.y + NODE_H / 2 + PAD;
    var tx = b.x + PAD, ty = b.y + NODE_H / 2 + PAD;
    var mx = (sx + tx) / 2;
    return { d: "M" + sx + "," + sy + " C" + mx + "," + sy + " " + mx + "," + ty + " " + tx + "," + ty, mx: mx, my: (sy + ty) / 2 };
  }

  function nodeCard(n) {
    if (!n.uma) {
      return '<div class="bd-node empty gen' + n.gen + '" data-slot="' + n.key + '">+ ' + n.role.toUpperCase() + "</div>";
    }
    var uskill = (n.uma.skills && n.uma.skills.unique && n.uma.skills.unique[0]) ? n.uma.skills.unique[0] : null;
    var hasSpark = !!slotSpark[n.key];
    // portrait: the chosen outfit if one was picked, else the base
    var thumb = n.uma.thumb, img = n.uma.image, cid = slotCard[n.key];
    if (cid && n.uma.alts) { var alt = n.uma.alts.filter(function (a) { return a.cardId === cid; })[0]; if (alt) { thumb = alt.thumb; img = alt.image; } }
    return '<div class="bd-node gen' + n.gen + '" data-slot="' + n.key + '">' +
      '<img class="bd-node-img" src="/pakadb/' + esc(thumb) + '" alt="" onerror="this.src=\'/pakadb/' + esc(img) + "'\" />" +
      '<div class="bd-node-meta">' +
        '<div class="bd-node-role">' + n.role + (hasSpark ? ' <span class="bd-spark-tag">SPARKS</span>' : "") + "</div>" +
        '<div class="bd-node-name">' + esc(n.uma.name) + "</div>" +
        (uskill ? '<div class="bd-node-uniq" data-tip="Unique skill (green factor)">' + skillIcon(uskill) + esc(uskill.name) + "</div>" : "") +
      "</div></div>";
  }

  // in-game succession affinity: the parent triangle plus, for each grandparent,
  // BOTH its relation with the foal and with its own parent.
  //   total = c(F,P1)+c(F,P2)+c(P1,P2)
  //         + c(F,GP11)+c(P1,GP11) + c(F,GP12)+c(P1,GP12)
  //         + c(F,GP21)+c(P2,GP21) + c(F,GP22)+c(P2,GP22)
  function affinity() {
    var f = bstate.foal, p1 = bstate.p1, p2 = bstate.p2;
    var cP1 = compat(f, p1), cP2 = compat(f, p2), p12 = compat(p1, p2);
    // each grandparent's contribution: relation to foal + relation to its parent
    var g11 = compat(f, bstate.gp11) + compat(p1, bstate.gp11);
    var g12 = compat(f, bstate.gp12) + compat(p1, bstate.gp12);
    var g21 = compat(f, bstate.gp21) + compat(p2, bstate.gp21);
    var g22 = compat(f, bstate.gp22) + compat(p2, bstate.gp22);
    return {
      cP1: cP1, cP2: cP2, p12: p12, cGP: g11 + g12 + g21 + g22,
      total: cP1 + cP2 + p12 + g11 + g12 + g21 + g22,
    };
  }
  // total affinity if `id` were placed in `slot` (for recommendations)
  function affinityWith(slot, id) {
    var saved = bstate[slot]; bstate[slot] = id;
    var t = affinity().total; bstate[slot] = saved;
    return t;
  }

  function rating(total) {
    if (total >= 150) return { cls: "great", sym: "◎", label: "GREAT" };
    if (total >= 100) return { cls: "good", sym: "◎", label: "GOOD" };
    if (total >= 50) return { cls: "ok", sym: "○", label: "OK" };
    return { cls: "low", sym: "△", label: "LOW" };
  }

  function renderBreeding() {
    var root = pedigree();
    var h = layout(root) + NODE_H + PAD * 2;
    var fl = flatten(root);
    var depth = Math.max.apply(null, fl.nodes.map(function (n) { return n.x / COL_W; }));
    var w = depth * COL_W + NODE_W + PAD * 2;

    var svg = '<svg class="bd-tree-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="xMidYMid meet" style="display:inline-block">';
    fl.edges.forEach(function (pair) {
      var ep = edgePath(pair[0], pair[1]);
      svg += '<path d="' + ep.d + '" fill="none" stroke="#DAD0C2" stroke-width="2" />';
      // edge label = compat between the foal and the deeper node (child-relative term)
      var deep = pair[1].uma, lab = (bstate.foal && deep) ? compat(bstate.foal, deep.id) : null;
      if (lab != null) {
        var col = lab >= 20 ? "#E85D8B" : lab >= 10 ? "#4CA62E" : "#9A8FA0";
        svg += '<text class="bd-edge-label" x="' + ep.mx + '" y="' + (ep.my - 4) +
          '" text-anchor="middle" fill="' + col + '">' + lab + "</text>";
      }
    });
    fl.nodes.forEach(function (n) {
      svg += '<foreignObject x="' + (n.x + PAD) + '" y="' + (n.y + PAD) + '" width="' + NODE_W + '" height="' + NODE_H + '">' +
        nodeCard(n) + "</foreignObject>";
    });
    // affinity total + rating + aptitude coverage, floated above the foal card
    var foalNode = fl.nodes.filter(function (n) { return n.key === "foal"; })[0];
    var topHtml = foalTop();
    if (foalNode && topHtml) {
      var COV_H = 108, covY = Math.max(0, foalNode.y + PAD - COV_H - 6);
      svg += '<foreignObject x="' + (foalNode.x + PAD) + '" y="' + covY + '" width="' + NODE_W + '" height="' + COV_H + '">' + topHtml + "</foreignObject>";
    }
    svg += "</svg>";
    $("bd-stage").innerHTML = svg;

    renderAffinity();
    renderFactors();
  }

  // ---- lineage map: every spark an ancestor passes toward the foal ----
  // one leaf per spark on a slot's saved-uma sparks
  function sparkLeaves(slot) {
    var sp = slotSpark[slot]; if (!sp) return [];
    var out = [];
    STAT_KEYS.forEach(function (k) { if (sp.blue && sp.blue[k]) out.push({ kind: "blue", label: STAT_NAME[k], statk: k, lvl: sp.blue[k] }); });
    APT_KEYS.forEach(function (k) { if (sp.pink && sp.pink[k]) out.push({ kind: "pink", label: KEY_LABEL[k], abbr: APT_ABBR[k], lvl: sp.pink[k] }); });
    if (sp.green) {
      var u = BYID[bstate[slot]], us = u && u.skills && u.skills.unique && u.skills.unique[0];
      out.push({ kind: "green", label: us ? us.name : (sp.name || "Unique"), iconId: us ? us.iconId : null, lvl: sp.green });
    }
    (sp.white || []).forEach(function (w) {
      if (!w.name) return;
      var bid = RACE_BANNER[w.name];
      if (bid) out.push({ kind: "race", label: w.name, banner: bid, lvl: w.lvl || 0 });
      else out.push({ kind: "white", label: w.name, iconId: iconByName(w.name), lvl: w.lvl || 0 });
    });
    return out;
  }
  function leafColor(kind) {
    return kind === "blue" ? "#2f7fc0" : kind === "pink" ? "#c23c74" : kind === "green" ? "#3C8523" : kind === "race" ? "#C79A2E" : "#8a7f88";
  }
  // a line trimmed to both nodes' radii, arrowhead pointing at the inner (target) node.
  // opts: { width, color, label, labelColor } — label rides near the source (outer) end.
  function lmEdge(x1, y1, r1, x2, y2, r2, opts) {
    opts = opts || {};
    var dx = x2 - x1, dy = y2 - y1, d = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / d, uy = dy / d;
    var sx = x1 + ux * r1, sy = y1 + uy * r1, ex = x2 - ux * (r2 + (opts.noArrow ? 0 : 4)), ey = y2 - uy * (r2 + (opts.noArrow ? 0 : 4));
    var line = '<line x1="' + sx.toFixed(1) + '" y1="' + sy.toFixed(1) + '" x2="' + ex.toFixed(1) + '" y2="' + ey.toFixed(1) +
      '" stroke="' + (opts.color || "#ddd2c0") + '" stroke-width="' + (opts.width || 1.5) + '"' +
      (opts.dashed ? ' stroke-dasharray="4 4"' : "") + (opts.noArrow ? "" : ' marker-end="url(#lmarrow)"') + "/>";
    if (opts.label == null) return line;
    var lx = sx + (ex - sx) * 0.34, ly = sy + (ey - sy) * 0.34, c = opts.labelColor || "#9A8FA0";
    return line + '<g class="lm-elabel"><rect x="' + (lx - 12) + '" y="' + (ly - 9) + '" width="24" height="18" rx="9" fill="#fff" stroke="' + c + '" stroke-width="1.5"/>' +
      '<text x="' + lx + '" y="' + (ly + 3.5) + '" text-anchor="middle" font-size="10" font-weight="800" fill="' + c + '">' + opts.label + "</text></g>";
  }
  function lmPortrait(x, y, r, thumb, color, name, big, slot) {
    var img = thumb ? '<image href="/pakadb/' + esc(thumb.thumb) + '" x="' + (x - r) + '" y="' + (y - r) + '" width="' + (2 * r) + '" height="' + (2 * r) + '" clip-path="url(#lmclip)" preserveAspectRatio="xMidYMid slice"/>' : "";
    return '<g class="lm-node" data-slot="' + esc(slot || "") + '" data-tip="' + (name || "") + '">' +
      '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="#FBF5EA"/>' + img +
      '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="' + (big ? 4 : 3) + '"/></g>';
  }
  function lmLeaf(x, y, r, lf, slot) {
    var col = leafColor(lf.kind), inner = "";
    if (lf.kind === "blue") inner = '<image href="/pakadb/assets/stat_icons/' + lf.statk + '.png" x="' + (x - r * 0.7) + '" y="' + (y - r * 0.7) + '" width="' + (r * 1.4) + '" height="' + (r * 1.4) + '"/>';
    else if (lf.kind === "pink") inner = '<text x="' + x + '" y="' + (y + 3) + '" text-anchor="middle" font-size="8" font-weight="800" fill="#fff">' + esc(lf.abbr) + "</text>";
    else if ((lf.kind === "green" || lf.kind === "white") && lf.iconId) inner = '<image href="/pakadb/assets/skill_icons/' + lf.iconId + '.png" x="' + (x - r * 0.78) + '" y="' + (y - r * 0.78) + '" width="' + (r * 1.56) + '" height="' + (r * 1.56) + '" clip-path="url(#lmclip)"/>';
    else if (lf.kind === "race") inner = '<image href="/pakadb/assets/races/' + lf.banner + '.png" x="' + (x - r) + '" y="' + (y - r) + '" width="' + (2 * r) + '" height="' + (2 * r) + '" clip-path="url(#lmclip)" preserveAspectRatio="xMidYMid slice"/>';
    var badge = lf.lvl ? '<circle cx="' + (x + r * 0.82) + '" cy="' + (y - r * 0.82) + '" r="6" fill="#fff" stroke="' + col + '" stroke-width="1.5"/>' +
      '<text x="' + (x + r * 0.82) + '" y="' + (y - r * 0.82 + 3) + '" text-anchor="middle" font-size="8" font-weight="800" fill="' + col + '">' + lf.lvl + "</text>" : "";
    return '<g class="lm-node" data-slot="' + esc(slot || "") + '" data-spark="1" data-tip="' + esc(lf.label + (lf.lvl ? " ★" + lf.lvl : "") + ". Tap to edit.") + '">' +
      '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + col + '"/>' + inner +
      '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="none" stroke="#fff" stroke-width="2"/>' + badge + "</g>";
  }
  function lmSparkChild(lf) { return { nkind: "spark", leaf: lf, children: [] }; }
  // uma name highlighted pink inside a tooltip (rendered as HTML by the tip controller)
  function pinkName(n) { return "<span class='tip-uma'>" + esc(n) + "</span>"; }
  // build the lineage tree: foal -> parents -> grandparents, sparks hang off each ancestor
  function lineageTree() {
    var f = bstate.foal, foalName = (BYID[f] || {}).name || "your trainee";
    function ancNode(slot, parentSlot) {
      if (!bstate[slot]) return null;
      var id = bstate[slot], pId = parentSlot ? bstate[parentSlot] : null;
      var toFoal = compat(f, id), toParent = pId ? compat(pId, id) : 0;
      var contrib = toFoal + toParent;
      var tip = pinkName(BYID[id].name) + ", " + contrib + " compatibility";
      tip += parentSlot ? " (" + toFoal + " with " + pinkName(foalName) + ", " + toParent + " with its parent). Tap to swap her."
                        : " with " + pinkName(foalName) + ". Tap to swap her.";
      return {
        nkind: "anc", slot: slot, thumb: slotThumb(slot), name: BYID[id].name,
        contrib: contrib, tip: tip, children: sparkLeaves(slot).map(lmSparkChild),
      };
    }
    function branch(pSlot, gA, gB) {
      var pn = ancNode(pSlot, null);
      if (pn) { [gA, gB].forEach(function (g) { var gn = ancNode(g, pSlot); if (gn) pn.children.push(gn); }); return [pn]; }
      // parent empty -> surface its filled grandparents directly under the foal
      return [ancNode(gA, null), ancNode(gB, null)].filter(Boolean);
    }
    return {
      nkind: "foal", slot: "foal", thumb: slotThumb("foal"), name: foalName,
      tip: pinkName(foalName) + ", your trainee. Tap to change her.", big: true,
      children: branch("p1", "gp11", "gp12").concat(branch("p2", "gp21", "gp22")),
    };
  }
  function lmNodeR(n) { return n.nkind === "foal" ? 38 : n.nkind === "spark" ? 14 : n.depth <= 1 ? 24 : 20; }
  // radial tidy-tree layout: angular span by leaf weight, radius by depth
  function lmLayout(root, cx, cy, rings) {
    (function count(n) { n.leaves = n.children.length ? n.children.reduce(function (s, c) { return s + count(c); }, 0) : 1; return n.leaves; })(root);
    (function assign(n, a0, a1, depth) {
      n.depth = depth;
      var rad = rings[Math.min(depth, rings.length - 1)];
      n.angle = (a0 + a1) / 2;
      n.x = cx + rad * Math.cos(n.angle); n.y = cy + rad * Math.sin(n.angle);
      var a = a0;
      n.children.forEach(function (c) { var span = (a1 - a0) * (c.leaves / n.leaves); assign(c, a, a + span, depth + 1); a += span; });
    })(root, -Math.PI / 2, Math.PI * 1.5, 0);
  }
  // portrait (chosen outfit if any) for a slot, or null when empty
  function slotThumb(slot) {
    var u = bstate[slot] ? BYID[bstate[slot]] : null;
    if (!u) return null;
    var thumb = u.thumb, cid = slotCard[slot];
    if (cid && u.alts) { var alt = u.alts.filter(function (x) { return x.cardId === cid; })[0]; if (alt) thumb = alt.thumb; }
    return { thumb: thumb, img: u.image, name: u.name };
  }
  function affColor(pts) { return pts >= 20 ? "var(--sakura)" : pts >= 10 ? "var(--turf)" : "var(--slate)"; }

  // visual affinity breakdown: each contributing pairing as portrait-pair + bar,
  // plus a progress bar toward the next rating tier.
  function renderAffinity() {
    var host = $("bd-affinity"); if (!host) return;
    if (!bstate.foal) { host.innerHTML = ""; return; }
    var a = affinity(), r = rating(a.total);

    // progress toward the next tier (50 / 100 / 150), else already maxed
    var TIERS = [{ t: 50, sym: "○", label: "OK" }, { t: 100, sym: "◎", label: "GOOD" }, { t: 150, sym: "◎", label: "GREAT" }];
    var next = null; for (var i = 0; i < TIERS.length; i++) { if (a.total < TIERS[i].t) { next = TIERS[i]; break; } }
    var prevT = 0; if (next) { for (var j = 0; j < TIERS.length; j++) { if (TIERS[j].t < next.t && TIERS[j].t <= a.total) prevT = TIERS[j].t; } }
    var pct = next ? Math.round(Math.max(0, Math.min(1, (a.total - prevT) / (next.t - prevT))) * 100) : 100;
    var goal = next ? '<span class="bd-aff-goal">' + (next.t - a.total) + " to " + next.sym + " " + next.label + "</span>"
                    : '<span class="bd-aff-goal maxed">' + r.sym + " MAX TIER</span>";
    var header = '<div class="sect-h">Lineage map</div>' +
      '<div class="bd-aff-head">' +
        '<div class="bd-aff-score"><span class="bd-aff-n">' + a.total + '</span>' +
          '<span class="ftop-rate bd-r-' + r.cls + '">' + r.sym + " " + r.label + "</span></div>" +
        '<div class="bd-aff-prog"><span class="bd-aff-track big"><span class="bd-aff-fill" style="width:' + pct + '%;background:' + affColor(a.total >= 150 ? 20 : a.total >= 100 ? 10 : 0) + '"></span></span>' + goal + "</div>" +
      "</div>";

    // build the lineage tree; bail out if no ancestors are placed
    var tree = lineageTree();
    if (!tree.children.length) {
      host.innerHTML = header + '<div class="bd-aff-cap">Place parents and grandparents to grow the lineage map. Saved umas add each of their sparks as a spoke.</div>';
      return;
    }

    // radial hierarchy: foal center, parents on ring 1, grandparents on ring 2, sparks fanned outward
    var W = 760, H = 680, cx = 380, cy = 340;
    lmLayout(tree, cx, cy, [0, 120, 205, 268]);

    var edges = "", nodes = "";
    (function walk(n, parent) {
      if (parent) {
        var opts = n.nkind === "spark"
          ? { width: 1 + (n.leaf.lvl || 1) * 0.5, color: "#e2d8c7" }
          : { label: n.contrib, labelColor: affColor(n.contrib), width: 1.5 + Math.min(n.contrib, 40) / 40 * 3 };
        edges += lmEdge(n.x, n.y, lmNodeR(n), parent.x, parent.y, lmNodeR(parent), opts);
      }
      n.children.forEach(function (c) { walk(c, n); });
      // draw nodes after their edges; foal (root) ends up on top since it renders last below
      if (n.nkind === "spark") nodes += lmLeaf(n.x, n.y, lmNodeR(n), n.leaf, parent ? parent.slot : "");
      else nodes += lmPortrait(n.x, n.y, lmNodeR(n), n.thumb, n.nkind === "foal" ? "#3C8523" : "#4CA62E", n.tip || n.name, n.big, n.slot);
    })(tree, null);
    // the P1 x P2 relation isn't a tree edge; draw it as a dashed link between the two parents
    var pn = {}; tree.children.forEach(function (c) { if (c.slot === "p1" || c.slot === "p2") pn[c.slot] = c; });
    if (pn.p1 && pn.p2) {
      var pc = compat(bstate.p1, bstate.p2);
      edges = lmEdge(pn.p1.x, pn.p1.y, lmNodeR(pn.p1), pn.p2.x, pn.p2.y, lmNodeR(pn.p2),
        { dashed: true, noArrow: true, label: pc, labelColor: affColor(pc), color: "#e2d8c7" }) + edges;
    }

    var defs = '<defs><clipPath id="lmclip" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath>' +
      '<marker id="lmarrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7z" fill="#cabfae"/></marker></defs>';
    var svg = '<svg class="lm-svg" viewBox="0 0 ' + W + " " + H + '" width="100%" preserveAspectRatio="xMidYMid meet">' + defs + edges + nodes + "</svg>";

    host.innerHTML = header +
      '<div class="bd-aff-cap">Your trainee sits at the center, surrounded by her parents and grandparents and every spark they can pass down. The numbers show how well each pair gets along, better compatibility means better inheritance, and the dashed line is how the two parents match up. <b>Tap any uma to swap her out, or tap a spark to change it.</b></div>' +
      '<div class="lm-wrap">' + svg + "</div>";
  }

  // the block that floats above the foal card: total affinity + rating + aptitude mini
  function foalTop() {
    var foal = bstate.foal ? BYID[bstate.foal] : null;
    if (!foal) return "";
    var a = affinity(), r = rating(a.total);
    var aff = '<div class="ftop-aff"><span class="ftop-n">' + a.total + '</span>' +
      '<span class="ftop-l">affinity</span>' +
      '<span class="ftop-rate bd-r-' + r.cls + '">' + r.sym + " " + r.label + "</span></div>";
    return '<div class="ftop">' + aff + foalCovMini() + "</div>";
  }

  // inheritable factor pool from the ancestors' sparks
  function renderFactors() {
    var host = $("bd-factors");
    var f = inheritableFactors();
    var starsBlue = STAT_KEYS.filter(function (k) { return f.blue[k]; })
      .map(function (k) { return '<span class="fac-chip fac-blue"><img class="fac-ico" src="/pakadb/assets/stat_icons/' + k + '.png" alt="" />' + STAT_NAME[k] + " ★" + f.blue[k] + "</span>"; }).join("");
    var starsPink = APT_KEYS.filter(function (k) { return f.pink[k]; })
      .map(function (k) { return '<span class="fac-chip fac-pink">' + KEY_LABEL[k] + " ★" + f.pink[k] + "</span>"; }).join("");
    var green = Object.keys(f.green).map(function (n) { var ic = iconByName(n); return '<span class="fac-chip fac-green">' + (ic ? skillIconImg(ic) + " " : "") + esc(n) + " ★" + f.green[n] + "</span>"; }).join("");
    var white = Object.keys(f.white).map(function (n) {
      var bid = RACE_BANNER[n];
      if (bid) return '<span class="fac-chip fac-white fac-race">' + raceBannerImg(bid, "fac-banner") + " " + esc(n) + " ★" + f.white[n] + "</span>";
      var ic = iconByName(n); return '<span class="fac-chip fac-white">' + (ic ? skillIconImg(ic) + " " : "") + esc(n) + " ★" + f.white[n] + "</span>";
    }).join("");
    if (!starsBlue && !starsPink && !green && !white) {
      host.innerHTML = '<div class="fac-h">Inheritable factors</div><div class="cov-empty">Place saved umas (with sparks) in the parent/grandparent slots to pool their factors here.</div>';
      return;
    }
    var row = function (label, chips) { return chips ? '<div class="fac-row"><span class="fac-l">' + label + "</span><div class=\"fac-chips\">" + chips + "</div></div>" : ""; };
    host.innerHTML = '<div class="fac-h">Inheritable factors (from the 6 ancestors)</div>' +
      row("Blue", starsBlue) + row("Pink", starsPink) + row("Green", green) + row("White", white);
  }

  // compact aptitude coverage that floats above the foal card: one tiny cell per
  // aptitude (grade-colored), weak spots (C or worse) ringed pink.
  var APT_ABBR = { turf: "TRF", dirt: "DRT", short: "SPR", mile: "MIL", medium: "MED", long: "LNG", front: "FRN", pace: "PCE", late: "LAT", end: "END" };
  function foalCovMini() {
    var foal = bstate.foal ? BYID[bstate.foal] : null;
    if (!foal) return "";
    var pink = inheritableFactors().pink;  // aptitude sparks pooled from ancestors
    var weak = 0;
    var cells = APT_KEYS.map(function (k) {
      var g = aptGrade(foal, k);
      var isWeak = GRANK[g] < GRANK.B;
      if (isWeak) weak++;
      var boost = pink[k] || 0;
      return '<span class="fcov-c v-' + (g && GRANK[g] ? g : "null") + (isWeak ? " weak" : "") + (boost ? " backed" : "") +
        '" data-tip="' + esc(KEY_LABEL[k]) + (boost ? " (pink ★" + boost + " incoming)" : "") + '">' +
        (boost ? '<i class="fcov-boost">▲' + boost + "</i>" : "") +
        '<small class="fcov-k">' + APT_ABBR[k] + "</small>" + gradeTxt(g) + "</span>";
    }).join("");
    return '<div class="fcov"><div class="fcov-h">APTITUDE' + (weak ? ' <span class="fcov-w">' + weak + " weak</span>" : "") + "</div>" +
      '<div class="fcov-cells">' + cells + "</div></div>";
  }

  // ---- saved-uma roster ----
  function openRoster() { showEl($("cp-roster")); showEl($("cp-scrim")); renderRoster(); }
  function closeRoster() { hideEl($("cp-roster")); hideEl($("cp-scrim")); }

  // ---- tree profiles: save / load the whole pedigree (slots + sparks + outfits) ----
  var savedTrees = [];
  function loadTrees() { try { savedTrees = JSON.parse(localStorage.getItem("pakadb_trees") || "[]"); } catch (e) { savedTrees = []; } }
  function persistTrees() { try { localStorage.setItem("pakadb_trees", JSON.stringify(savedTrees)); } catch (e) {} }
  function openTrees() { showEl($("cp-trees")); showEl($("cp-scrim")); renderTrees(); }
  function closeTrees() { hideEl($("cp-trees")); hideEl($("cp-scrim")); }
  function treeSnapshot(name) {
    var slots = {}, sparks = {}, cards = {};
    SLOTS.forEach(function (s) {
      if (bstate[s] != null) slots[s] = bstate[s];
      if (slotSpark[s]) sparks[s] = slotSpark[s];
      if (slotCard[s] != null) cards[s] = slotCard[s];
    });
    return { name: name, slots: slots, sparks: sparks, cards: cards };
  }
  function loadTree(idx) {
    var t = savedTrees[idx]; if (!t) return;
    SLOTS.forEach(function (s) { bstate[s] = null; slotSpark[s] = null; slotCard[s] = null; });
    Object.keys(t.slots || {}).forEach(function (s) { bstate[s] = t.slots[s]; });
    Object.keys(t.sparks || {}).forEach(function (s) { slotSpark[s] = t.sparks[s]; });
    Object.keys(t.cards || {}).forEach(function (s) { slotCard[s] = t.cards[s]; });
    renderBreeding(); closeTrees();
  }
  function renderTrees() {
    var host = $("cp-trees-body");
    var save = '<div class="tree-save">' +
      '<input id="tree-name" class="cp-input" placeholder="Name this tree…" autocomplete="off" spellcheck="false" />' +
      '<button class="cp-ghost" id="tree-save-btn">SAVE CURRENT</button></div>';
    var list = savedTrees.length ? savedTrees.map(function (t, i) {
      var foal = t.slots && t.slots.foal ? BYID[t.slots.foal] : null;
      var anc = ["p1", "p2", "gp11", "gp12", "gp21", "gp22"].filter(function (s) { return t.slots && t.slots[s]; }).length;
      var sparks = t.sparks ? Object.keys(t.sparks).length : 0;
      return '<div class="pk-row" data-load="' + i + '">' +
        '<img class="pk-img" loading="lazy" src="/pakadb/' + esc(foal ? foal.thumb : "") + '" alt="" />' +
        '<div class="pk-meta"><div class="pk-name">' + esc(t.name || "Tree") + "</div>" +
        '<div class="pk-sub">' + (foal ? esc(foal.name) : "no foal") + " · " + anc + " ancestor" + (anc === 1 ? "" : "s") +
          (sparks ? " · " + sparks + " with sparks" : "") + "</div></div>" +
        '<button class="cp-ghost rost-edit" data-load="' + i + '">LOAD</button>' +
        '<button class="cp-ghost rost-del" data-deltree="' + i + '">✕</button></div>';
    }).join("") : '<div class="cov-empty">No saved trees yet. Build a pedigree, name it, and hit SAVE CURRENT.</div>';
    host.innerHTML = save + list;
  }
  function renderRoster() {
    var host = $("cp-roster-list");
    if (!savedUmas.length) { host.innerHTML = '<div class="cov-empty">No saved umas yet. Hit + NEW UMA to add one with its sparks.</div>'; return; }
    host.innerHTML = savedUmas.map(function (s, i) {
      var u = BYID[s.charId];
      var stars = (STAT_KEYS.reduce(function (t, k) { return t + (s.blue[k] || 0); }, 0)) +
        APT_KEYS.reduce(function (t, k) { return t + (s.pink[k] || 0); }, 0) + (s.green || 0) +
        (s.white || []).reduce(function (t, w) { return t + (w.lvl || 0); }, 0);
      return '<div class="pk-row" data-ri="' + i + '">' +
        '<img class="pk-img" loading="lazy" src="/pakadb/' + esc(u ? u.thumb : "") + '" alt="" />' +
        '<div class="pk-meta"><div class="pk-name">' + esc(s.name || (u && u.name) || "Uma") + '</div>' +
        '<div class="pk-sub">' + stars + ' total factor ★</div></div>' +
        '<button class="cp-ghost rost-edit" data-edit="' + i + '">EDIT</button>' +
        '<button class="cp-ghost rost-del" data-del="' + i + '">✕</button></div>';
    }).join("");
  }

  // ---- spark editor ----
  function starCtl(kind, key, lvl) {
    var dots = "";
    for (var i = 1; i <= 3; i++) dots += '<button class="star' + (i <= lvl ? " on" : "") + '" data-kind="' + kind + '" data-key="' + key + '" data-lvl="' + i + '">★</button>';
    return '<button class="star star0" data-kind="' + kind + '" data-key="' + key + '" data-lvl="0">0</button>' + dots;
  }
  function openEditor(idx) {
    if (idx != null) { editing = JSON.parse(JSON.stringify(savedUmas[idx])); editing._idx = idx; }
    else { editing = emptySparks(); editing._idx = null; editing.charId = UMAS[0].id; editing.name = UMAS[0].name; }
    hideEl($("cp-roster"));
    showEl($("cp-editor")); showEl($("cp-scrim"));
    renderEditor();
  }
  function closeEditor() { hideEl($("cp-editor")); hideEl($("cp-scrim")); editing = null; }
  // edit a tree slot's sparks in place (from the lineage map), not the roster
  function openSlotSparkEditor(slot) {
    if (!bstate[slot]) return;
    var ex = slotSpark[slot];
    editing = ex ? JSON.parse(JSON.stringify(ex)) : emptySparks();
    editing.charId = bstate[slot];
    editing.name = (BYID[bstate[slot]] || {}).name || editing.name || "";
    editing._idx = null; editing._slot = slot;
    showEl($("cp-editor")); showEl($("cp-scrim"));
    renderEditor();
  }
  function renderEditor() {
    var e = editing; if (!e) return;
    var u = BYID[e.charId];
    var uskill = (u && u.skills && u.skills.unique && u.skills.unique[0]) ? u.skills.unique[0] : null;
    var uniqName = uskill ? uskill.name : "Unique skill";
    var opts = UMAS.map(function (x) { return '<option value="' + x.id + '"' + (x.id === e.charId ? " selected" : "") + ">" + esc(x.name) + "</option>"; }).join("");
    var blue = STAT_KEYS.map(function (k) { return '<div class="ed-row"><span class="ed-k">' + STAT_NAME[k] + '</span><div class="ed-stars">' + starCtl("blue", k, e.blue[k] || 0) + "</div></div>"; }).join("");
    var pink = APT_KEYS.map(function (k) { return '<div class="ed-row"><span class="ed-k">' + KEY_LABEL[k] + '</span><div class="ed-stars">' + starCtl("pink", k, e.pink[k] || 0) + "</div></div>"; }).join("");
    var white = (e.white || []).map(function (w, i) {
      var bid = w.name ? RACE_BANNER[w.name] : null;
      var ic = w.name && !bid ? iconByName(w.name) : null;
      var label = w.name
        ? (bid ? raceBannerImg(bid, "ed-wbanner") : (ic ? skillIconImg(ic) : "")) + esc(w.name)
        : '<span class="ed-wph">Pick skill or race</span>';
      return '<div class="ed-white"><button type="button" class="cp-input ed-wpick" data-wi="' + i + '">' + label + "</button>" +
        '<div class="ed-stars">' + starCtl("white", i, w.lvl || 0) + "</div>" +
        '<button class="cp-ghost ed-wdel" data-wdel="' + i + '">✕</button></div>';
    }).join("");
    $("cp-editor-body").innerHTML =
      '<div class="ed-sect"><div class="ed-h">Character</div><img class="ed-portrait" src="/pakadb/' + esc(u ? u.image : "") + '" alt="" />' +
        '<select class="cp-input ed-char" style="width:100%">' + opts + "</select></div>" +
      '<div class="ed-sect"><div class="ed-h">' + (uskill ? skillIcon(uskill) : "") + "Green spark (" + esc(uniqName) + ")</div><div class=\"ed-row\"><span class=\"ed-k\">Level</span><div class=\"ed-stars\">" + starCtl("green", "green", e.green || 0) + "</div></div></div>" +
      '<div class="ed-sect"><div class="ed-h">🔵 Blue sparks (stats)</div>' + blue + "</div>" +
      '<div class="ed-sect"><div class="ed-h">🩷 Pink sparks (aptitude)</div>' + pink + "</div>" +
      '<div class="ed-sect"><div class="ed-h">⚪ White sparks (skills / races)</div>' + white +
        '<button class="cp-ghost" id="ed-add-white">+ ADD WHITE SPARK</button></div>';
  }

  // ---- inline slot picker (used by the breeding tree; the modal picker below is kept but unused) ----
  var ROLE_LABEL = { foal: "Foal", p1: "Parent 1", p2: "Parent 2", gp11: "Grandparent (P1)", gp12: "Grandparent (P1)", gp21: "Grandparent (P2)", gp22: "Grandparent (P2)" };
  // flattened outfit rows (base + alts), built once
  var OUTFITS = null;
  function outfitRows() {
    if (OUTFITS) return OUTFITS;
    OUTFITS = [];
    UMAS.forEach(function (u) {
      (u.alts && u.alts.length ? u.alts : [u]).forEach(function (a) {
        OUTFITS.push({ id: u.id, name: u.name, cardId: a.cardId, title: a.title, thumb: a.thumb, image: a.image, rarity: a.rarity });
      });
    });
    return OUTFITS;
  }
  // position a fixed popup right under an anchor element, clamped to the viewport
  function anchorUnder(el, anchor) {
    if (!anchor || !anchor.getBoundingClientRect) return;
    var r = anchor.getBoundingClientRect();
    var w = el.offsetWidth || 290, hh = el.offsetHeight || 320;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + hh > window.innerHeight - 8) top = Math.max(8, r.top - hh - 6);
    el.style.left = left + "px"; el.style.top = top + "px";
  }
  function openSlotPicker(slot, anchor) {
    bstate.active = slot;
    var el = $("bd-picker");
    showEl(el);
    $("bd-picker-title").textContent = "Assign " + (ROLE_LABEL[slot] || slot);
    var s = $("bd-picker-search"); s.value = ""; renderSlotList("");
    $("bd-picker-list").scrollTop = 0;                 // always start at the top
    showEl($("bd-filter")); renderPickerFilters();
    anchorUnder(el, anchor);
    positionFilter();
    s.focus();
  }
  function closeSlotPicker() { hideEl($("bd-picker")); hideEl($("bd-filter")); closeSkillPicker(); bstate.active = null; }

  // ---- mare-picker filters (aptitude + skills), shown beside the picker ----
  var pickerApt = {}, pickerSkills = [];
  function pickerFiltersActive() { return pickerSkills.length > 0 || Object.keys(pickerApt).some(function (k) { return pickerApt[k]; }); }
  function pickerMatch(umaId) {
    var u = BYID[umaId]; if (!u) return true;
    for (var k in pickerApt) { if (pickerApt[k] && GRANK[aptGrade(u, k)] < GRANK.A) return false; }
    if (pickerSkills.length) {
      var names = umaSkillNames(u);
      for (var i = 0; i < pickerSkills.length; i++) { if (names.indexOf(pickerSkills[i].toLowerCase()) === -1) return false; }
    }
    return true;
  }
  function renderPickerFilters() {
    var host = $("bd-filter-body"); if (!host) return;
    var apt = APT_DEFS.map(function (g) {
      var chips = g.keys.map(function (k) {
        return '<button class="bdf-chip' + (pickerApt[k[0]] ? " on" : "") + '" data-apt="' + k[0] + '">' + k[1] + "</button>";
      }).join("");
      return '<div class="bdf-grp"><div class="bdf-h">' + g.label + " (A+)</div><div class=\"bdf-chips\">" + chips + "</div></div>";
    }).join("");
    var skillChips = pickerSkills.map(function (n) { return '<button class="bdf-chip sk on" data-rmskill="' + esc(n) + '">' + esc(n) + " ✕</button>"; }).join("");
    var skills = '<div class="bdf-grp"><div class="bdf-h">Skills</div><div class="bdf-chips">' + skillChips +
      '<button class="bdf-chip add" id="bdf-add-skill">+ skill</button></div></div>';
    host.innerHTML = apt + skills +
      (pickerFiltersActive() ? '<button class="cp-ghost bdf-clear" id="bdf-clear">CLEAR FILTERS</button>' : "");
  }
  function positionFilter() {
    var pk = $("bd-picker"), fl = $("bd-filter");
    if (pk.hidden || fl.hidden) return;
    var pr = pk.getBoundingClientRect(), fw = fl.offsetWidth || 210, fh = fl.offsetHeight || 220, gap = 8, left;
    if (pr.left - fw - gap >= 8) left = pr.left - fw - gap;                                   // room on the left
    else if (pr.right + gap + fw <= window.innerWidth - 8) left = pr.right + gap;             // else the right
    else left = Math.max(8, Math.min(pr.left, window.innerWidth - fw - 8));                   // fallback
    var top = Math.max(8, Math.min(pr.top, window.innerHeight - fh - 8));
    fl.style.left = left + "px"; fl.style.top = top + "px";
  }

  // ---- breeding tree right-click context menu ----
  var ctxSlot = null, ctxAnchor = null;
  // assign the uma that maximises this slot's affinity given the rest of the tree
  function autoPickSlot(slot) {
    var best = null, bestT = -Infinity;
    UMAS.forEach(function (u) { var t = affinityWith(slot, u.id); if (t > bestT) { bestT = t; best = u.id; } });
    if (best != null) { bstate[slot] = best; slotSpark[slot] = null; slotCard[slot] = null; renderBreeding(); }
  }
  // inline Tabler icons (MIT), self-hosted as SVG so no external requests
  var TABLER = {
    pick: '<path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
    auto: '<path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2z"/><path d="M16 6a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2z"/><path d="M9 18a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"/>',
    outfit: '<path d="M15 4l6 2v5h-3v8a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1v-8h-3v-5l6 -2a3 3 0 0 0 6 0"/>',
    view: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
    clear: '<path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>',
  };
  function tablerIco(act) {
    return '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (TABLER[act] || "") + "</svg>";
  }
  function ctxItem(act, label, cls) {
    return '<button type="button" class="bd-ctx-item' + (cls ? " " + cls : "") + '" data-act="' + act + '">' +
      '<span class="bd-ctx-ico">' + tablerIco(act) + "</span>" + label + "</button>";
  }
  function openCtx(slot, anchor, x, y) {
    ctxSlot = slot; ctxAnchor = anchor;
    var filled = !!bstate[slot];
    var canRank = SLOTS.some(function (k) { return k !== slot && bstate[k]; });
    var items = ctxItem("pick", filled ? "Change uma" : "Pick uma");
    if (canRank) items += ctxItem("auto", "Auto-pick best match");
    if (filled) {
      var u = BYID[bstate[slot]];
      if (u && u.alts && u.alts.length > 1) items += ctxItem("outfit", "Change outfit");
      items += ctxItem("view", "View in database");
      items += '<div class="bd-ctx-sep"></div>' + ctxItem("clear", "Clear slot", "danger");
    }
    var el = $("bd-ctx"); el.innerHTML = items; showEl(el);
    var w = el.offsetWidth || 190, h = el.offsetHeight || 160;
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
  }
  function closeCtx() { hideEl($("bd-ctx")); ctxSlot = null; ctxAnchor = null; }

  // ---- skill filter picker (mare-picker style, for the advanced SKILL filter) ----
  var skillCtx = null;   // null = database filter (state.skills); "picker" = mare-picker filter
  function activeSkillList() { return skillCtx === "picker" ? pickerSkills : state.skills; }
  function skillChanged() {
    if (skillCtx === "picker") { renderSlotList($("bd-picker-search").value); renderPickerFilters(); }
    else { render(); updateSkillTrigger(); }
  }
  function openSkillPicker(anchor, ctx) {
    skillCtx = ctx || null;
    var el = $("skill-picker");
    showEl(el);
    var s = $("skill-search"); s.value = ""; renderSkillList("");
    anchorUnder(el, anchor);
    s.focus();
  }
  function closeSkillPicker() { hideEl($("skill-picker")); skillCtx = null; }

  // ---- white-spark picker: catalog-backed (skills + fixed G1 races) ----
  var whitePickIdx = -1;
  function openWhitePicker(idx, anchor) {
    whitePickIdx = idx;
    var el = $("white-picker"); showEl(el);
    var s = $("white-search"); s.value = ""; renderWhiteList("");
    anchorUnder(el, anchor); s.focus();
  }
  function closeWhitePicker() { hideEl($("white-picker")); whitePickIdx = -1; }
  function whiteRow(name, iconId, kind) {
    var ico = kind === "race" ? raceBannerImg(RACE_BANNER[name], "bp-img wp-banner")
      : (iconId ? '<img class="bp-img sk-img" loading="lazy" src="/pakadb/assets/skill_icons/' + esc(iconId) + '.png" onerror="this.style.visibility=\'hidden\'" alt="" />'
                : '<span class="bp-img sk-img"></span>');
    return '<div class="bp-row" data-wpick="' + esc(name) + '">' + ico +
      '<div class="bp-meta"><div class="bp-name">' + esc(name) + '</div>' +
      '<div class="bp-sub">' + (kind === "race" ? "G1 race spark" : "skill") + "</div></div></div>";
  }
  function renderWhiteList(q) {
    q = (q || "").trim().toLowerCase();
    var races = RACES.filter(function (r) { return !q || r.name.toLowerCase().indexOf(q) !== -1; });
    var skills = WHITE_CATALOG.filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) !== -1; });
    var CAP = 80, shown = skills.slice(0, CAP);
    var html = "";
    if (races.length) html += '<div class="bp-note">G1 races</div>' + races.map(function (r) { return whiteRow(r.name, null, "race"); }).join("");
    html += '<div class="bp-note">Skills' + (skills.length > CAP ? " (top " + CAP + ", refine search)" : "") + "</div>" +
      shown.map(function (s) { return whiteRow(s.name, s.iconId, "skill"); }).join("");
    $("white-list").innerHTML = html;
  }
  function skillTriggerLabel() {
    var n = state.skills.length;
    return n === 0 ? "Any skill — tap to pick" : n === 1 ? state.skills[0] : n + " skills selected";
  }
  function updateSkillTrigger() {
    var t = $("cp-skill-trigger"); if (!t) return;
    t.textContent = skillTriggerLabel();
    t.classList.toggle("on", state.skills.length > 0);
  }
  function renderSkillList(q) {
    q = (q || "").trim().toLowerCase();
    var sel = activeSkillList();
    var list = SKILL_INDEX.filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) !== -1; });
    $("skill-list").innerHTML =
      '<div class="bp-row" data-skill=""><span class="bp-img sk-img sk-any">✕</span><div class="bp-meta"><div class="bp-name">Clear all</div></div></div>' +
      list.map(function (s) {
        var on = sel.indexOf(s.name) >= 0;
        var ico = s.iconId
          ? '<img class="bp-img sk-img" loading="lazy" src="/pakadb/assets/skill_icons/' + esc(s.iconId) + '.png" onerror="this.style.visibility=\'hidden\'" alt="" />'
          : '<span class="bp-img sk-img"></span>';
        return '<div class="bp-row' + (on ? " on" : "") + '" data-skill="' + esc(s.name) + '">' + ico +
          '<div class="bp-meta"><div class="bp-name">' + esc(s.name) + "</div></div>" +
          (on ? '<span class="sk-check">✓</span>' : "") + "</div>";
      }).join("");
  }
  function renderSlotList(q) {
    q = (q || "").trim().toLowerCase();
    var slot = bstate.active;
    var rank = !!slot && SLOTS.some(function (k) { return k !== slot && bstate[k]; });

    // saved umas first (carry sparks)
    var savedHtml = savedUmas.map(function (s, i) { return { s: s, i: i }; })
      .filter(function (x) { return (!q || (x.s.name || "").toLowerCase().indexOf(q) !== -1) && pickerMatch(x.s.charId); })
      .map(function (x) {
        var u = BYID[x.s.charId];
        return '<div class="bp-row" data-saved="' + x.i + '">' +
          '<img class="bp-img" loading="lazy" src="/pakadb/' + esc(u ? u.thumb : "") + '" alt="" />' +
          '<div class="bp-meta"><div class="bp-name">' + esc(x.s.name || (u && u.name)) + ' <span class="pk-tag">SPARKS</span></div>' +
          '<div class="bp-sub">saved uma</div></div>' +
          (rank ? '<span class="pk-aff">' + affinityWith(slot, x.s.charId) + "</span>" : "") + "</div>";
      }).join("");
    if (savedHtml) savedHtml = '<div class="bp-note">Your saved umas</div>' + savedHtml;

    // all outfits (base + alts) with photos
    var rows = outfitRows().filter(function (r) {
      return (!q || r.name.toLowerCase().indexOf(q) !== -1 || (r.title && r.title.toLowerCase().indexOf(q) !== -1)) && pickerMatch(r.id);
    }).map(function (r) { return { r: r, proj: rank ? affinityWith(slot, r.id) : 0 }; });
    if (rank) rows.sort(function (a, b) { return b.proj - a.proj || a.r.name.localeCompare(b.r.name); });
    else rows.sort(function (a, b) { return a.r.name.localeCompare(b.r.name) || (a.r.cardId - b.r.cardId); });
    var best = rank && rows.length ? rows[0].proj : 0;

    var outHtml = rows.map(function (x) {
      var r = x.r;
      return '<div class="bp-row" data-id="' + r.id + '" data-card="' + r.cardId + '">' +
        '<img class="bp-img" loading="lazy" src="/pakadb/' + esc(r.thumb) + '" alt="" onerror="this.src=\'/pakadb/' + esc(r.image) + "'\" />" +
        '<div class="bp-meta"><div class="bp-name">' + esc(r.name) + "</div>" +
        '<div class="bp-sub">' + (r.title ? esc(r.title) : "★".repeat(r.rarity || 0)) + "</div></div>" +
        (rank ? '<span class="pk-aff' + (x.proj === best ? " top" : "") + '">' + x.proj + "</span>" : "") + "</div>";
    }).join("");

    $("bd-picker-list").innerHTML = savedHtml +
      '<div class="bp-note">' + (rank ? "All outfits, ranked by resulting affinity ↓" : "All outfits") + "</div>" + outHtml;
  }

  // slot picker
  function openPicker(slot) {
    bstate.active = slot;
    $("cp-picker").hidden = false;
    $("cp-scrim").hidden = false;
    var s = $("cp-picker-search"); s.value = ""; renderPickerList("");
    s.focus();
  }
  function closePicker() { $("cp-picker").hidden = true; $("cp-scrim").hidden = true; bstate.active = null; }
  function renderPickerList(q) {
    q = (q || "").trim().toLowerCase();
    var slot = bstate.active;
    // rank by resulting affinity only if at least one OTHER slot is filled
    var rank = !!slot && ["foal", "p1", "p2", "gp11", "gp12", "gp21", "gp22"]
      .some(function (k) { return k !== slot && bstate[k]; });
    var list = UMAS.filter(function (u) { return !q || u.name.toLowerCase().indexOf(q) !== -1; })
      .map(function (u) { return { u: u, proj: rank ? affinityWith(slot, u.id) : 0 }; });
    if (rank) list.sort(function (a, b) { return b.proj - a.proj || a.u.name.localeCompare(b.u.name); });
    else list.sort(function (a, b) { return a.u.name.localeCompare(b.u.name); });
    var best = rank && list.length ? list[0].proj : 0;

    // saved umas (with sparks) first, filtered by query
    var savedHtml = "";
    var savedMatch = savedUmas.map(function (s, i) { return { s: s, i: i }; })
      .filter(function (x) { return !q || (x.s.name || "").toLowerCase().indexOf(q) !== -1; });
    if (savedMatch.length) {
      savedHtml = '<div class="pk-note">Your saved umas (carry sparks)</div>' + savedMatch.map(function (x) {
        var u = BYID[x.s.charId];
        return '<div class="pk-row" data-saved="' + x.i + '">' +
          '<img class="pk-img" loading="lazy" src="/pakadb/' + esc(u ? u.thumb : "") + '" alt="" />' +
          '<div class="pk-meta"><div class="pk-name">' + esc(x.s.name || (u && u.name)) + ' <span class="pk-tag">SPARKS</span></div>' +
          '<div class="pk-sub">#' + x.s.charId + "</div></div>" +
          (rank ? '<span class="pk-aff">' + affinityWith(slot, x.s.charId) + "</span>" : "") + "</div>";
      }).join("");
    }

    var note = rank ? '<div class="pk-note">All mares, ranked by resulting affinity ↓</div>' : '<div class="pk-note">All mares</div>';
    $("cp-picker-list").innerHTML = savedHtml + note + list.map(function (x) {
      var u = x.u;
      var badge = rank
        ? '<span class="pk-aff' + (x.proj === best ? " top" : "") + '">' + x.proj + "</span>"
        : "";
      return '<div class="pk-row" data-id="' + u.id + '">' +
        '<img class="pk-img" loading="lazy" src="/pakadb/' + esc(u.thumb) + '" alt="" onerror="this.src=\'/pakadb/' + esc(u.image) + "'\" />" +
        '<div class="pk-meta"><div class="pk-name">' + esc(u.name) + '</div><div class="pk-sub">#' + u.id + " " + "★".repeat(u.rarity || 0) + "</div></div>" +
        badge + "</div>";
    }).join("");
  }

  function resetTree() {
    SLOTS.forEach(function (k) { bstate[k] = null; slotSpark[k] = null; slotCard[k] = null; });
    closeSlotPicker();
    renderBreeding();
  }

  // ---- reusable Pakadle dropdown ----
  function initDropdown(el, onChange) {
    var btn = el.querySelector(".pd-dd-btn");
    var labelEl = el.querySelector(".pd-dd-label");
    var opts = Array.prototype.slice.call(el.querySelectorAll(".pd-dd-opt"));
    var prefix = el.getAttribute("data-prefix") || "";
    function setOpen(o) { el.classList.toggle("open", o); btn.setAttribute("aria-expanded", o ? "true" : "false"); }
    function choose(opt, fire) {
      opts.forEach(function (o) { o.classList.remove("sel"); o.setAttribute("aria-selected", "false"); });
      opt.classList.add("sel"); opt.setAttribute("aria-selected", "true");
      el.setAttribute("data-value", opt.getAttribute("data-value"));
      if (labelEl) labelEl.textContent = prefix + opt.textContent;
      if (fire && onChange) onChange(opt.getAttribute("data-value"));
    }
    btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(!el.classList.contains("open")); });
    el.addEventListener("click", function (e) { e.stopPropagation(); });
    opts.forEach(function (o) { o.addEventListener("click", function () { choose(o, true); setOpen(false); }); });
    document.addEventListener("click", function () { setOpen(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
    var cur = el.getAttribute("data-value");
    var initial = opts.filter(function (o) { return o.getAttribute("data-value") === cur; })[0] || opts[0];
    if (initial) choose(initial, false);
  }

  // ---- wiring ----
  $("cp-grid").addEventListener("click", function (e) {
    var el = e.target.closest(".unit"); if (!el) return;
    // clicking the already-open mare toggles the drawer shut
    if (el.classList.contains("sel") && $("cp-drawer").classList.contains("open")) { closeDrawer(); return; }
    var u = UMAS.find(function (x) { return String(x.id) === el.getAttribute("data-id"); });
    if (!u) return;
    var prev = document.querySelector(".unit.sel"); if (prev) prev.classList.remove("sel");
    el.classList.add("sel");
    openDrawer(u);
  });
  $("cp-scrim").addEventListener("click", function () { closeDrawer(); closePicker(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { if (!$("bd-ctx").hidden) return closeCtx(); if (!$("white-picker").hidden) return closeWhitePicker(); closeDrawer(); closePicker(); closeRoster(); closeTrees(); closeEditor(); closeSkillPicker(); closeSlotPicker(); } });

  // ---- pakadle tooltip: one floating bubble driven by [data-tip], clip-proof ----
  (function () {
    var tip = $("pk-tip"), cur = null;
    function show(el) {
      var txt = el.getAttribute("data-tip"); if (!txt) return;
      cur = el; tip.innerHTML = txt; tip.hidden = false;   // tips may carry <span class='tip-uma'> highlights
      var r = el.getBoundingClientRect();
      var below = r.top < 46;
      tip.classList.toggle("below", below);
      var tw = tip.offsetWidth;
      var cx = Math.max(8 + tw / 2, Math.min(r.left + r.width / 2, window.innerWidth - 8 - tw / 2));
      tip.style.left = cx + "px";
      tip.style.top = (below ? r.bottom + 8 : r.top - 8) + "px";
      tip.classList.add("on");
    }
    function hide() { cur = null; tip.classList.remove("on"); tip.hidden = true; }
    document.addEventListener("mouseover", function (e) { var el = e.target.closest && e.target.closest("[data-tip]"); if (el && el !== cur) show(el); });
    document.addEventListener("mouseout", function (e) { if (cur && (!e.relatedTarget || !cur.contains(e.relatedTarget))) hide(); });
    document.addEventListener("focusin", function (e) { var el = e.target.closest && e.target.closest("[data-tip]"); if (el) show(el); });
    document.addEventListener("focusout", hide);
    window.addEventListener("scroll", hide, true);
  })();
  $("cp-search").addEventListener("input", function (e) { state.q = e.target.value.trim().toLowerCase(); render(); });
  initDropdown($("cp-sort"), function (v) { state.sort = v; render(); });

  function toggleInArr(arr, val) {
    var i = arr.indexOf(val); if (i >= 0) arr.splice(i, 1); else arr.push(val); return arr;
  }
  // quick rail (chips + advanced toggle + clear)
  $("cp-filters").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    if (b.id === "cp-clear") return clearFilters();
    if (b.id === "cp-adv-toggle") { state.advOpen = !state.advOpen; return syncFilterUI(); }
    var q = b.getAttribute("data-quick");
    if (q) { if (state.aptMin[q]) delete state.aptMin[q]; else state.aptMin[q] = "A"; syncFilterUI(); render(); }
  });
  // advanced panel (grade buttons, rarity, growth, stat mins, skill)
  $("cp-adv").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    if (b.id === "cp-skill-trigger") return openSkillPicker(b);
    var step = b.getAttribute("data-step");
    if (step) {
      var stat = b.getAttribute("data-stat");
      var input = b.parentNode.querySelector(".numc-val");
      var cur = parseInt(input.value, 10); if (isNaN(cur)) cur = 0;
      var nv = Math.max(0, cur + Number(step));
      input.value = nv || "";
      if (nv > 0) state.statMin[stat] = nv; else delete state.statMin[stat];
      return render();
    }
    var apt = b.getAttribute("data-apt");
    if (apt) {
      var g = b.getAttribute("data-grade");
      if (state.aptMin[apt] === g) delete state.aptMin[apt]; else state.aptMin[apt] = g;
    }
    var rr = b.getAttribute("data-rarity"); if (rr) toggleInArr(state.rarity, Number(rr));
    var gr = b.getAttribute("data-growth"); if (gr) toggleInArr(state.growth, gr);
    syncFilterUI(); render();
  });
  $("cp-adv").addEventListener("input", function (e) {
    var s = e.target.getAttribute("data-statmin");
    if (s) {
      var digits = e.target.value.replace(/[^0-9]/g, "");
      if (digits !== e.target.value) e.target.value = digits;
      var v = parseInt(digits, 10);
      if (v > 0) state.statMin[s] = v; else delete state.statMin[s];
      return render();
    }
  });

  // drag-scrub the min-stat fields left/right to lower/raise the value (click still types).
  // The value updates live while dragging, but the filter only runs on release.
  (function () {
    var drag = null;
    document.addEventListener("pointerdown", function (e) {
      var val = e.target.closest ? e.target.closest(".numc-val") : null; if (!val) return;
      drag = { el: val, startX: e.clientX, startVal: parseInt(val.value, 10) || 0, cur: parseInt(val.value, 10) || 0, moved: false, stat: val.getAttribute("data-statmin") };
      if (val.setPointerCapture) val.setPointerCapture(e.pointerId);
    });
    document.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 4) return;      // small move = still a click (type)
      if (!drag.moved) { var sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges(); }
      drag.moved = true; e.preventDefault();
      document.body.classList.add("scrubbing");
      drag.cur = Math.max(0, drag.startVal + Math.round(dx / 3));  // ~3px per unit
      drag.el.value = drag.cur || "";                             // live display only, no filtering yet
    });
    document.addEventListener("pointerup", function (e) {
      if (!drag) return;
      if (drag.moved) {                                           // commit the filter on release
        if (drag.el.blur) drag.el.blur();
        if (drag.cur > 0) state.statMin[drag.stat] = drag.cur; else delete state.statMin[drag.stat];
        render();
      }
      if (drag.el.releasePointerCapture) try { drag.el.releasePointerCapture(e.pointerId); } catch (_) {}
      drag = null; document.body.classList.remove("scrubbing");
    });
  })();

  // skill filter picker
  $("skill-search").addEventListener("input", function (e) { renderSkillList(e.target.value); });
  $("skill-x").addEventListener("click", closeSkillPicker);
  $("skill-clear").addEventListener("click", function () { activeSkillList().length = 0; skillChanged(); renderSkillList($("skill-search").value); });
  $("skill-list").addEventListener("click", function (e) {
    var row = e.target.closest(".bp-row"); if (!row) return;
    var sel = activeSkillList();
    var name = row.getAttribute("data-skill") || "";
    if (name === "") {                                  // "Clear all" row: full re-render
      sel.length = 0;
      skillChanged(); renderSkillList($("skill-search").value);
      return;
    }
    // toggle in place so the list keeps its scroll position (no jump), stays open
    var i = sel.indexOf(name);
    var check = row.querySelector(".sk-check");
    if (i >= 0) { sel.splice(i, 1); row.classList.remove("on"); if (check) check.remove(); }
    else {
      sel.push(name); row.classList.add("on");
      if (!check) { var sp = document.createElement("span"); sp.className = "sk-check"; sp.textContent = "✓"; row.appendChild(sp); }
    }
    skillChanged();
  });
  document.addEventListener("click", function (e) {
    if ($("skill-picker").hidden) return;
    if (e.target.closest("#skill-picker") || e.target.closest("#cp-skill-trigger")) return;
    closeSkillPicker();
  });

  // view toggle
  function setView(v) {
    var breed = v === "breed";
    $("view-db").hidden = breed;
    $("view-breed").hidden = !breed;
    $("cp-db-controls").hidden = breed;
    $("cp-breed-controls").hidden = !breed;
    Array.prototype.forEach.call(document.querySelectorAll(".cp-tab"), function (t) {
      t.classList.toggle("on", t.getAttribute("data-view") === v);
    });
    if (breed) { $("cp-count").textContent = "PEDIGREE PLANNER"; renderBreeding(); }
    else render();
  }
  $("cp-tabs").addEventListener("click", function (e) {
    var b = e.target.closest(".cp-tab"); if (b) setView(b.getAttribute("data-view"));
  });

  // breeding interactions: tree slots open the popup anchored under the slot
  $("bd-stage").addEventListener("click", function (e) {
    if (suppressNodeClick) { suppressNodeClick = false; return; }
    var n = e.target.closest(".bd-node"); if (n) openSlotPicker(n.getAttribute("data-slot"), n);
  });
  $("bd-stage").addEventListener("contextmenu", function (e) {
    var n = e.target.closest(".bd-node"); if (!n) return;
    e.preventDefault(); closeSlotPicker();
    openCtx(n.getAttribute("data-slot"), n, e.clientX, e.clientY);
  });
  // the lineage map is editable: click a portrait to change the uma, a spark to edit its sparks
  $("bd-affinity").addEventListener("click", function (e) {
    var g = e.target.closest(".lm-node"); if (!g) return;
    var slot = g.getAttribute("data-slot"); if (!slot) return;
    e.stopPropagation();
    if (g.getAttribute("data-spark") != null) openSlotSparkEditor(slot);
    else openSlotPicker(slot, g);
  });

  // ---- drag a filled tree node onto another slot to move / swap it ----
  var drag = null, suppressNodeClick = false;
  function swapSlots(a, b) {
    var t;
    t = bstate[a]; bstate[a] = bstate[b]; bstate[b] = t;
    t = slotSpark[a]; slotSpark[a] = slotSpark[b]; slotSpark[b] = t;
    t = slotCard[a]; slotCard[a] = slotCard[b]; slotCard[b] = t;
  }
  function clearDropHi() { Array.prototype.forEach.call($("bd-stage").querySelectorAll(".drop-hi"), function (x) { x.classList.remove("drop-hi"); }); }
  $("bd-stage").addEventListener("dragstart", function (e) { e.preventDefault(); }); // kill native image drag
  $("bd-stage").addEventListener("mousedown", function (e) {
    if (e.button !== 0) return;
    var n = e.target.closest(".bd-node"); if (!n) return;
    var slot = n.getAttribute("data-slot"); if (!bstate[slot]) return;   // only filled nodes drag
    drag = { slot: slot, node: n, sx: e.clientX, sy: e.clientY, moved: false, ghost: null };
  });
  document.addEventListener("mousemove", function (e) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 6) return;   // click, not a drag
      drag.moved = true;
      var th = slotThumb(drag.slot), g = document.createElement("div");
      g.className = "bd-drag-ghost"; g.innerHTML = th ? '<img src="/pakadb/' + esc(th.thumb) + '" alt="" />' : "";
      document.body.appendChild(g); drag.ghost = g;
      drag.node.classList.add("drag-src");
      document.body.classList.add("bd-dragging");
    }
    drag.ghost.style.left = e.clientX + "px";
    drag.ghost.style.top = e.clientY + "px";
    clearDropHi();
    var hit = document.elementFromPoint(e.clientX, e.clientY), tgt = hit && hit.closest ? hit.closest(".bd-node") : null;
    if (tgt && tgt.getAttribute("data-slot") !== drag.slot) tgt.classList.add("drop-hi");
  });
  document.addEventListener("mouseup", function (e) {
    if (!drag) return;
    var d = drag; drag = null;
    document.body.classList.remove("bd-dragging");
    if (d.ghost) d.ghost.remove();
    if (d.node) d.node.classList.remove("drag-src");
    clearDropHi();
    if (!d.moved) return;   // was a plain click; leave it for the click handler
    suppressNodeClick = true; setTimeout(function () { suppressNodeClick = false; }, 0);
    var hit = document.elementFromPoint(e.clientX, e.clientY), tgt = hit && hit.closest ? hit.closest(".bd-node") : null;
    if (tgt) { var to = tgt.getAttribute("data-slot"); if (to && to !== d.slot) { swapSlots(d.slot, to); renderBreeding(); } }
  });
  $("bd-ctx").addEventListener("click", function (e) {
    var it = e.target.closest(".bd-ctx-item"); if (!it || !ctxSlot) return;
    e.stopPropagation();   // don't let this click reach the picker's outside-click closer
    var act = it.getAttribute("data-act"), slot = ctxSlot, anchor = ctxAnchor;
    closeCtx();
    if (act === "pick") openSlotPicker(slot, anchor);
    else if (act === "auto") autoPickSlot(slot);
    else if (act === "view") { var u = BYID[bstate[slot]]; if (u) openDrawer(u); }
    else if (act === "outfit") { var uo = BYID[bstate[slot]]; openSlotPicker(slot, anchor); if (uo) { $("bd-picker-search").value = uo.name; renderSlotList(uo.name); } }
    else if (act === "clear") { bstate[slot] = null; slotSpark[slot] = null; slotCard[slot] = null; renderBreeding(); }
  });
  document.addEventListener("click", function (e) {
    if ($("bd-ctx").hidden) return;
    if (e.target.closest("#bd-ctx")) return;
    closeCtx();
  });
  window.addEventListener("scroll", function () { if (!$("bd-ctx").hidden) closeCtx(); }, true);
  // close the popup when clicking outside it (but not when opening from a slot or using the filters)
  document.addEventListener("click", function (e) {
    if ($("bd-picker").hidden) return;
    if (e.target.closest("#bd-picker") || e.target.closest("#bd-filter") || e.target.closest("#skill-picker") ||
        e.target.closest(".bd-node") || e.target.closest(".lm-node")) return;
    closeSlotPicker();
  });
  // mare-picker filter panel
  $("bd-filter").addEventListener("click", function (e) {
    e.stopPropagation();   // don't let filter clicks reach the picker / skill-picker outside-closers
    var apt = e.target.closest("[data-apt]");
    if (apt) { var k = apt.getAttribute("data-apt"); pickerApt[k] = !pickerApt[k]; renderPickerFilters(); renderSlotList($("bd-picker-search").value); $("bd-picker-list").scrollTop = 0; return; }
    var rm = e.target.closest("[data-rmskill]");
    if (rm) { var n = rm.getAttribute("data-rmskill"), i = pickerSkills.indexOf(n); if (i >= 0) pickerSkills.splice(i, 1); renderPickerFilters(); renderSlotList($("bd-picker-search").value); return; }
    if (e.target.id === "bdf-add-skill") { return openSkillPicker(e.target, "picker"); }
    if (e.target.id === "bdf-clear") { pickerApt = {}; pickerSkills.length = 0; renderPickerFilters(); renderSlotList($("bd-picker-search").value); $("bd-picker-list").scrollTop = 0; return; }
  });
  $("bd-picker-search").addEventListener("input", function (e) { renderSlotList(e.target.value); $("bd-picker-list").scrollTop = 0; });
  $("bd-picker-close").addEventListener("click", closeSlotPicker);
  $("bd-picker-clear").addEventListener("click", function () {
    if (bstate.active) { bstate[bstate.active] = null; slotSpark[bstate.active] = null; slotCard[bstate.active] = null; renderBreeding(); }
    closeSlotPicker();
  });
  $("bd-picker-list").addEventListener("click", function (e) {
    var row = e.target.closest(".bp-row"); if (!row || !bstate.active) return;
    var slot = bstate.active;
    var savedIdx = row.getAttribute("data-saved");
    if (savedIdx != null) {
      var s = savedUmas[Number(savedIdx)];
      bstate[slot] = s.charId; slotSpark[slot] = s; slotCard[slot] = null;
    } else {
      bstate[slot] = Number(row.getAttribute("data-id"));
      slotCard[slot] = Number(row.getAttribute("data-card"));
      slotSpark[slot] = null;
    }
    renderBreeding();
    renderSlotList($("bd-picker-search").value);   // keep the picker open (re-rank after the pick)
  });
  $("cp-breed-reset").addEventListener("click", resetTree);
  $("cp-picker-search").addEventListener("input", function (e) { renderPickerList(e.target.value); });
  $("cp-picker-x").addEventListener("click", closePicker);
  $("cp-picker-clear").addEventListener("click", function () {
    if (bstate.active) { bstate[bstate.active] = null; slotSpark[bstate.active] = null; renderBreeding(); }
    closePicker();
  });
  $("cp-picker-list").addEventListener("click", function (e) {
    var row = e.target.closest(".pk-row"); if (!row || !bstate.active) return;
    var slot = bstate.active;
    var savedIdx = row.getAttribute("data-saved");
    if (savedIdx != null) {
      var s = savedUmas[Number(savedIdx)];
      bstate[slot] = s.charId; slotSpark[slot] = s;      // saved uma carries its sparks
    } else {
      bstate[slot] = Number(row.getAttribute("data-id")); slotSpark[slot] = null;
    }
    renderBreeding();
    closePicker();
  });

  // ---- roster wiring ----
  $("cp-roster-open").addEventListener("click", openRoster);
  $("cp-roster-x").addEventListener("click", closeRoster);
  $("cp-roster-new").addEventListener("click", function () { openEditor(null); });
  $("cp-roster-list").addEventListener("click", function (e) {
    var ed = e.target.closest(".rost-edit"), del = e.target.closest(".rost-del");
    if (ed) return openEditor(Number(ed.getAttribute("data-edit")));
    if (del) {
      savedUmas.splice(Number(del.getAttribute("data-del")), 1); persistRoster(); renderRoster();
      return;
    }
  });

  // ---- tree-profile wiring ----
  $("cp-trees-open").addEventListener("click", openTrees);
  $("cp-trees-x").addEventListener("click", closeTrees);
  $("cp-trees-body").addEventListener("click", function (e) {
    var del = e.target.closest("[data-deltree]");
    if (del) { savedTrees.splice(Number(del.getAttribute("data-deltree")), 1); persistTrees(); renderTrees(); return; }
    if (e.target.id === "tree-save-btn") {
      var nm = (($("tree-name") || {}).value || "").trim() || ("Tree " + (savedTrees.length + 1));
      savedTrees.push(treeSnapshot(nm)); persistTrees(); renderTrees(); return;
    }
    var row = e.target.closest("[data-load]");
    if (row) loadTree(Number(row.getAttribute("data-load")));
  });
  $("cp-trees-body").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.id === "tree-name") { e.preventDefault(); $("tree-save-btn").click(); }
  });

  // ---- editor wiring ----
  $("cp-editor-x").addEventListener("click", closeEditor);
  $("cp-editor-body").addEventListener("click", function (e) {
    if (!editing) return;
    var star = e.target.closest(".star");
    if (star) {
      var kind = star.getAttribute("data-kind"), key = star.getAttribute("data-key"), lvl = Number(star.getAttribute("data-lvl"));
      if (kind === "blue") editing.blue[key] = lvl;
      else if (kind === "pink") editing.pink[key] = lvl;
      else if (kind === "green") editing.green = lvl;
      else if (kind === "white") { if (editing.white[Number(key)]) editing.white[Number(key)].lvl = lvl; }
      return renderEditor();
    }
    if (e.target.id === "ed-add-white") { editing.white.push({ name: "", lvl: 1 }); return renderEditor(); }
    var wpick = e.target.closest(".ed-wpick");
    if (wpick) { return openWhitePicker(Number(wpick.getAttribute("data-wi")), wpick); }
    var wdel = e.target.closest(".ed-wdel");
    if (wdel) { editing.white.splice(Number(wdel.getAttribute("data-wdel")), 1); return renderEditor(); }
  });
  $("cp-editor-body").addEventListener("input", function (e) {
    if (!editing) return;
    if (e.target.classList.contains("ed-char")) {
      editing.charId = Number(e.target.value);
      var u = BYID[editing.charId]; editing.name = u ? u.name : editing.name;
      return renderEditor();
    }
  });

  // white-spark picker wiring
  $("white-search").addEventListener("input", function (e) { renderWhiteList(e.target.value); });
  $("white-close").addEventListener("click", closeWhitePicker);
  $("white-list").addEventListener("click", function (e) {
    var row = e.target.closest(".bp-row"); if (!row) return;
    var name = row.getAttribute("data-wpick");
    if (editing && editing.white[whitePickIdx]) editing.white[whitePickIdx].name = name;
    closeWhitePicker(); renderEditor();
  });
  document.addEventListener("click", function (e) {
    if ($("white-picker").hidden) return;
    if (e.target.closest("#white-picker") || e.target.closest(".ed-wpick")) return;
    closeWhitePicker();
  });
  $("cp-editor-save").addEventListener("click", function () {
    if (!editing) return;
    var rec = JSON.parse(JSON.stringify(editing)); var idx = rec._idx, slot = rec._slot; delete rec._idx; delete rec._slot;
    if (slot) {   // slot mode: write straight back to the tree slot (from the lineage map)
      slotSpark[slot] = rec; bstate[slot] = rec.charId; slotCard[slot] = null;
      closeEditor(); renderBreeding(); return;
    }
    if (idx != null) savedUmas[idx] = rec; else savedUmas.push(rec);
    persistRoster(); closeEditor(); openRoster();
  });

  $("cp-scrim").addEventListener("click", function () { closeRoster(); closeEditor(); closeTrees(); });

  loadRoster();
  loadTrees();
  load();
})();
