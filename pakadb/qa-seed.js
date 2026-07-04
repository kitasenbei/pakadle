#!/usr/bin/env node
// Temporary QA access seeder for PakaDB (standalone — NOT tied to Duel accounts).
// Generates N tester credentials (identifier + random password), writes salted
// scrypt hashes to pakadb/qa-access.json (safe to commit — no plaintext), and
// prints the plaintext handout table ONCE. Re-run to regenerate (overwrites the
// file and invalidates the previous passwords).
//
//   node pakadb/qa-seed.js [count]        (default 10)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const count = Math.max(1, Math.min(500, parseInt(process.argv[2], 10) || 10));
const OUT = path.join(__dirname, "qa-access.json");

// unambiguous alphabet (no 0/O/1/l/I) so passwords survive a copy out of a DM
const ALPH = "abcdefghijkmnpqrstuvwxyz23456789";
function password() {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPH[crypto.randomInt(ALPH.length)];
  return s.replace(/(.{4})(.{4})(.{2})/, "$1-$2-$3");   // xxxx-xxxx-xx, easier to read/type
}

const testers = [], handout = [];
for (let i = 1; i <= count; i++) {
  const id = "paka-tester-" + String(i).padStart(2, "0");
  const pw = password();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  testers.push({ id, salt, hash });
  handout.push({ id, pw });
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), testers }, null, 2) + "\n");

const w = Math.max.apply(null, handout.map((t) => t.id.length));
console.log("\nPakaDB QA access — hand these out privately (DM / email). Shown only now.\n");
console.log("  " + "IDENTIFIER".padEnd(w) + "   PASSWORD");
console.log("  " + "-".repeat(w) + "   " + "-".repeat(12));
for (const t of handout) console.log("  " + t.id.padEnd(w) + "   " + t.pw);
console.log("\nWrote " + testers.length + " salted hashes to " + path.relative(process.cwd(), OUT) +
  " (commit it; it holds no plaintext).\n");
