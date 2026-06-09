// Pakadle notifications: a tiny, self-contained "what's new" center shared by
// every bundled game (Pakadle, Duel, …). It injects its own styles + a bell
// button into the page header, tracks which announcements you've already seen in
// localStorage, and auto-opens the panel the first time there's something unread.
//
// Add an entry to ANNOUNCEMENTS (newest first) to broadcast an update. Bump or
// change an `id` to re-notify everyone.
(function () {
  "use strict";

  // newest first. Each needs a STABLE unique id; `tag` is an optional pill.
  var ANNOUNCEMENTS = [
    {
      id: "v0.5.0-relax-daily-anti-peek",
      date: "v0.5.0 · June 2026",
      tag: "Fair play",
      title: "Daily Pakadle drops its tab-switching penalty",
      body:
        "The daily Pakadle no longer locks when a player switches tabs or windows mid-puzzle. " +
        "The anti-peek penalty added in v0.4.0 has been removed from the daily game, and leaving " +
        "the tab no longer counts as a loss." +
        "<ul>" +
        "<li><b>Pakadle:</b> no tab-switch penalty. The daily plays out as a solo puzzle again.</li>" +
        "<li><b>Pakadle Duel:</b> the penalty remains. Leaving the tab mid-round still forfeits " +
        "the match and deducts 100 rating.</li>" +
        "</ul>",
    },
    {
      id: "v0.4.0-anti-peek",
      date: "v0.4.0 · June 2026",
      tag: "Fair play",
      title: "No more peeking: tab-switching is now penalized",
      body:
        "<b>What changed in v0.4.0:</b>" +
        "<ul>" +
        "<li><b>Pakadle:</b> switch tabs or windows while a puzzle is live and " +
        "today's puzzle is now <b>locked</b>: it counts as a loss and you can't resume it until the next daily reset.</li>" +
        "<li><b>Pakadle Duel:</b> switch tabs or windows mid-round and you now " +
        "<b>automatically forfeit the match and lose 100 rating</b>.</li>" +
        "<li>Added this <b>notifications center</b> (the 🔔) so updates like this one reach you in-game.</li>" +
        "</ul>" +
        "Keep your eyes on the grid. The horses are watching. 🐎👀",
    },
  ];

  var SEEN_KEY = "pakadle_notes_seen";

  function loadSeen() {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "[]") || []; }
    catch (e) { return []; }
  }
  function saveSeen(ids) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids)); } catch (e) {}
  }
  function unseenCount() {
    var seen = loadSeen();
    return ANNOUNCEMENTS.filter(function (a) { return seen.indexOf(a.id) === -1; }).length;
  }
  function markAllSeen() {
    saveSeen(ANNOUNCEMENTS.map(function (a) { return a.id; }));
  }

  function injectStyles() {
    if (document.getElementById("pk-note-styles")) return;
    var css =
      ".pk-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;" +
      "width:38px;height:38px;border-radius:50%;border:none;cursor:pointer;font-size:18px;" +
      "background:rgba(0,0,0,.06);color:inherit;line-height:1;transition:background .15s,transform .1s}" +
      ".pk-bell:hover{background:rgba(0,0,0,.12)}.pk-bell:active{transform:scale(.94)}" +
      ".pk-bell-dot{position:absolute;top:5px;right:5px;min-width:16px;height:16px;padding:0 4px;" +
      "border-radius:9px;background:#E85D8B;color:#fff;font-size:11px;font-weight:800;line-height:16px;" +
      "text-align:center;box-shadow:0 0 0 2px #FBF5EA}" +
      ".pk-note-overlay{position:fixed;inset:0;z-index:9999;display:none;align-items:flex-start;" +
      "justify-content:center;background:rgba(40,30,40,.45);backdrop-filter:blur(2px);padding:64px 16px 16px}" +
      ".pk-note-overlay.open{display:flex}" +
      ".pk-note-card{width:min(440px,100%);max-height:80vh;overflow:auto;background:#FFFDF8;border-radius:18px;" +
      "box-shadow:0 18px 50px rgba(0,0,0,.3);padding:18px 18px 8px;animation:pk-pop .22s ease}" +
      "@keyframes pk-pop{from{transform:translateY(-12px) scale(.97);opacity:0}to{transform:none;opacity:1}}" +
      ".pk-note-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}" +
      ".pk-note-head h2{margin:0;font-size:20px}" +
      ".pk-note-x{border:none;background:none;font-size:24px;line-height:1;cursor:pointer;color:#7C748F}" +
      ".pk-note-item{border:1px solid rgba(0,0,0,.08);border-radius:14px;padding:12px 14px;margin-bottom:12px;background:#fff}" +
      ".pk-note-item.unread{border-color:#E85D8B;box-shadow:0 0 0 2px rgba(232,93,139,.12)}" +
      ".pk-note-meta{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;color:#9a93a6}" +
      ".pk-note-tag{background:#E85D8B;color:#fff;font-weight:800;border-radius:8px;padding:1px 7px;font-size:11px}" +
      ".pk-note-item h3{margin:2px 0 6px;font-size:16px}" +
      ".pk-note-item .pk-note-body{font-size:14px;line-height:1.45;color:#4a4452}" +
      ".pk-note-body ul{margin:6px 0 0;padding-left:20px}.pk-note-body li{margin:4px 0}" +
      ".pk-note-empty{text-align:center;color:#9a93a6;padding:24px 0}";
    var st = document.createElement("style");
    st.id = "pk-note-styles";
    st.textContent = css;
    document.head.appendChild(st);
  }

  var overlay, dot, bell;

  function renderPanel() {
    var seen = loadSeen();
    var items = ANNOUNCEMENTS.length
      ? ANNOUNCEMENTS.map(function (a) {
          var unread = seen.indexOf(a.id) === -1;
          return (
            '<div class="pk-note-item' + (unread ? " unread" : "") + '">' +
            '<div class="pk-note-meta">' +
            (a.tag ? '<span class="pk-note-tag">' + a.tag + "</span>" : "") +
            "<span>" + (a.date || "") + "</span></div>" +
            "<h3>" + a.title + "</h3>" +
            '<div class="pk-note-body">' + a.body + "</div></div>"
          );
        }).join("")
      : '<div class="pk-note-empty">No notifications yet. 🐎</div>';
    overlay.querySelector(".pk-note-list").innerHTML = items;
  }

  function openPanel() {
    renderPanel();
    overlay.classList.add("open");
    markAllSeen();
    updateBadge();
  }
  function closePanel() { overlay.classList.remove("open"); }

  function updateBadge() {
    if (!dot) return;
    var n = unseenCount();
    if (n > 0) { dot.textContent = n > 9 ? "9+" : String(n); dot.style.display = ""; }
    else dot.style.display = "none";
  }

  function buildBell() {
    bell = document.createElement("button");
    bell.className = "pk-bell";
    bell.type = "button";
    bell.setAttribute("aria-label", "Notifications");
    bell.title = "What's new";
    bell.innerHTML = '🔔<span class="pk-bell-dot" style="display:none"></span>';
    dot = bell.querySelector(".pk-bell-dot");
    bell.addEventListener("click", function () {
      if (overlay.classList.contains("open")) closePanel(); else openPanel();
    });
    var actions = document.querySelector("header .actions");
    if (actions) actions.insertBefore(bell, actions.firstChild);
    else { bell.style.position = "fixed"; bell.style.top = "12px"; bell.style.right = "12px"; bell.style.zIndex = "9998"; document.body.appendChild(bell); }
  }

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.className = "pk-note-overlay";
    overlay.innerHTML =
      '<div class="pk-note-card">' +
      '<div class="pk-note-head"><h2>🔔 What\'s new</h2>' +
      '<button class="pk-note-x" aria-label="Close">×</button></div>' +
      '<div class="pk-note-list"></div></div>';
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closePanel(); });
    overlay.querySelector(".pk-note-x").addEventListener("click", closePanel);
    document.body.appendChild(overlay);
  }

  function init() {
    injectStyles();
    buildOverlay();
    buildBell();
    updateBadge();
    // first-time-seeing-an-update: pop the panel open shortly after load
    if (unseenCount() > 0) setTimeout(openPanel, 900);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
