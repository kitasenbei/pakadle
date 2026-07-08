// Pakadle account auth for the main page. Self-contained: injects its own modal
// + styles, wires the header "Sign in" button, and talks to the shared /api/auth
// endpoints (the same accounts used by Pakachess and Duel). Three flows live in
// one modal: Sign in, Create account, and Forgot password (recovery code OR an
// admin-enabled recovery mode). CSP allows 'self' scripts + inline styles.
(function () {
  "use strict";

  var authBtn = document.getElementById("auth-btn");
  var chip = document.getElementById("acct-chip");
  var chipName = document.getElementById("acct-name");
  if (!authBtn) return; // header not present -> nothing to do

  var account = null;

  // ---------- styles ----------
  var css = document.createElement("style");
  css.textContent = [
    "#auth-btn{font-family:inherit;font-weight:800;font-size:.95rem;cursor:pointer;",
    "  color:#fff;background:var(--slate);border:none;border-radius:12px;padding:8px 14px;",
    "  box-shadow:0 3px 0 #625a72;transition:transform .05s}",
    "#auth-btn:active{transform:translateY(3px);box-shadow:0 0 0 #625a72}",
    "#acct-chip{display:inline-flex;align-items:center;gap:6px;font-weight:800;",
    "  color:var(--ink);background:var(--key-bg);border:2px solid var(--tile-line);",
    "  border-radius:12px;padding:6px 12px}",
    "#acct-chip::before{content:'\\1F40E'}",
    ".pa-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;",
    "  justify-content:center;background:rgba(58,46,57,.45);padding:16px}",
    ".pa-overlay[hidden]{display:none}",
    ".pa-card{position:relative;width:100%;max-width:360px;background:var(--panel);",
    "  border-radius:18px;box-shadow:0 12px 40px var(--shadow);padding:22px;",
    "  font-family:inherit;color:var(--ink)}",
    ".pa-x{position:absolute;top:10px;right:12px;border:none;background:none;",
    "  font-size:1.5rem;line-height:1;cursor:pointer;color:var(--ink-soft)}",
    ".pa-tabs{display:flex;gap:6px;margin-bottom:16px}",
    ".pa-tab{flex:1;font-family:inherit;font-weight:800;font-size:.85rem;cursor:pointer;",
    "  padding:8px 4px;border:none;border-radius:10px;background:var(--key-bg);color:var(--ink-soft)}",
    ".pa-tab.on{background:var(--turf);color:#fff;box-shadow:0 2px 0 var(--turf-dark)}",
    ".pa-body label{display:block;font-weight:700;font-size:.85rem;margin:0 0 12px}",
    ".pa-body input{display:block;width:100%;box-sizing:border-box;margin-top:5px;",
    "  font-family:inherit;font-size:1rem;padding:10px 12px;border:2px solid var(--tile-line);",
    "  border-radius:10px;background:var(--bg);color:var(--ink)}",
    ".pa-body input:focus{outline:none;border-color:var(--turf)}",
    ".pa-err{color:var(--err);font-weight:700;font-size:.82rem;min-height:1.1em;margin:0 0 10px}",
    ".pa-go{width:100%;font-family:inherit;font-weight:800;font-size:1rem;cursor:pointer;",
    "  color:#fff;background:var(--sakura);border:none;border-radius:12px;padding:12px;",
    "  box-shadow:0 3px 0 #c94a74}",
    ".pa-go:active{transform:translateY(3px);box-shadow:0 0 0 #c94a74}",
    ".pa-link{display:block;width:100%;text-align:center;margin-top:12px;background:none;",
    "  border:none;font-family:inherit;font-weight:700;font-size:.82rem;color:var(--ink-soft);",
    "  cursor:pointer;text-decoration:underline}",
    ".pa-hint{font-size:.82rem;color:var(--ink-soft);margin:-4px 0 12px;line-height:1.4}",
    ".pa-code{margin:14px 0;padding:14px;border-radius:12px;background:var(--gold);color:var(--ink);",
    "  text-align:center;font-weight:800;letter-spacing:.06em;font-size:1.15rem;word-break:break-all}",
    ".pa-code small{display:block;font-size:.72rem;font-weight:700;letter-spacing:0;margin-bottom:6px;opacity:.8}"
  ].join("");
  document.head.appendChild(css);

  // ---------- modal DOM ----------
  var overlay = document.createElement("div");
  overlay.className = "pa-overlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="pa-card" role="dialog" aria-modal="true">' +
    '  <button class="pa-x" data-close aria-label="Close">×</button>' +
    '  <div class="pa-tabs">' +
    '    <button class="pa-tab on" data-mode="login">Sign in</button>' +
    '    <button class="pa-tab" data-mode="register">Create account</button>' +
    '  </div>' +
    '  <div class="pa-body">' +
    '    <p class="pa-hint" data-hint hidden></p>' +
    '    <div data-code-box hidden></div>' +
    '    <label data-name-row>Trainer name<input data-name type="text" maxlength="24" autocomplete="username" spellcheck="false" /></label>' +
    '    <label data-code-row hidden>Recovery code<input data-code type="text" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX" /></label>' +
    '    <label data-pass-row>Password<input data-pass type="password" maxlength="200" autocomplete="current-password" /></label>' +
    '    <p class="pa-err" data-err></p>' +
    '    <button class="pa-go" data-go>Sign in</button>' +
    '    <button class="pa-link" data-forgot>Forgot password?</button>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(overlay);

  var q = function (sel) { return overlay.querySelector(sel); };
  var els = {
    card: q(".pa-card"), tabs: overlay.querySelectorAll(".pa-tab"),
    hint: q("[data-hint]"), codeBox: q("[data-code-box]"),
    nameRow: q("[data-name-row]"), nameI: q("[data-name]"),
    codeRow: q("[data-code-row]"), codeI: q("[data-code]"),
    passRow: q("[data-pass-row]"), passI: q("[data-pass]"),
    err: q("[data-err]"), go: q("[data-go]"), forgot: q("[data-forgot]"),
    tabsWrap: q(".pa-tabs")
  };

  // ---------- helpers ----------
  function toast(msg) {
    if (typeof window.pakadleToast === "function") return window.pakadleToast(msg);
    var wrap = document.getElementById("toast-wrap");
    if (!wrap) { return; }
    var t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    wrap.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }
  function api(path, payload) {
    return fetch(path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
  }
  function showCode(code) {
    els.codeBox.hidden = false;
    els.codeBox.className = "pa-code";
    els.codeBox.innerHTML = "<small>SAVE YOUR RECOVERY CODE</small>" + code;
  }

  function renderAccount() {
    if (account) {
      if (chip) { chip.hidden = false; chipName.textContent = account.name; }
      authBtn.textContent = "Sign out";
    } else {
      if (chip) chip.hidden = true;
      authBtn.textContent = "Sign in";
    }
  }

  // mode: "login" | "register" | "forgot"
  var mode = "login";
  function setMode(m) {
    mode = m;
    els.err.textContent = "";
    els.codeBox.hidden = true;
    els.tabsWrap.style.display = m === "forgot" ? "none" : "flex";
    els.tabs.forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-mode") === m); });
    if (m === "forgot") {
      els.hint.hidden = false;
      els.hint.textContent = "Enter your name. If an admin enabled recovery for you, you can set a new password right away; otherwise enter your recovery code.";
      els.codeRow.hidden = true;      // revealed after we learn the mode
      els.passRow.hidden = true;      // revealed after we learn the mode
      els.forgot.style.display = "none";
      els.go.textContent = "Continue";
      els.passI.setAttribute("autocomplete", "new-password");
      forgotStage = "begin";
    } else {
      els.hint.hidden = true;
      els.codeRow.hidden = true;
      els.passRow.hidden = false;
      els.forgot.style.display = m === "login" ? "block" : "none";
      els.go.textContent = m === "login" ? "Sign in" : "Create account";
      els.passI.setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
    }
  }

  var forgotStage = "begin"; // "begin" -> ask name; "code"/"recovery-mode" -> set pw
  function open(m) {
    setMode(m || "login");
    overlay.hidden = false;
    setTimeout(function () { els.nameI.focus(); }, 30);
  }
  function close() { overlay.hidden = true; els.passI.value = ""; els.codeI.value = ""; }

  // ---------- submit ----------
  function submit() {
    var name = (els.nameI.value || "").trim();
    els.err.textContent = "";
    if (mode === "forgot") return submitForgot(name);
    var password = els.passI.value || "";
    if (!name || !password) { els.err.textContent = "Enter a name and password."; return; }
    var path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    els.go.disabled = true;
    api(path, { name: name, password: password }).then(function (r) {
      els.go.disabled = false;
      if (!r.ok) { els.err.textContent = r.d.error || "Something went wrong."; return; }
      account = r.d.account; renderAccount();
      if (r.d.recovery) {
        // brand-new (or backfilled) code: keep the modal open so they can copy it
        showCode(r.d.recovery);
        els.nameRow.hidden = true; els.passRow.hidden = true;
        els.forgot.style.display = "none"; els.tabsWrap.style.display = "none";
        els.hint.hidden = false;
        els.hint.textContent = "Welcome, " + account.name + "! Write this code down; it's the only way to reset your password if you forget it. It won't be shown again.";
        els.go.textContent = "Done";
        mode = "done";
      } else {
        close();
        toast("Welcome back, " + account.name + "!");
      }
    }).catch(function () { els.go.disabled = false; els.err.textContent = "Connection error."; });
  }

  function submitForgot(name) {
    if (forgotStage === "begin") {
      if (!name) { els.err.textContent = "Enter your trainer name."; return; }
      els.go.disabled = true;
      api("/api/auth/reset-begin", { name: name }).then(function (r) {
        els.go.disabled = false;
        forgotStage = r.d.mode === "recovery-mode" ? "recovery-mode" : "code";
        els.nameRow.hidden = true;
        els.passRow.hidden = false;
        els.go.textContent = "Set new password";
        if (forgotStage === "recovery-mode") {
          els.codeRow.hidden = true;
          els.hint.textContent = "Recovery is enabled for “" + name + "”. Choose a new password below.";
          els.passI.focus();
        } else {
          els.codeRow.hidden = false;
          els.hint.textContent = "Recovery isn't enabled for “" + name + "”. Enter the recovery code you saved (plus a new password), or ask an administrator to turn on recovery for your account.";
          els.codeI.focus();
        }
      }).catch(function () { els.go.disabled = false; els.err.textContent = "Connection error."; });
      return;
    }
    // stage: set the new password
    var password = els.passI.value || "";
    var code = els.codeI.value || "";
    if (password.length < 6) { els.err.textContent = "New password must be at least 6 characters."; return; }
    if (forgotStage === "code" && !code.trim()) { els.err.textContent = "Enter your recovery code."; return; }
    els.go.disabled = true;
    api("/api/auth/reset", { name: name, code: code, password: password }).then(function (r) {
      els.go.disabled = false;
      if (!r.ok) { els.err.textContent = r.d.error || "Could not reset."; return; }
      account = r.d.account; renderAccount();
      els.nameRow.hidden = true; els.codeRow.hidden = true; els.passRow.hidden = true;
      els.hint.hidden = false;
      els.hint.textContent = "Password reset for " + account.name + ". You're signed in. Here's your new recovery code; save it.";
      if (r.d.recovery) showCode(r.d.recovery);
      els.go.textContent = "Done";
      mode = "done";
    }).catch(function () { els.go.disabled = false; els.err.textContent = "Connection error."; });
  }

  // ---------- wiring ----------
  authBtn.addEventListener("click", function () {
    if (account) {
      api("/api/auth/logout", {}).catch(function () {});
      account = null; renderAccount(); toast("Signed out");
    } else {
      open("login");
    }
  });
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay || e.target.hasAttribute("data-close")) close();
  });
  els.go.addEventListener("click", function () {
    if (mode === "done") { close(); return; }
    submit();
  });
  els.forgot.addEventListener("click", function () { setMode("forgot"); });
  els.tabs.forEach(function (t) {
    t.addEventListener("click", function () { setMode(t.getAttribute("data-mode")); });
  });
  overlay.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && mode !== "done") { e.preventDefault(); submit(); }
    if (e.key === "Escape") close();
  });

  // ---------- boot: who am I? ----------
  fetch("/api/auth/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) { account = d.account || null; renderAccount(); })
    .catch(function () { renderAccount(); });
})();
