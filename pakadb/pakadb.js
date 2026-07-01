/* PakaDB control panel — renders the gametora-sourced dataset (pakadb/data/umas.json).
   Read-only character DB today; the scaffolding (breeding.json) is in place for the
   breeding tool to layer on later. Vanilla JS, no deps. */
(function () {
  "use strict";

  var GRADES = ["S", "A", "B", "C", "D", "E", "F", "G"];
  var GRANK = {}; GRADES.forEach(function (g, i) { GRANK[g] = GRADES.length - i; });
  var STAT_KEYS = ["speed", "stamina", "power", "guts", "wit"];
  var STAT_ABBR = { speed: "SPD", stamina: "STA", power: "PWR", guts: "GUT", wit: "WIT" };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function gradeCls(g) { return "g-" + (g && GRANK[g] ? g : "null"); }
  function gradeTxt(g) { return g && GRANK[g] ? g : "-"; }

  var UMAS = [];
  var STATMAX = { speed: 1, stamina: 1, power: 1, guts: 1, wit: 1 };
  var state = { q: "", sort: "name", filters: [] }; // filters: [{cat,key}]

  // filter definitions
  var FILTERS = [
    { label: "SURFACE", cat: "surface", keys: [["turf", "TURF"], ["dirt", "DIRT"]] },
    { label: "DIST", cat: "distance", keys: [["short", "SPRINT"], ["mile", "MILE"], ["medium", "MED"], ["long", "LONG"]] },
    { label: "STYLE", cat: "style", keys: [["front", "FRONT"], ["pace", "PACE"], ["late", "LATE"], ["end", "END"]] },
  ];

  function load() {
    fetch("/pakadb/data/umas.json").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      UMAS = data;
      STAT_KEYS.forEach(function (k) {
        STATMAX[k] = data.reduce(function (m, u) {
          return Math.max(m, (u.statsMax && u.statsMax[k]) || 0);
        }, 1);
      });
      buildFilters();
      render();
    }).catch(function (e) {
      $("cp-grid").innerHTML = "";
      var p = $("cp-empty"); p.hidden = false; p.textContent = "DATA LOAD FAILED: " + e.message;
    });
  }

  function buildFilters() {
    var host = $("cp-filters");
    host.innerHTML = FILTERS.map(function (grp) {
      var chips = grp.keys.map(function (k) {
        return '<button class="chip" data-cat="' + grp.cat + '" data-key="' + k[0] + '">' + k[1] + "</button>";
      }).join("");
      return '<div class="fgroup"><span class="fgroup-l">' + grp.label + "</span>" + chips + "</div>";
    }).join("") + '<button class="chip" id="cp-clear" style="margin-left:auto">CLEAR</button>';

    host.addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      if (b.id === "cp-clear") {
        state.filters = [];
        host.querySelectorAll(".chip.on").forEach(function (c) { c.classList.remove("on"); });
        return render();
      }
      var cat = b.getAttribute("data-cat"), key = b.getAttribute("data-key");
      var i = state.filters.findIndex(function (f) { return f.cat === cat && f.key === key; });
      if (i >= 0) { state.filters.splice(i, 1); b.classList.remove("on"); }
      else { state.filters.push({ cat: cat, key: key }); b.classList.add("on"); }
      render();
    });
  }

  function passes(u) {
    if (state.q && u.name.toLowerCase().indexOf(state.q) === -1) return false;
    for (var i = 0; i < state.filters.length; i++) {
      var f = state.filters[i];
      var g = u.aptitude && u.aptitude[f.cat] && u.aptitude[f.cat][f.key];
      if (!(GRANK[g] >= GRANK.A)) return false; // require A or better
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
          '<div class="unit-sub"><span class="unit-star">' + "★".repeat(u.rarity || 0) + "</span> #" + u.id + "</div>" +
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
    return '<div class="stat"><span class="stat-l">' + STAT_ABBR[k] +
      (g ? '<span class="growth-tag">+' + g + "%</span>" : "") + "</span>" +
      '<span class="stat-bar"><span class="stat-fill f-' + k + '" style="width:' + pct + '%"></span></span>' +
      '<span class="stat-n">' + v + "</span></div>";
  }

  function aptCell(k, g) {
    return '<div class="apt-cell"><div class="apt-k">' + k + '</div><div class="apt-v v-' +
      (g && GRANK[g] ? g : "null") + '">' + gradeTxt(g) + "</div></div>";
  }

  function skillRow(s, type) {
    return '<div class="skill"><div class="skill-h">' +
      '<span class="skill-tag t-' + type + '">' + type + "</span>" +
      '<span class="skill-n">' + esc(s.name) + "</span></div>" +
      (s.desc ? '<div class="skill-d">' + esc(s.desc) + "</div>" : "") + "</div>";
  }

  function evoRow(e) {
    return '<div class="skill"><div class="skill-h">' +
      '<span class="skill-tag t-evo">evo</span>' +
      '<span class="skill-n">' + esc(e.old && e.old.name) +
      ' <span class="skill-arrow">▸</span> ' + esc(e.new && e.new.name) + "</span></div>" +
      (e.new && e.new.desc ? '<div class="skill-d">' + esc(e.new.desc) + "</div>" : "") + "</div>";
  }

  function bioRow(k, v) { return '<div class="bio-row"><span class="bio-k">' + k + '</span><span class="bio-v">' + esc(v) + "</span></div>"; }

  function openDrawer(u) {
    var ap = u.aptitude || { surface: {}, distance: {}, style: {} };
    var sk = u.skills || {};
    var bio = u.bio || {};

    var skillsHtml = "";
    (sk.unique || []).forEach(function (s) { skillsHtml += skillRow(s, "unique"); });
    (sk.innate || []).forEach(function (s) { skillsHtml += skillRow(s, "innate"); });
    (sk.awakening || []).forEach(function (s) { skillsHtml += skillRow(s, "awakening"); });
    (sk.evo || []).forEach(function (e) { skillsHtml += evoRow(e); });
    (sk.event || []).forEach(function (s) { skillsHtml += skillRow(s, "event"); });

    var bd = bio.birthday;
    var bioHtml = "";
    if (bd) bioHtml += bioRow("Birthday", (bd.month || "?") + "/" + (bd.day || "?"));
    if (bio.height) bioHtml += bioRow("Height", bio.height + " cm");
    if (bio.vaJa) bioHtml += bioRow("VA (JP)", bio.vaJa);
    if (bio.realLife && bio.realLife.active) bioHtml += bioRow("RL active", bio.realLife.active);
    if (bio.realLife && bio.realLife.country) bioHtml += bioRow("RL country", String(bio.realLife.country).toUpperCase());

    $("cp-drawer-inner").innerHTML =
      '<div class="dh">' +
        '<img class="dh-img" src="/pakadb/' + esc(u.image) + '" alt="" />' +
        '<div class="dh-meta">' +
          '<div class="dh-name">' + esc(u.name) + "</div>" +
          '<div class="dh-jp">' + esc(u.nameJp || "") + " · <span class='unit-star'>" + "★".repeat(u.rarity || 0) + "</span></div>" +
          (u.title ? '<div class="dh-title">' + esc(u.title) + "</div>" : "") +
        "</div>" +
        '<button class="dh-x" id="cp-close">✕</button>' +
      "</div>" +
      '<div class="sect"><div class="sect-h">Base Aptitude</div>' +
        '<div class="apt-grid">' +
          aptCell("TURF", ap.surface.turf) + aptCell("DIRT", ap.surface.dirt) +
          aptCell("SPRINT", ap.distance.short) + aptCell("MILE", ap.distance.mile) +
          aptCell("MED", ap.distance.medium) + aptCell("LONG", ap.distance.long) +
          aptCell("FRONT", ap.style.front) + aptCell("PACE", ap.style.pace) +
          aptCell("LATE", ap.style.late) + aptCell("END", ap.style.end) +
        "</div></div>" +
      '<div class="sect"><div class="sect-h">Stats (5★ base) · growth</div>' +
        STAT_KEYS.map(function (k) { return statBar(u, k); }).join("") + "</div>" +
      '<div class="sect"><div class="sect-h">Skills</div>' + (skillsHtml || '<div class="skill-d">None listed.</div>') + "</div>" +
      (bioHtml ? '<div class="sect"><div class="sect-h">Profile</div>' + bioHtml + "</div>" : "");

    $("cp-drawer").classList.add("open");
    $("cp-drawer").setAttribute("aria-hidden", "false");
    $("cp-scrim").hidden = false;
    $("cp-close").addEventListener("click", closeDrawer);
  }

  function closeDrawer() {
    $("cp-drawer").classList.remove("open");
    $("cp-drawer").setAttribute("aria-hidden", "true");
    $("cp-scrim").hidden = true;
    var s = document.querySelector(".unit.sel"); if (s) s.classList.remove("sel");
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
    var u = UMAS.find(function (x) { return String(x.id) === el.getAttribute("data-id"); });
    if (!u) return;
    var prev = document.querySelector(".unit.sel"); if (prev) prev.classList.remove("sel");
    el.classList.add("sel");
    openDrawer(u);
  });
  $("cp-scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
  $("cp-search").addEventListener("input", function (e) { state.q = e.target.value.trim().toLowerCase(); render(); });
  initDropdown($("cp-sort"), function (v) { state.sort = v; render(); });

  load();
})();
