// Pakadle account auth for the main page. Self-contained: injects its own styles
// and TWO separate modals (one for Sign in / Create account, one for account
// Recovery), then wires the header "Sign in" button. Accounts are shared with
// Pakachess and Duel via the /api/auth endpoints. CSP allows 'self' scripts +
// inline styles.
//
// Recovery has no email and no codes: an admin flips recovery mode on an account
// with `pakadle --recover <name>`, then the owner opens the recovery modal, types
// just their account name, and (if enabled) sets a new password.
(function () {
  "use strict";

  var authBtn = document.getElementById("auth-btn");
  var chip = document.getElementById("acct-chip");
  var chipName = document.getElementById("acct-name");
  if (!authBtn) return;

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
    "#acct-chip[hidden]{display:none}",
    "@media (max-width:560px){",
    "  #auth-btn{height:34px;padding:0 12px;font-size:.85rem}",
    "  #acct-chip{padding:5px 10px;font-size:.85rem}",
    "}",
    "#acct-chip::before{content:'\\1F40E'}",
    ".pa-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;",
    "  justify-content:center;background:rgba(58,46,57,.45);padding:16px}",
    ".pa-overlay[hidden]{display:none}",
    ".pa-card{position:relative;width:100%;max-width:360px;background:var(--panel);",
    "  border-radius:18px;box-shadow:0 12px 40px var(--shadow);padding:22px;",
    "  font-family:inherit;color:var(--ink)}",
    ".pa-x{position:absolute;top:10px;right:12px;border:none;background:none;",
    "  font-size:1.5rem;line-height:1;cursor:pointer;color:var(--ink-soft)}",
    ".pa-title{font-weight:800;font-size:1.15rem;margin:0 0 14px;color:var(--ink)}",
    ".pa-tabs{display:flex;gap:6px;margin-bottom:16px}",
    ".pa-tab{flex:1;font-family:inherit;font-weight:800;font-size:.85rem;cursor:pointer;",
    "  padding:8px 4px;border:none;border-radius:10px;background:var(--key-bg);color:var(--ink-soft)}",
    ".pa-tab.on{background:var(--turf);color:#fff;box-shadow:0 2px 0 var(--turf-dark)}",
    ".pa-card label{display:block;font-weight:700;font-size:.85rem;margin:0 0 12px}",
    ".pa-card [hidden]{display:none}",
    ".pa-card input{display:block;width:100%;box-sizing:border-box;margin-top:5px;",
    "  font-family:inherit;font-size:1rem;padding:10px 12px;border:2px solid var(--tile-line);",
    "  border-radius:10px;background:var(--bg);color:var(--ink)}",
    ".pa-card input:focus{outline:none;border-color:var(--turf)}",
    ".pa-err{color:var(--err);font-weight:700;font-size:.82rem;min-height:1.1em;margin:0 0 10px}",
    ".pa-hint{font-size:.82rem;color:var(--ink-soft);margin:0 0 12px;line-height:1.4}",
    ".pa-go{width:100%;font-family:inherit;font-weight:800;font-size:1rem;cursor:pointer;",
    "  color:#fff;background:var(--sakura);border:none;border-radius:12px;padding:12px;",
    "  box-shadow:0 3px 0 #c94a74}",
    ".pa-go:active{transform:translateY(3px);box-shadow:0 0 0 #c94a74}",
    ".pa-link{display:block;width:100%;text-align:center;margin-top:12px;background:none;",
    "  border:none;font-family:inherit;font-weight:700;font-size:.82rem;color:var(--ink-soft);",
    "  cursor:pointer;text-decoration:underline}"
  ].join("");
  document.head.appendChild(css);

  // ---------- helpers ----------
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function toast(msg) {
    if (typeof window.pakadleToast === "function") return window.pakadleToast(msg);
    var wrap = document.getElementById("toast-wrap");
    if (!wrap) return;
    var t = el("div", { class: "toast" }); t.textContent = msg;
    wrap.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }
  function api(path, payload) {
    return fetch(path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
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

  // ==================== sign-in / register modal ====================
  var loginOverlay = el("div", { class: "pa-overlay" });
  loginOverlay.hidden = true;
  loginOverlay.innerHTML =
    '<div class="pa-card" role="dialog" aria-modal="true">' +
    '  <button class="pa-x" data-close aria-label="Close">×</button>' +
    '  <div class="pa-tabs">' +
    '    <button class="pa-tab on" data-mode="login">Sign in</button>' +
    '    <button class="pa-tab" data-mode="register">Create account</button>' +
    '  </div>' +
    '  <label>Trainer name<input data-name type="text" maxlength="24" autocomplete="username" spellcheck="false" /></label>' +
    '  <label>Password<input data-pass type="password" maxlength="200" autocomplete="current-password" /></label>' +
    '  <p class="pa-err" data-err></p>' +
    '  <button class="pa-go" data-go>Sign in</button>' +
    '  <button class="pa-link" data-forgot>Forgot password?</button>' +
    '</div>';
  document.body.appendChild(loginOverlay);

  var L = {
    tabs: loginOverlay.querySelectorAll(".pa-tab"),
    nameI: loginOverlay.querySelector("[data-name]"),
    passI: loginOverlay.querySelector("[data-pass]"),
    err: loginOverlay.querySelector("[data-err]"),
    go: loginOverlay.querySelector("[data-go]"),
    forgot: loginOverlay.querySelector("[data-forgot]")
  };
  var loginMode = "login";
  function setLoginMode(m) {
    loginMode = m;
    L.err.textContent = "";
    L.tabs.forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-mode") === m); });
    L.go.textContent = m === "login" ? "Sign in" : "Create account";
    L.passI.setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
  }
  function openLogin() {
    setLoginMode("login");
    loginOverlay.hidden = false;
    setTimeout(function () { L.nameI.focus(); }, 30);
  }
  function closeLogin() { loginOverlay.hidden = true; L.passI.value = ""; }

  function submitLogin() {
    var name = (L.nameI.value || "").trim();
    var password = L.passI.value || "";
    L.err.textContent = "";
    if (!name || !password) { L.err.textContent = "Enter a name and password."; return; }
    var path = loginMode === "login" ? "/api/auth/login" : "/api/auth/register";
    L.go.disabled = true;
    api(path, { name: name, password: password }).then(function (r) {
      L.go.disabled = false;
      if (!r.ok) { L.err.textContent = r.d.error || "Something went wrong."; return; }
      account = r.d.account; renderAccount(); closeLogin();
      toast(loginMode === "login" ? "Welcome back, " + account.name + "!" : "Account created. Good luck out there!");
    }).catch(function () { L.go.disabled = false; L.err.textContent = "Connection error."; });
  }

  // ==================== recovery modal (separate) ====================
  var recOverlay = el("div", { class: "pa-overlay" });
  recOverlay.hidden = true;
  recOverlay.innerHTML =
    '<div class="pa-card" role="dialog" aria-modal="true">' +
    '  <button class="pa-x" data-close aria-label="Close">×</button>' +
    '  <p class="pa-title">Recover account</p>' +
    '  <p class="pa-hint" data-hint>Enter your account name to recover it.</p>' +
    '  <label data-name-row>Account name<input data-name type="text" maxlength="24" autocomplete="username" spellcheck="false" /></label>' +
    '  <label data-pass-row hidden>New password<input data-pass type="password" maxlength="200" autocomplete="new-password" /></label>' +
    '  <p class="pa-err" data-err></p>' +
    '  <button class="pa-go" data-go>Continue</button>' +
    '</div>';
  document.body.appendChild(recOverlay);

  var R = {
    hint: recOverlay.querySelector("[data-hint]"),
    nameRow: recOverlay.querySelector("[data-name-row]"),
    nameI: recOverlay.querySelector("[data-name]"),
    passRow: recOverlay.querySelector("[data-pass-row]"),
    passI: recOverlay.querySelector("[data-pass]"),
    err: recOverlay.querySelector("[data-err]"),
    go: recOverlay.querySelector("[data-go]")
  };
  var recStage = "name"; // "name" -> ask name; "setpw" -> set new password; "done"
  function openRecovery(prefill) {
    recStage = "name";
    R.hint.textContent = "Enter your account name to recover it.";
    R.nameRow.hidden = false; R.passRow.hidden = true;
    R.passI.value = ""; R.err.textContent = "";
    R.go.textContent = "Continue"; R.go.disabled = false;
    if (prefill) R.nameI.value = prefill;
    recOverlay.hidden = false;
    setTimeout(function () { R.nameI.focus(); }, 30);
  }
  function closeRecovery() { recOverlay.hidden = true; R.passI.value = ""; }

  function submitRecovery() {
    R.err.textContent = "";
    var name = (R.nameI.value || "").trim();
    if (recStage === "done") { closeRecovery(); return; }
    if (recStage === "name") {
      if (!name) { R.err.textContent = "Enter your account name."; return; }
      R.go.disabled = true;
      api("/api/auth/reset-begin", { name: name }).then(function (r) {
        R.go.disabled = false;
        if (!r.d.enabled) {
          // not in recovery mode -> only an admin can enable it
          R.hint.textContent = "Recovery isn't enabled for “" + name + "”. Ask an administrator to turn on recovery for your account, then try again.";
          R.nameRow.hidden = true; R.passRow.hidden = true;
          R.go.textContent = "Close"; recStage = "done";
          return;
        }
        recStage = "setpw";
        R.hint.textContent = "Recovery is enabled for “" + name + "”. Choose a new password.";
        R.nameRow.hidden = true; R.passRow.hidden = false;
        R.go.textContent = "Set new password";
        setTimeout(function () { R.passI.focus(); }, 20);
      }).catch(function () { R.go.disabled = false; R.err.textContent = "Connection error."; });
      return;
    }
    // recStage === "setpw"
    var password = R.passI.value || "";
    if (password.length < 6) { R.err.textContent = "New password must be at least 6 characters."; return; }
    R.go.disabled = true;
    api("/api/auth/reset", { name: name, password: password }).then(function (r) {
      R.go.disabled = false;
      if (!r.ok) { R.err.textContent = r.d.error || "Could not reset."; return; }
      account = r.d.account; renderAccount();
      toast("Password reset. Welcome back, " + account.name + "!");
      closeRecovery();
    }).catch(function () { R.go.disabled = false; R.err.textContent = "Connection error."; });
  }

  // ==================== wiring ====================
  authBtn.addEventListener("click", function () {
    if (account) {
      api("/api/auth/logout", {}).catch(function () {});
      account = null; renderAccount(); toast("Signed out");
    } else {
      openLogin();
    }
  });

  loginOverlay.addEventListener("click", function (e) {
    if (e.target === loginOverlay || e.target.hasAttribute("data-close")) closeLogin();
  });
  L.tabs.forEach(function (t) {
    t.addEventListener("click", function () { setLoginMode(t.getAttribute("data-mode")); });
  });
  L.go.addEventListener("click", submitLogin);
  L.forgot.addEventListener("click", function () {
    var prefill = (L.nameI.value || "").trim();
    closeLogin(); openRecovery(prefill);
  });
  loginOverlay.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitLogin(); }
    if (e.key === "Escape") closeLogin();
  });

  recOverlay.addEventListener("click", function (e) {
    if (e.target === recOverlay || e.target.hasAttribute("data-close")) closeRecovery();
  });
  R.go.addEventListener("click", submitRecovery);
  recOverlay.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitRecovery(); }
    if (e.key === "Escape") closeRecovery();
  });

  // ---------- boot: who am I? ----------
  fetch("/api/auth/me", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) { account = d.account || null; renderAccount(); })
    .catch(function () { renderAccount(); });
})();
