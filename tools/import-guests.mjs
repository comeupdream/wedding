#!/usr/bin/env node
// Rebuild the guest list from a spreadsheet export.
//
// The workbook stays the planning source of truth. Export its Guest List tab as
// CSV over guests.csv, then run this — it merges into guest-codes.json, keeping
// the password of anyone already on the list so links you've already sent keep
// working, and minting one for everybody new.
//
//   node tools/import-guests.mjs                 # show what would change
//   node tools/import-guests.mjs --write         # apply it
//   node tools/import-guests.mjs --file other.csv
//
// Columns: name, party, invite, contact. Only `name` is required — party
// defaults to 1, invite to "both" (see gen-codes.mjs --scope to make someone
// ceremony-only), contact is free text carried through to the links export.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPES = ["both", "ceremony", "reception"];

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const die = (m) => { console.error("error: " + m); process.exit(1); };

const CSV = path.resolve(opt("file", path.join(ROOT, "guests.csv")));
const GUESTS = path.resolve(opt("out", path.join(ROOT, "guest-codes.json")));

// Minimal RFC-4180 reader: quoted fields, doubled quotes, embedded commas.
const parseCsv = (text) => {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
};

if (!fs.existsSync(CSV)) die(`no spreadsheet export at ${path.relative(ROOT, CSV)}`);
const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
const header = rows.shift().map((h) => h.trim().toLowerCase());
const col = (name) => header.indexOf(name);
if (col("name") < 0) die("the CSV needs a `name` column");

const incoming = rows.map((r) => {
  const get = (n) => (col(n) >= 0 ? String(r[col(n)] ?? "").trim() : "");
  const invite = get("invite").toLowerCase();
  const party = Math.max(1, parseInt(get("party"), 10) || 1);
  // Named members let the RSVP form greet a household by name and take an
  // answer per person. Unknown members stay blank — guests fill them in.
  const members = get("members").split(";").map((s) => s.trim()).filter(Boolean).slice(0, party);
  return {
    name: get("name"),
    party,
    invite: SCOPES.includes(invite) ? invite : "both",
    contact: get("contact"),
    members,
  };
}).filter((g) => g.name);

const dupes = incoming.map((g) => g.name).filter((n, i, a) => a.indexOf(n) !== i);
if (dupes.length) die(`duplicate name(s) in the CSV: ${[...new Set(dupes)].join(", ")}`);

// --- merge against whatever is already on the list ---
const existing = fs.existsSync(GUESTS) ? JSON.parse(fs.readFileSync(GUESTS, "utf8")) : [];
const byName = new Map(existing.map((g) => [g.name, g]));
const taken = new Set(existing.map((g) => String(g.code)).filter((c) => /^\d{4}$/.test(c)));

const randomInt = (lo, hi) => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return lo + (buf[0] % (hi - lo + 1));
};
const weak = (s) => new Set(s).size === 1 ||
  s.split("").every((d, i, a) => i === 0 || +d === +a[i - 1] + 1) ||
  s.split("").every((d, i, a) => i === 0 || +d === +a[i - 1] - 1);
const makeCode = () => {
  for (let i = 0; i < 10_000; i++) {
    const n = String(randomInt(1000, 9999));
    if (!weak(n) && !taken.has(n)) { taken.add(n); return n; }
  }
  die("ran out of unique 4-digit passwords");
};

const added = [], changed = [], kept = [];
const merged = incoming.map((g) => {
  const prev = byName.get(g.name);
  if (!prev) { added.push(g.name); return { code: makeCode(), ...g }; }
  const diffs = [];
  if (prev.party !== g.party) diffs.push(`seats ${prev.party} -> ${g.party}`);
  if ((prev.contact || "") !== g.contact) diffs.push("contact");
  if ((prev.members || []).join("; ") !== g.members.join("; ")) diffs.push("members");
  if (diffs.length) changed.push(`${g.name}: ${diffs.join(", ")}`); else kept.push(g.name);
  // Keep the password and the invite scope already set — those are decisions
  // made outside the spreadsheet, and regenerating them would break sent links.
  return {
    code: prev.code, name: g.name, party: g.party,
    invite: prev.invite || g.invite, contact: g.contact, members: g.members,
  };
});

const removed = existing.filter((g) => !incoming.some((i) => i.name === g.name)).map((g) => g.name);

console.log(`${merged.length} invitations, ${merged.reduce((n, g) => n + g.party, 0)} seats`);
if (added.length) console.log(`\nnew (${added.length}):\n  ` + added.join("\n  "));
if (changed.length) console.log(`\nchanged (${changed.length}):\n  ` + changed.join("\n  "));
if (removed.length) console.log(`\nno longer on the list (${removed.length}):\n  ` + removed.join("\n  "));
if (kept.length) console.log(`\nunchanged: ${kept.length}`);

if (!flag("write")) {
  console.log(`\nDry run — nothing written. Re-run with --write to apply.`);
  process.exit(0);
}
fs.writeFileSync(GUESTS, JSON.stringify(merged, null, 1) + "\n");
console.log(`\nWritten to ${path.relative(ROOT, GUESTS)}. Deploy for the server to pick it up.`);
