#!/usr/bin/env node
// Invitation password generator.
//
// Every invitation gets its own 4-digit numeric password. Codes are drawn from
// 1000-9999 (no leading zeros to lose in transcription) and obvious guesses —
// 1111, 1234, 9876 — are skipped. Uniqueness is enforced against the whole list.
//
//   node tools/gen-codes.mjs                       # fill in any missing passwords
//   node tools/gen-codes.mjs --all                 # regenerate every password
//   node tools/gen-codes.mjs --scope ceremony --who "Gita,Loey"
//   node tools/gen-codes.mjs --add "Cousin Ravi" --party 2 --scope ceremony
//   node tools/gen-codes.mjs --list                # show the list, change nothing
//
// Flags: --length N (default 4) · --file <path> · --dry-run
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPES = ["both", "ceremony", "reception"];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const FILE = path.resolve(opt("file", path.join(ROOT, "guest-codes.json")));
const LENGTH = Math.max(3, Math.min(8, parseInt(opt("length", "4"), 10) || 4));
const DRY = flag("dry-run");

const die = (msg) => { console.error("error: " + msg); process.exit(1); };

// --- password generation ---------------------------------------------------
const LOW = 10 ** (LENGTH - 1);          // 1000 for length 4
const HIGH = 10 ** LENGTH - 1;           // 9999
const weak = (n) => {
  const s = String(n);
  if (new Set(s).size === 1) return true;                       // 1111
  const asc = s.split("").every((d, i, a) => i === 0 || +d === +a[i - 1] + 1);
  const desc = s.split("").every((d, i, a) => i === 0 || +d === +a[i - 1] - 1);
  return asc || desc;                                            // 1234 / 9876
};
const makeCode = (taken) => {
  for (let i = 0; i < 10_000; i++) {
    const n = String(randomInt(LOW, HIGH + 1));
    if (!weak(n) && !taken.has(n)) { taken.add(n); return n; }
  }
  die(`ran out of unique ${LENGTH}-digit passwords — raise --length`);
};
const isCode = (c) => new RegExp(`^\\d{${LENGTH}}$`).test(String(c ?? ""));

// --- load ------------------------------------------------------------------
if (!fs.existsSync(FILE)) die(`no guest list at ${FILE}`);
const guests = JSON.parse(fs.readFileSync(FILE, "utf8"));
if (!Array.isArray(guests)) die("guest list must be a JSON array");
for (const g of guests) if (!SCOPES.includes(g.invite)) g.invite = "both";

const changes = [];

// --- --add -----------------------------------------------------------------
const addName = opt("add", null);
if (addName) {
  const scope = opt("scope", "both");
  if (!SCOPES.includes(scope)) die(`--scope must be one of ${SCOPES.join(", ")}`);
  if (guests.some((g) => g.name.toLowerCase() === addName.toLowerCase())) {
    die(`"${addName}" is already on the list`);
  }
  guests.push({
    code: "",
    name: addName,
    party: Math.max(1, parseInt(opt("party", "1"), 10) || 1),
    invite: scope,
  });
  changes.push(`added ${addName}`);
}

// --- --scope / --who -------------------------------------------------------
const who = opt("who", null);
if (who && !addName) {
  const scope = opt("scope", null);
  if (!SCOPES.includes(scope)) die(`--scope must be one of ${SCOPES.join(", ")}`);
  const needles = who.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const needle of needles) {
    const matches = guests.filter((g) => g.name.toLowerCase().includes(needle));
    if (!matches.length) die(`no guest matches "${needle}"`);
    for (const g of matches) {
      if (g.invite !== scope) changes.push(`${g.name}: invite ${g.invite} -> ${scope}`);
      g.invite = scope;
    }
  }
}

// --- passwords -------------------------------------------------------------
// --list is a pure read: never mint a password the file won't keep.
const regenerate = flag("all");
if (!flag("list")) {
  const taken = new Set(guests.filter((g) => isCode(g.code) && !regenerate).map((g) => String(g.code)));
  for (const g of guests) {
    if (!regenerate && isCode(g.code)) continue;
    const before = g.code;
    g.code = makeCode(taken);
    changes.push(`${g.name}: ${before || "(none)"} -> ${g.code}`);
  }
}

// --- report ----------------------------------------------------------------
if (flag("list") || !changes.length) {
  const pad = Math.max(...guests.map((g) => g.name.length));
  for (const g of guests) {
    console.log(`${String(g.code).padEnd(LENGTH + 2)}${g.name.padEnd(pad + 2)}${g.party} seat(s)  ${g.invite}`);
  }
  console.log(`\n${guests.length} invitations` + (changes.length ? "" : " — nothing to change"));
  if (!changes.length || flag("list")) process.exit(0);
}

for (const c of changes) console.log(c);
if (DRY) {
  console.log(`\n${changes.length} change(s) — dry run, ${path.relative(ROOT, FILE)} untouched`);
  process.exit(0);
}
fs.writeFileSync(FILE, JSON.stringify(guests, null, 1) + "\n");
console.log(`\n${changes.length} change(s) written to ${path.relative(ROOT, FILE)}`);
console.log("Next: node tools/gen-links.mjs --base https://your-site.example");
