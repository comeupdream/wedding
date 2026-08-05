#!/usr/bin/env node
// Invitation link generator.
//
// Builds one personal link per guest with the password already in it, so nobody
// has to type anything: https://site.example/?c=4821#rsvp . The site unlocks the
// RSVP form on load and scrubs the password out of the address bar.
//
//   node tools/gen-links.mjs --base https://sharon-zachary.onrender.com
//   node tools/gen-links.mjs --scope ceremony            # ceremony-only invites
//   node tools/gen-links.mjs --who "Herpal,Durga"        # a few guests
//   node tools/gen-links.mjs --format csv --out links.csv
//
// Scope filters on how each guest is invited. To *change* who is ceremony-only:
//   node tools/gen-codes.mjs --scope ceremony --who "Gita,Loey"
//
// Flags: --format table|csv|md|txt (default table) · --out <file> · --file <path>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPES = ["both", "ceremony", "reception"];
const SCOPE_LABEL = {
  both: "Ceremony & reception",
  ceremony: "Ceremony only",
  reception: "Reception only",
};

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const die = (msg) => { console.error("error: " + msg); process.exit(1); };

const FILE = path.resolve(opt("file", path.join(ROOT, "guest-codes.json")));
const FORMAT = opt("format", "table");
const OUT = opt("out", null);
const scope = opt("scope", null);
const who = opt("who", null);

let base = opt("base", process.env.SITE_URL || "");
if (!base) die("pass --base https://your-site.example (or set SITE_URL)");
if (!/^https?:\/\//.test(base)) base = "https://" + base;
base = base.replace(/\/+$/, "");
if (scope && !SCOPES.includes(scope)) die(`--scope must be one of ${SCOPES.join(", ")}`);

if (!fs.existsSync(FILE)) die(`no guest list at ${FILE}`);
let guests = JSON.parse(fs.readFileSync(FILE, "utf8"))
  .map((g) => ({ ...g, invite: SCOPES.includes(g.invite) ? g.invite : "both" }));

const missing = guests.filter((g) => !/^\d{3,8}$/.test(String(g.code ?? "")));
if (missing.length) {
  die(`${missing.length} guest(s) have no password yet — run: node tools/gen-codes.mjs`);
}

if (scope) guests = guests.filter((g) => g.invite === scope);
if (who) {
  const needles = who.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  guests = guests.filter((g) => needles.some((n) => g.name.toLowerCase().includes(n)));
}
if (!guests.length) die("no guests matched that filter");

const rows = guests.map((g) => ({
  name: g.name,
  code: String(g.code),
  seats: g.party,
  invited: SCOPE_LABEL[g.invite],
  send_to: g.contact || "",
  link: `${base}/?c=${encodeURIComponent(g.code)}#rsvp`,
}));

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const COLS = ["name", "code", "seats", "invited", "send_to", "link"];

const render = () => {
  if (FORMAT === "csv") {
    return [COLS.join(","), ...rows.map((r) => COLS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
  }
  if (FORMAT === "txt") {
    return rows.map((r) => `${r.name} (${r.invited}, ${r.seats} seat(s))\n  password ${r.code}\n  ${r.link}`).join("\n\n") + "\n";
  }
  if (FORMAT === "md") {
    return ["| Guest | Password | Seats | Invited to | Link |", "| --- | --- | --- | --- | --- |",
      ...rows.map((r) => `| ${r.name} | ${r.code} | ${r.seats} | ${r.invited} | ${r.link} |`)].join("\n") + "\n";
  }
  if (FORMAT !== "table") die("--format must be table, csv, md or txt");
  const w = COLS.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd();
  return [line(COLS.map((c) => c.toUpperCase())), line(w.map((n) => "-".repeat(n))),
    ...rows.map((r) => line(COLS.map((c) => r[c])))].join("\n") + "\n";
};

const output = render();
if (OUT) {
  fs.writeFileSync(path.resolve(OUT), output);
  console.log(`${rows.length} link(s) written to ${OUT}`);
} else {
  process.stdout.write(output);
  if (FORMAT === "table") {
    console.log(`\n${rows.length} link(s)${scope ? ` — ${SCOPE_LABEL[scope].toLowerCase()} invites` : ""}`);
  }
}
