/* PakaDB control panel: renders the gametora-sourced dataset (pakadb/data/umas.json).
   Read-only character DB today; the scaffolding (breeding.json) is in place for the
   breeding tool to layer on later. Vanilla JS, no deps. */
(function () {
  "use strict";

  var GRADES = ["S", "A", "B", "C", "D", "E", "F", "G"];
  var GRANK = {}; GRADES.forEach(function (g, i) { GRANK[g] = GRADES.length - i; });
  var STAT_KEYS = ["speed", "stamina", "power", "guts", "wit"];
  var STAT_ABBR = { speed: "SPD", stamina: "STA", power: "PWR", guts: "GUT", wit: "WIT" };

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
  var BYID = {};
  var BREED = { relationPoints: {}, members: {} };
  var STATMAX = { speed: 1, stamina: 1, power: 1, guts: 1, wit: 1 };
  // filter state: aptMin[key]=grade (require >=), rarity[] set, growth[] stats,
  // statMin{stat:n}, skill substring.
  var state = { q: "", sort: "name", advOpen: false, aptMin: {}, rarity: [], growth: [], statMin: {}, skill: "" };

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
    ]).then(function (res) {
      UMAS = res[0]; BREED = res[1] || BREED;
      BYID = {}; UMAS.forEach(function (u) { BYID[u.id] = u; });
      STAT_KEYS.forEach(function (k) {
        STATMAX[k] = UMAS.reduce(function (m, u) { return Math.max(m, (u.statsMax && u.statsMax[k]) || 0); }, 1);
      });
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
      return '<button class="chip" data-growth="' + k + '">' + STAT_ABBR[k] + " +</button>";
    }).join("");
    var statMin = STAT_KEYS.map(function (k) {
      return '<label class="adv-num"><span>' + STAT_ABBR[k] + " ≥</span><input type=\"number\" min=\"0\" step=\"1\" data-statmin=\"" + k + "\" placeholder=\"" + STATMAX[k] + "\" /></label>";
    }).join("");
    $("cp-adv").innerHTML =
      '<div class="adv-col adv-apt">' + apt + "</div>" +
      '<div class="adv-col">' +
        '<div class="adv-sub"><div class="adv-sub-h">RARITY</div><div class="adv-chips">' + rarity + "</div></div>" +
        '<div class="adv-sub"><div class="adv-sub-h">GROWTH BONUS</div><div class="adv-chips">' + growth + "</div></div>" +
        '<div class="adv-sub"><div class="adv-sub-h">MIN STAT (5★ base)</div><div class="adv-nums">' + statMin + "</div></div>" +
        '<div class="adv-sub"><div class="adv-sub-h">SKILL NAME CONTAINS</div><input id="cp-adv-skill" class="cp-input" style="width:100%" type="search" placeholder="e.g. corner, straightaway, speed…" autocomplete="off" /></div>' +
      "</div>";
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
    state.aptMin = {}; state.rarity = []; state.growth = []; state.statMin = {}; state.skill = "";
    Array.prototype.forEach.call(document.querySelectorAll("[data-statmin]"), function (i) { i.value = ""; });
    var sk = document.getElementById("cp-adv-skill"); if (sk) sk.value = "";
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
    if (state.skill && umaSkillNames(u).indexOf(state.skill) === -1) return false;
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
          '<div class="unit-sub"><span class="unit-star">' + "★".repeat(u.rarity || 0) + "</span> #" + u.id +
            (u.alts && u.alts.length > 1 ? ' <span class="unit-alts">+' + (u.alts.length - 1) + " fits</span>" : "") +
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
      '<img class="stat-ico" src="/pakadb/assets/stat_icons/' + k + '.png" alt="' + STAT_ABBR[k] + '" title="' + STAT_ABBR[k] + '" />' +
      (g ? '<span class="growth-tag">+' + g + "%</span>" : "") + "</span>" +
      '<span class="stat-bar"><span class="stat-fill f-' + k + '" style="width:' + pct + '%"></span></span>' +
      '<span class="stat-n">' + v + "</span></div>";
  }

  function aptCell(k, g) {
    return '<div class="apt-cell"><div class="apt-k">' + k + '</div><div class="apt-v v-' +
      (g && GRANK[g] ? g : "null") + '">' + gradeTxt(g) + "</div></div>";
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
        '<div class="apt-grid">' +
          aptCell("TURF", ap.surface.turf) + aptCell("DIRT", ap.surface.dirt) +
          aptCell("SPRINT", ap.distance.short) + aptCell("MILE", ap.distance.mile) +
          aptCell("MED", ap.distance.medium) + aptCell("LONG", ap.distance.long) +
          aptCell("FRONT", ap.style.front) + aptCell("PACE", ap.style.pace) +
          aptCell("LATE", ap.style.late) + aptCell("END", ap.style.end) +
        "</div></div>" +
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
        (uskill ? '<div class="bd-node-uniq" title="Unique skill (green factor)">' + skillIcon(uskill) + esc(uskill.name) + "</div>" : "") +
      "</div></div>";
  }

  function affinity() {
    var f = bstate.foal;
    var dP1 = compatDetail(f, bstate.p1), dP2 = compatDetail(f, bstate.p2), d12 = compatDetail(bstate.p1, bstate.p2);
    var gps = [bstate.gp11, bstate.gp12, bstate.gp21, bstate.gp22];
    var gpP = 0, gpB = 0;
    gps.forEach(function (g) { var d = compatDetail(f, g); gpP += d.pts; gpB += d.bonds; });
    return {
      cP1: dP1.pts, cP2: dP2.pts, p12: d12.pts, cGP: gpP,
      bP1: dP1.bonds, bP2: dP2.bonds, b12: d12.bonds, bGP: gpB,
      total: dP1.pts + dP2.pts + d12.pts + gpP,
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

    var svg = '<svg width="' + w + '" height="' + h + '" style="display:inline-block">';
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

    renderFactors();
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
      .map(function (k) { return '<span class="fac-chip fac-blue">' + STAT_ABBR[k] + " ★" + f.blue[k] + "</span>"; }).join("");
    var starsPink = APT_KEYS.filter(function (k) { return f.pink[k]; })
      .map(function (k) { return '<span class="fac-chip fac-pink">' + KEY_LABEL[k] + " ★" + f.pink[k] + "</span>"; }).join("");
    var green = Object.keys(f.green).map(function (n) { return '<span class="fac-chip fac-green">' + esc(n) + " ★" + f.green[n] + "</span>"; }).join("");
    var white = Object.keys(f.white).map(function (n) { return '<span class="fac-chip fac-white">' + esc(n) + " ★" + f.white[n] + "</span>"; }).join("");
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
    var weak = 0;
    var cells = APT_KEYS.map(function (k) {
      var g = aptGrade(foal, k);
      var isWeak = GRANK[g] < GRANK.B;
      if (isWeak) weak++;
      return '<span class="fcov-c v-' + (g && GRANK[g] ? g : "null") + (isWeak ? " weak" : "") + '" title="' + esc(KEY_LABEL[k]) + '">' +
        '<small class="fcov-k">' + APT_ABBR[k] + "</small>" + gradeTxt(g) + "</span>";
    }).join("");
    return '<div class="fcov"><div class="fcov-h">APTITUDE' + (weak ? ' <span class="fcov-w">' + weak + " weak</span>" : "") + "</div>" +
      '<div class="fcov-cells">' + cells + "</div></div>";
  }

  // ---- saved-uma roster ----
  function openRoster() { showEl($("cp-roster")); showEl($("cp-scrim")); renderRoster(); }
  function closeRoster() { hideEl($("cp-roster")); hideEl($("cp-scrim")); }
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
  function renderEditor() {
    var e = editing; if (!e) return;
    var u = BYID[e.charId];
    var uskill = (u && u.skills && u.skills.unique && u.skills.unique[0]) ? u.skills.unique[0] : null;
    var uniqName = uskill ? uskill.name : "Unique skill";
    var opts = UMAS.map(function (x) { return '<option value="' + x.id + '"' + (x.id === e.charId ? " selected" : "") + ">" + esc(x.name) + "</option>"; }).join("");
    var blue = STAT_KEYS.map(function (k) { return '<div class="ed-row"><span class="ed-k">' + STAT_ABBR[k] + '</span><div class="ed-stars">' + starCtl("blue", k, e.blue[k] || 0) + "</div></div>"; }).join("");
    var pink = APT_KEYS.map(function (k) { return '<div class="ed-row"><span class="ed-k">' + KEY_LABEL[k] + '</span><div class="ed-stars">' + starCtl("pink", k, e.pink[k] || 0) + "</div></div>"; }).join("");
    var white = (e.white || []).map(function (w, i) {
      return '<div class="ed-white"><input class="cp-input ed-wname" data-wi="' + i + '" value="' + esc(w.name || "") + '" placeholder="skill or race name" />' +
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
  function openSlotPicker(slot, anchor) {
    bstate.active = slot;
    var el = $("bd-picker");
    showEl(el);
    $("bd-picker-title").textContent = "Assign " + (ROLE_LABEL[slot] || slot);
    var s = $("bd-picker-search"); s.value = ""; renderSlotList("");
    // anchor the popup right under the tapped slot (menu-style), clamped to viewport
    if (anchor && anchor.getBoundingClientRect) {
      var r = anchor.getBoundingClientRect();
      var w = el.offsetWidth || 290, hh = el.offsetHeight || 320;
      var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      var top = r.bottom + 6;
      if (top + hh > window.innerHeight - 8) top = Math.max(8, r.top - hh - 6);
      el.style.left = left + "px"; el.style.top = top + "px";
    }
    s.focus();
  }
  function closeSlotPicker() { hideEl($("bd-picker")); bstate.active = null; }
  function renderSlotList(q) {
    q = (q || "").trim().toLowerCase();
    var slot = bstate.active;
    var rank = !!slot && SLOTS.some(function (k) { return k !== slot && bstate[k]; });

    // saved umas first (carry sparks)
    var savedHtml = savedUmas.map(function (s, i) { return { s: s, i: i }; })
      .filter(function (x) { return !q || (x.s.name || "").toLowerCase().indexOf(q) !== -1; })
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
      return !q || r.name.toLowerCase().indexOf(q) !== -1 || (r.title && r.title.toLowerCase().indexOf(q) !== -1);
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
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeDrawer(); closePicker(); closeRoster(); closeEditor(); } });
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
      var v = parseInt(e.target.value, 10);
      if (v > 0) state.statMin[s] = v; else delete state.statMin[s];
      return render();
    }
    if (e.target.id === "cp-adv-skill") { state.skill = e.target.value.trim().toLowerCase(); render(); }
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
    var n = e.target.closest(".bd-node"); if (n) openSlotPicker(n.getAttribute("data-slot"), n);
  });
  // close the popup when clicking outside it (but not when opening from a slot)
  document.addEventListener("click", function (e) {
    if ($("bd-picker").hidden) return;
    if (e.target.closest("#bd-picker") || e.target.closest(".bd-node")) return;
    closeSlotPicker();
  });
  $("bd-picker-search").addEventListener("input", function (e) { renderSlotList(e.target.value); });
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
    closeSlotPicker();
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
    var wi = e.target.getAttribute("data-wi");
    if (wi != null && editing.white[Number(wi)]) editing.white[Number(wi)].name = e.target.value;
  });
  $("cp-editor-save").addEventListener("click", function () {
    if (!editing) return;
    var rec = JSON.parse(JSON.stringify(editing)); var idx = rec._idx; delete rec._idx;
    if (idx != null) savedUmas[idx] = rec; else savedUmas.push(rec);
    persistRoster(); closeEditor(); openRoster();
  });

  $("cp-scrim").addEventListener("click", function () { closeRoster(); closeEditor(); });

  loadRoster();
  load();
})();
