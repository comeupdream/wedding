#!/usr/bin/env node
// Rebuild the guest list from a spreadsheet, from a terminal.
//
// The same thing the Guest list tab in /admin does — this writes
// guest-codes.json, which is the seed a fresh database starts from.
//
//   node tools/import-guests.mjs WEDDING_GUEST_LIST.xlsx      # show what changes
//   node tools/import-guests.mjs guests.csv --write           # apply it
//
// Accepts the planning workbook (.xlsx) or any sheet with a `name` column.
// Passwords already handed out are kept, so links you've sent keep working.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readUpload, merge } from "../guest-import.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const die = (m) => { console.error("error: " + m); process.exit(1); };

const input = path.resolve(argv.find((a) => !a.startsWith("--")) || path.join(ROOT, "guests.csv"));
const OUT = path.resolve(opt("out", path.join(ROOT, "guest-codes.json")));
if (!fs.existsSync(input)) die(`no such file: ${path.relative(ROOT, input)}`);

let parsed;
try { parsed = readUpload(fs.readFileSync(input), path.basename(input)); }
catch (err) { die(err.message); }

const dupes = parsed.guests.map((g) => g.name).filter((n, i, a) => a.indexOf(n) !== i);
if (dupes.length) die(`the same name appears twice: ${[...new Set(dupes)].join(", ")}`);

const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
const plan = merge(existing, parsed.guests, (lo, hi) => crypto.randomInt(lo, hi));

const show = (title, items, note) => {
  if (!items.length) return;
  console.log(`\n${title} (${items.length}):${note ? "  " + note : ""}`);
  for (const i of items) console.log("  " + (Array.isArray(i) ? `${i[0]} — ${i[1]}` : i));
};

console.log(`Read from the ${parsed.source}: ` +
  `${plan.list.length} invitations, ${plan.list.reduce((n, g) => n + g.party, 0)} seats`);
show("New", plan.added, "each gets a fresh password");
show("Changed", plan.changed);
show("No longer on the list", plan.removed, "check for renames first");
show("On the sheet but not invited", parsed.skipped);
show("No headcount on the sheet", parsed.guests.filter((g) => g.noCount).map((g) => g.name), "treated as one seat");
console.log(`\nUnchanged: ${plan.unchanged.length}`);

if (!flag("write")) {
  console.log("\nNothing written. Re-run with --write to apply.");
  process.exit(0);
}
fs.writeFileSync(OUT, JSON.stringify(plan.list, null, 1) + "\n");
console.log(`\nWritten to ${path.relative(ROOT, OUT)}.`);
console.log("This is the seed for a new database. To change a list that's already " +
  "live, upload the sheet in /admin instead.");
