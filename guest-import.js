// Turning a spreadsheet into a guest list.
//
// Two shapes are accepted, and the right one is picked automatically:
//
//   * the planning workbook's Guest List tab — a name, a contact, and one
//     headcount column per group, with ALL-CAPS section banners between;
//   * a simple export with a `name` header row, plus any of party / invite /
//     contact / members.
//
// Shared by the CLI and by the upload button in /admin, so both agree.
import { readSheet } from "./xlsx.js";

export const SCOPES = ["both", "ceremony", "reception"];

// Rows on the planning sheet that are counted but never invited.
const NOT_INVITED = [
  /^zachary\b.*\(groom\)/i,
  /^sharon\b.*\(bride\)/i,
  /\(estimate, up to \d+\)$/i,
];

// --- CSV --------------------------------------------------------------------
export const parseCsv = (text) => {
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
  return rows;
};

const clean = (v) => String(v ?? "").trim();
const asInt = (v) => {
  const n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};

// --- the two shapes ---------------------------------------------------------
const fromExport = (rows) => {
  const header = rows[0].map((h) => clean(h).toLowerCase());
  const col = (name) => header.indexOf(name);
  const out = [];
  for (const r of rows.slice(1)) {
    const get = (n) => (col(n) >= 0 ? clean(r[col(n)]) : "");
    const name = get("name");
    if (!name) continue;
    // A password column lets a sheet round-trip: the household keeps its
    // invitation even if you rename it, so links already sent still work.
    const code = get("password") || get("code");
    const party = Math.max(1, asInt(get("party")) || 1);
    const invite = get("invite").toLowerCase();
    out.push({
      name,
      code: /^\d{3,8}$/.test(code) ? code : "",
      party,
      invite: SCOPES.includes(invite) ? invite : "both",
      contact: get("contact"),
      members: get("members").split(";").map(clean).filter(Boolean).slice(0, party),
      // How the household is written out inside the card, when that differs
      // from the name on the envelope.
      formal: get("formal"),
      // An optional standing at the wedding — "best-man" gets its own card.
      role: get("role"),
      // Optional words for this invitation, overriding the role's default.
      ask: get("ask"),
      // A rehearsal invitation: real in every way except that it is left out
      // of the headcounts, so trying the form can't skew the catering.
      test: /^(y|yes|true|1|test)$/i.test(get("test")),
    });
  }
  return out;
};

const fromWorkbook = (rows) => {
  const out = [];
  const skipped = [];
  let notComing = false;
  for (const r of rows.slice(1)) {
    const name = clean(r[0]);
    if (!name) continue;
    const upper = name === name.toUpperCase();
    if (/^total$/i.test(name) || /^names with no city/i.test(name)) continue;
    if (/^not coming/i.test(name)) { notComing = true; continue; }
    if (notComing) { skipped.push([name, "listed under NOT COMING"]); continue; }
    const party = r.slice(2, 6).reduce((n, c) => n + asInt(c), 0);
    if (party === 0 && upper && name.length > 8) continue;          // section banner
    if (NOT_INVITED.some((re) => re.test(name))) {
      skipped.push([name, "counted, but not an invitation"]);
      continue;
    }
    out.push({
      name,
      party: Math.max(1, party),
      invite: "both",
      contact: clean(r[1]),
      // Names spelled out in the parentheses, but only when the count matches
      // exactly — never invent a family's shape.
      members: (() => {
        const m = /\(([^)]*)\)?$/.exec(name);
        if (!m || /plus/i.test(m[1])) return [];
        const parts = m[1].split(/,|&| and /).map(clean).filter(Boolean);
        return parts.length === Math.max(1, party) && parts.length > 1 ? parts : [];
      })(),
      noCount: party === 0,
    });
  }
  return { guests: out, skipped };
};

/** Read an uploaded file into guest records. `buf` is a Buffer. */
export const readUpload = (buf, filename = "") => {
  const isXlsx = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;   // "PK"
  let rows;
  let source;
  if (isXlsx) {
    // The planning workbook keeps the list on a tab called Guest List; a
    // one-sheet export won't have it, so fall back to the first sheet.
    try { rows = readSheet(buf, "Guest List"); source = "Guest List sheet"; }
    catch { rows = readSheet(buf); source = "first sheet"; }
  } else {
    rows = parseCsv(buf.toString("utf8"));
    source = "CSV";
  }
  rows = rows.filter((r) => r.some((c) => clean(c) !== ""));
  if (!rows.length) throw new Error("that file has no rows in it");

  const header = rows[0].map((h) => clean(h).toLowerCase());
  if (header.includes("name") && !header.includes("guest list")) {
    return { guests: fromExport(rows), skipped: [], source: source + " (name column)" };
  }
  const { guests, skipped } = fromWorkbook(rows);
  if (!guests.length) throw new Error("no guests found — expected a name column, or the planning sheet's layout");
  return { guests, skipped, source: source + " (planning layout)" };
};

// --- passwords --------------------------------------------------------------
const weak = (s) => new Set(s).size === 1 ||
  s.split("").every((d, i, a) => i === 0 || +d === +a[i - 1] + 1) ||
  s.split("").every((d, i, a) => i === 0 || +d === +a[i - 1] - 1);

export const makeCode = (taken, randomInt) => {
  for (let i = 0; i < 10_000; i++) {
    const n = String(randomInt(1000, 10_000));
    if (!weak(n) && !taken.has(n)) { taken.add(n); return n; }
  }
  throw new Error("ran out of unique four-digit passwords");
};

/**
 * Fold an uploaded list into the one already in use.
 * Passwords and invite scopes already set are kept, so links stay valid.
 */
export const merge = (existing, incoming, randomInt, answered = new Set()) => {
  const byName = new Map(existing.map((g) => [g.name, g]));
  const byCode = new Map(existing.map((g) => [String(g.code), g]));
  const taken = new Set(existing.map((g) => String(g.code)).filter((c) => /^\d{4}$/.test(c)));
  const added = [], changed = [], unchanged = [], renamed = [];

  const list = incoming.map((g) => {
    // The password wins over the name, so a household can be renamed without
    // losing the invitation that was already sent to it.
    const prev = (g.code && byCode.get(String(g.code))) || byName.get(g.name);
    if (prev && prev.name !== g.name) renamed.push(`${prev.name} → ${g.name}`);
    if (!prev) {
      added.push(g.name);
      return { code: makeCode(taken, randomInt), name: g.name, party: g.party,
               invite: g.invite, contact: g.contact, members: g.members,
               role: g.role || "", ask: g.ask || "", formal: g.formal || "",
               test: !!g.test };
    }
    const diffs = [];
    if (prev.party !== g.party) diffs.push(`seats ${prev.party} → ${g.party}`);
    if ((prev.contact || "") !== g.contact) diffs.push("contact");
    if ((prev.members || []).join("; ") !== g.members.join("; ")) diffs.push("names");
    if ((prev.role || "") !== (g.role || "")) diffs.push("role");
    if ((prev.ask || "") !== (g.ask || "")) diffs.push("wording");
    if ((prev.formal || "") !== (g.formal || "")) diffs.push("card name");
    if (diffs.length) changed.push(`${g.name}: ${diffs.join(", ")}`);
    else unchanged.push(g.name);
    return { code: prev.code, name: g.name, party: g.party,
             invite: prev.invite || g.invite, contact: g.contact, members: g.members,
             role: g.role || prev.role || "", ask: g.ask || prev.ask || "",
             formal: g.formal || prev.formal || "",
             test: g.test === undefined ? !!prev.test : !!g.test };
  });

  const kept = new Set(list.map((g) => String(g.code)));
  const gone = existing.filter((g) => !kept.has(String(g.code)));
  const removed = gone.map((g) => g.name);
  // Losing a household that has already replied is the one destructive case:
  // their answer is orphaned and the link they were sent stops working.
  const removedAnswered = gone.filter((g) => answered.has(String(g.code))).map((g) => g.name);
  return { list, added, changed, removed, removedAnswered, renamed, unchanged };
};
