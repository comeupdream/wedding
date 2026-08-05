// Wedding invite portal — static site + RSVP API.
// Zero dependencies: guest passwords are validated here, never shipped to the page.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { readUpload, merge } from "./guest-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const GUESTS_FILE = process.env.GUESTS_FILE || path.join(__dirname, "guest-codes.json");

// ---------- guests ----------
// Each guest: { code, name, party, invite }. `invite` decides which events the
// guest may answer for — a ceremony-only invite can never RSVP to the reception.
export const SCOPES = {
  both: { events: ["both", "ceremony", "reception", "none"], label: "Ceremony & reception" },
  ceremony: { events: ["ceremony", "none"], label: "Ceremony only" },
  reception: { events: ["reception", "none"], label: "Reception only" },
};
export const MEALS = ["standard", "vegetarian"];

export const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// A household with no surname on it — "Pinki & Sudhir", "Mia". Judged by the
// last person named: if that segment is a single word, no surname was given.
// It's a nudge for the guest list, never anything a guest sees.
export const needsSurname = (name) => {
  const last = String(name).split(/\s*(?:&|,| and )\s*/i).filter(Boolean).pop() || "";
  const words = last.trim().split(/\s+/).filter(Boolean);
  if (/^(family|daughter|friends?)$/i.test(words[words.length - 1] || "")) return true;
  return words.length < 2;
};

const indexGuests = (raw) => {
  const map = new Map();
  for (const g of raw) {
    const invite = SCOPES[g.invite] ? g.invite : "both";
    map.set(norm(g.code), {
      code: String(g.code),
      name: String(g.name),
      party: Math.max(1, parseInt(g.party, 10) || 1),
      invite,
      // How to reach them — email, phone, "via the WhatsApp group". Carried from
      // the spreadsheet so the admin export is a ready-to-send list.
      contact: String(g.contact || ""),
      // Named people on the invitation, where we know them. A household answers
      // per person, so these prefill the form; blanks are typed in by the guest.
      members: Array.isArray(g.members) ? g.members.map(String).slice(0, 20) : [],
      // A standing at the wedding, if any. Only "best-man" is special so far.
      role: String(g.role || ""),
      // Words written for this invitation alone, if any.
      ask: String(g.ask || "").slice(0, 400),
      // A rehearsal invitation — answers are kept and shown, but never counted.
      test: g.test === true,
    });
  }
  return map;
};

// The live list, and the seed it starts from. The store is the source of truth
// once anything has been uploaded; guest-codes.json only fills an empty store,
// so a fresh database comes up with the list that's in the repo.
const seedGuests = () => JSON.parse(fs.readFileSync(GUESTS_FILE, "utf8"));
let guestList = [];
let byCode = new Map();
export const setGuests = (list) => {
  guestList = list;
  byCode = indexGuests(list);
  return byCode.size;
};
export const loadGuests = async (store) => {
  let list = await store.guests();
  if (!list.length) {
    list = seedGuests();
    await store.putGuests(list);
    console.log(`seeded ${list.length} guests from ${path.basename(GUESTS_FILE)}`);
  }
  return setGuests(list);
};
setGuests(seedGuests());   // so the module is usable before the store is ready

// ---------- brute-force guard ----------
// Passwords are four digits, so the throttle is the security boundary: a client
// gets 8 wrong guesses per 15 minutes, then has to wait the window out. State is
// per-app rather than per-module so two servers in one process don't share it.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 8;
const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.socket.remoteAddress || "unknown";
const makeGuard = () => {
  const fails = new Map();
  const recent = (ip) => {
    const now = Date.now();
    const times = (fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (times.length) fails.set(ip, times); else fails.delete(ip);
    return times;
  };
  setInterval(() => { for (const ip of fails.keys()) recent(ip); }, WINDOW_MS).unref();
  return {
    lockedOut(ip) {
      const times = recent(ip);
      if (times.length < MAX_FAILS) return 0;
      return Math.ceil((WINDOW_MS - (Date.now() - times[0])) / 1000);
    },
    fail(ip) { fails.set(ip, [...recent(ip), Date.now()]); },
    clear(ip) { fails.delete(ip); },
  };
};

const authorized = (req) => {
  if (!ADMIN_PASSWORD) return false;
  const given = Buffer.from((req.headers.authorization || "").replace(/^Bearer /, ""));
  const want = Buffer.from(ADMIN_PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

// ---------- static files ----------
const MIME = {
  ".mp4": "video/mp4", ".png": "image/png", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".css": "text/css; charset=utf-8",
};
const ASSETS_DIR = path.join(__dirname, "site", "assets");
const serveStatic = (req, res, filePath) => {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ASSETS_DIR) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end('{"error":"not found"}');
  }
  const size = fs.statSync(resolved).size;
  const type = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
  const common = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400" };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    let end = range[2] ? parseInt(range[2], 10) : size - 1;
    if (start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...common, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(resolved, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...common, "Content-Length": size });
  fs.createReadStream(resolved).pipe(res);
};

const SMALL_BODY = 10_000;          // an unlock or an RSVP
const UPLOAD_BODY = 12_000_000;     // a spreadsheet, base64-encoded
const readBody = (req, max = SMALL_BODY) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > max) { reject(new Error("body too large")); req.destroy(); }
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});

// ---------- RSVP shaping ----------
// A household answers per person: each named guest says whether they're coming
// to the ceremony, the reception, both, or neither. A single guest is just the
// same thing with one row, so one shape covers both.
export const buildRsvp = (guest, b, now = new Date()) => {
  const scope = SCOPES[guest.invite].events;
  const mayCeremony = scope.includes("ceremony") || scope.includes("both");
  const mayReception = scope.includes("reception") || scope.includes("both");

  const given = Array.isArray(b.attendees) ? b.attendees.slice(0, guest.party) : null;
  const attendees = (given || []).map((a, i) => ({
    name: String((a && a.name) || guest.members[i] || `Guest ${i + 1}`).trim().slice(0, 80),
    ceremony: mayCeremony && Boolean(a && a.ceremony),
    reception: mayReception && Boolean(a && a.reception),
    vegetarian: Boolean(a && a.vegetarian),
  }));

  const coming = attendees.filter((a) => a.ceremony || a.reception);
  const ceremony = attendees.filter((a) => a.ceremony).length;
  const reception = attendees.filter((a) => a.reception).length;
  // A one-word summary of the household's answer, for the dashboard and CSV.
  const events = !coming.length ? "none"
    : ceremony && reception ? "both"
    : ceremony ? "ceremony" : "reception";

  return {
    code: guest.code,
    name: guest.name,
    invite: guest.invite,
    events,
    attendees,
    party: coming.length,
    seats: guest.party,
    ceremony,
    reception,
    // Meals are a reception count — nobody eats dinner at a ceremony-only RSVP.
    vegetarian: attendees.filter((a) => a.reception && a.vegetarian).length,
    standard: attendees.filter((a) => a.reception && !a.vegetarian).length,
    email: String(b.email || "").trim().slice(0, 200),
    note: String(b.note || "").trim().slice(0, 2000),
    at: now.toISOString(),
  };
};

// Everything here is a headcount of people, never of invitations. A family of
// four where two can come is two coming and two not — not "one RSVP".
export const totals = (rows, awaiting = []) => {
  const t = {
    responses: rows.length,          // invitations answered
    invitations: rows.length + awaiting.length,
    seats: 0,                        // people invited, across every invitation
    coming: 0,                       // people coming to at least one event
    ceremony: 0, reception: 0,
    notComing: 0,                    // people who answered no, inside or outside a family
    vegetarian: 0, standard: 0,
    awaiting: 0,                     // people on invitations with no reply yet
    awaitingInvitations: awaiting.length,
    partial: 0,                      // households where some are coming and some aren't
  };
  for (const r of rows) {
    t.seats += r.seats;
    t.coming += r.party;
    t.ceremony += r.ceremony;
    t.reception += r.reception;
    t.notComing += r.seats - r.party;
    t.vegetarian += r.vegetarian;
    t.standard += r.standard;
    if (r.party > 0 && r.party < r.seats) t.partial += 1;
  }
  for (const g of awaiting) { t.seats += g.party; t.awaiting += g.party; }
  return t;
};

const CSV_COLS = ["code", "name", "invite", "events", "party", "seats", "ceremony", "reception",
  "vegetarian", "standard", "who", "email", "note", "at"];
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// "Amy (ceremony + reception, vegetarian); Chris (reception)" — the household's
// answer in one readable cell, so the caterer doesn't need a second file.
const describe = (a) => {
  const at = [a.ceremony && "ceremony", a.reception && "reception"].filter(Boolean).join(" + ");
  const veg = a.reception && a.vegetarian ? ", vegetarian" : "";
  return `${a.name} (${at || "not coming"}${veg})`;
};
const toCsv = (rows) => [
  CSV_COLS.join(","),
  ...rows.map((r) => {
    const who = (r.attendees || []).map(describe).join("; ");
    return CSV_COLS.map((c) => csvCell(c === "who" ? who : r[c])).join(",");
  }),
].join("\n") + "\n";

// ---------- admin dashboard ----------
// ---------- admin dashboard ----------
// Two panels: the answers as they come in, and every invitation with its own
// personal link. Links are built from the page's own origin, so whatever
// hostname you opened /admin on is the hostname your guests get.
const ADMIN_HTML = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Admin — Sharon &amp; Zachary</title>
<link rel="stylesheet" href="/assets/fonts.css">
<style>
  /* Same world as the invitation: plum ground, vellum type, gold and wax.
     Every colour below is measured against its own background and clears 7:1,
     so the dashboard is WCAG AAA like the rest of the site. */
  :root {
    --ground: #2A1726;   --panel: #372036;   --line: rgba(251,243,228,.18);
    --cream: #FBF3E4;    /* 15.3:1 on ground */
    --muted: #D9C9B4;    /* 10.4:1 */
    --gold:  #FDCB6A;    /* 11.2:1 */
    --warn:  #FFB09B;    /*  9.6:1 */
    --ok:    #A6E3B4;    /* 11.4:1 */
    --wax:   #8A2A1B;    /* 8.1:1 against its own cream label */
    --script: "Parisienne", "Snell Roundhand", cursive;
    --body: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--cream); font-family:var(--body);
         font-size:15px; line-height:1.5; }
  .shell { max-width:84rem; margin:0 auto; padding:2rem 1.2rem 5rem; }
  h1 { margin:0; font-family:var(--script); font-weight:400; font-size:clamp(2rem,5vw,2.8rem); }
  .kicker { margin:0 0 .3rem; font-size:.68rem; letter-spacing:.32em; text-transform:uppercase; color:var(--gold); }
  h2 { font-size:1rem; margin:0 0 .6rem; font-weight:400; letter-spacing:.02em; }
  .muted { color:var(--muted); }
  .ok { color:var(--ok); font-style:italic; }
  a { color:var(--gold); }

  input, button, select { font:inherit; }
  input[type=password], input[type=text] {
    background:rgba(251,243,228,.06); color:var(--cream);
    border:1px solid var(--line); padding:.6rem .8rem; min-height:2.75rem; }
  input[type=file] { color:var(--muted); }
  button {
    background:var(--wax); color:#FFF6E8; cursor:pointer;
    border:1px solid var(--gold); padding:.6rem 1rem; min-height:2.75rem;
    letter-spacing:.06em; }
  button:hover { background:#6E2115; }
  button.ghost { background:transparent; color:var(--gold); border-color:var(--line); }
  button.ghost:hover { background:rgba(253,203,106,.12); }
  button.ghost.on { background:var(--wax); color:#FFF6E8; border-color:var(--gold); }
  button.mini { padding:.3rem .6rem; min-height:2.25rem; font-size:.8rem; }
  :focus-visible { outline:3px solid var(--gold); outline-offset:2px; }

  .bar { display:flex; gap:.6rem; flex-wrap:wrap; align-items:center; margin:1.1rem 0; }
  .tabs { display:flex; gap:.5rem; flex-wrap:wrap; margin:1.6rem 0 .2rem; }
  .hide { display:none; }

  /* headline numbers */
  .figures { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:1px;
             background:var(--line); border:1px solid var(--line); margin-top:1.2rem; }
  .fig { background:var(--panel); padding:.9rem 1rem; }
  .fig b { display:block; font-size:1.7rem; line-height:1.1; font-variant-numeric:tabular-nums; }
  .fig span { font-size:.72rem; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }
  .fig.flag b { color:var(--warn); }

  table { border-collapse:collapse; width:100%; margin-top:1rem; font-size:.92rem; }
  th, td { border-bottom:1px solid var(--line); padding:.6rem .7rem; text-align:left; vertical-align:top; }
  th { font-weight:400; font-size:.68rem; letter-spacing:.18em; text-transform:uppercase;
       color:var(--gold); border-bottom-color:var(--gold); }
  tbody tr:hover td { background:rgba(251,243,228,.04); }
  td.num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .code { font-family:ui-monospace,Menlo,monospace; font-size:1.05rem; letter-spacing:.1em; color:var(--gold); }
  .link { font-family:ui-monospace,Menlo,monospace; font-size:.76rem; word-break:break-all; color:var(--muted); }
  .names { margin-top:.2rem; font-size:.8rem; color:var(--muted); }
  .names.unset { font-style:italic; color:#C6B39A; }   /* 8.3:1, no opacity */
  .nosurname { color:var(--gold); text-decoration:none; margin-left:.25rem; cursor:help; }
  .chip { display:inline-block; margin-left:.4rem; padding:.05rem .4rem; font-size:.66rem;
          letter-spacing:.16em; border:1px solid var(--gold); color:var(--gold); vertical-align:middle; }
  tr.testrow td { background:rgba(253,203,106,.07); }
  tr.orphanrow td { background:rgba(255,176,155,.1); }
  .chip.warnchip { border-color:var(--warn); color:var(--warn); }
  tr.partial td { background:rgba(255,176,155,.09); }
  .part { color:var(--warn); font-size:.8rem; font-style:italic; white-space:nowrap; }
  tr.no td { color:var(--muted); }
  .warn { margin-top:1.2rem; padding:.8rem 1rem; border:1px solid var(--warn); color:var(--warn); }
  .lede { max-width:46rem; color:var(--muted); }
  .scroller { max-height:34rem; overflow:auto; border:1px solid var(--line); }

  /* preview tab */
  .preview-cols { display:grid; grid-template-columns:20rem 1fr; gap:1.6rem; align-items:start; margin-top:1rem; }
  @media (max-width:62rem) { .preview-cols { grid-template-columns:1fr; } }
  .rail { list-style:none; margin:0; padding:0; }
  .rail li + li { border-top:1px solid var(--line); }
  .rail button { display:block; width:100%; text-align:left; background:none; border:0;
                 color:var(--cream); padding:.6rem .75rem; }
  .rail button:hover { background:rgba(251,243,228,.06); }
  .rail button[aria-current=true] { background:var(--wax); }
  .rail .who { font-size:.95rem; }
  .rail .meta { font-size:.74rem; color:var(--muted); }
  .rail button[aria-current=true] .meta { color:#FFF6E8; }   /* 8.1:1 on the wax fill */
  .card-frame { border:1px solid var(--line); background:#241522; }
  .card-frame iframe { display:block; width:100%; height:min(78vh,46rem); border:0; }

  .diff { margin-top:1rem; display:grid; gap:.9rem; }
  .diff section { border:1px solid var(--line); background:var(--panel); padding:.8rem 1rem; }
  .diff h3 { margin:0 0 .4rem; font-size:.92rem; font-weight:400; color:var(--gold); }
  .diff ul { margin:0; padding-left:1.1rem; } .diff li { margin:.15rem 0; }
  dialog { border:1px solid var(--gold); background:var(--ground); color:var(--cream);
           padding:0; max-width:min(46rem,94vw); width:100%; }
  dialog::backdrop { background:rgba(20,10,18,.8); }
  .dlg-head { display:flex; gap:1rem; align-items:center; justify-content:space-between;
              padding:.7rem 1rem; border-bottom:1px solid var(--line); }
  .dlg-head h2 { margin:0; }
  .dlg-body { background:#241522; }
  .dlg-body iframe { display:block; width:100%; height:min(70vh,40rem); border:0; }
  .dlg-foot { display:flex; gap:.5rem; flex-wrap:wrap; padding:.7rem 1rem; border-top:1px solid var(--line); }
</style>
<main class="shell">
<p class="kicker">Sharon &amp; Zachary</p>
<h1>The wedding desk</h1>

<p class="bar"><label for="pw" class="muted">Admin password</label>
<input id="pw" type="password" autocomplete="current-password">
<button id="go">Open</button>
<span class="muted" id="msg" role="status"></span></p>

<div id="app" class="hide">
  <div class="tabs">
    <button class="ghost on" id="tab-rsvps">Replies</button>
    <button class="ghost" id="tab-links">Invitations &amp; links</button>
    <button class="ghost" id="tab-preview">Preview</button>
    <button class="ghost" id="tab-list">Guest list</button>
  </div>

  <div id="panel-rsvps">
    <div id="sum"></div>
    <div class="bar"><button id="csv">Download replies CSV</button></div>
    <div id="out"></div>
  </div>

  <div id="panel-links" class="hide">
    <div class="bar">
      <button class="ghost on" data-filter="all">Everyone</button>
      <button class="ghost" data-filter="family">Households (2+)</button>
      <button class="ghost" data-filter="ceremony">Ceremony only</button>
      <button class="ghost" data-filter="both">Full invite</button>
      <button class="ghost" data-filter="coming">Coming</button>
      <button class="ghost" data-filter="noreply">No reply yet</button>
      <button id="copy-all">Copy these links</button>
      <button id="links-csv">Download list &amp; links CSV</button>
      <span class="ok" id="link-msg"></span>
    </div>
    <div id="links"></div>
  </div>

  <div id="panel-preview" class="hide">
    <p class="lede">Exactly what each household receives. Pick a name; the card
      opens on click, seal and all.</p>
    <div class="preview-cols">
      <nav aria-label="Households"><div class="scroller"><ol class="rail" id="rail"></ol></div></nav>
      <div class="card-frame"><iframe id="card-frame" title="Invitation preview"></iframe></div>
    </div>
  </div>

  <div id="panel-list" class="hide">
    <p class="lede">Upload the planning workbook, or any sheet with a <b>name</b> column.
      You'll see exactly what changes before anything is saved. Passwords already
      handed out are kept, so links you've sent keep working.</p>
    <p class="lede">The live list is held in the database, so deploying new code
      does <b>not</b> change it. To pull in the list that came with this deploy —
      after merging families, say — use <b>Use the list from this deploy</b>.</p>
    <div class="bar">
      <label for="file" class="muted">Spreadsheet</label>
      <input type="file" id="file" accept=".xlsx,.csv,.txt">
      <button id="check">Check this file</button>
      <button id="use-seed" class="ghost">Use the list from this deploy</button>
      <button id="apply" class="hide">Apply these changes</button>
      <span class="ok" id="import-msg"></span>
    </div>
    <div id="import-out"></div>
  </div>
</div>

<dialog id="preview" aria-labelledby="preview-title">
  <div class="dlg-head">
    <h2 id="preview-title">Invitation preview</h2>
    <button class="mini" id="preview-close">Close</button>
  </div>
  <div class="dlg-body"><iframe id="preview-frame" title="Invitation preview"></iframe></div>
  <div class="dlg-foot">
    <button id="preview-open">Open in a new tab</button>
    <button id="preview-copy">Copy this link</button>
    <span class="ok" id="preview-msg"></span>
  </div>
</dialog>
</main>
<script>
var pw = document.getElementById("pw"), msg = document.getElementById("msg");
var out = document.getElementById("out"), sum = document.getElementById("sum");
var app = document.getElementById("app"), linkMsg = document.getElementById("link-msg");
var GUESTS = [], FILTER = "all";
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function auth() { return { Authorization: "Bearer " + pw.value }; }
var EVENTS = { both: "Ceremony &amp; reception", ceremony: "Ceremony only", reception: "Reception only", none: "Cannot attend" };
var SCOPE = { both: "Ceremony &amp; reception", ceremony: "Ceremony only", reception: "Reception only" };
function linkFor(code) { return location.origin + "/?c=" + encodeURIComponent(code) + "#rsvp"; }
function cardFor(code) { return location.origin + "/invite?c=" + encodeURIComponent(code); }
// Everyone on an invitation, printed under the household name for accounting.
function flag(g) { return g.needsSurname ? '<abbr class=nosurname title="No last name on file">**</abbr>' : ""; }
// A rehearsal invitation. Marked everywhere it appears, and in none of the sums.
function testChip(g) { return g.test ? ' <span class=chip>TEST</span>' : ""; }
// An answer whose invitation is gone. Kept visible, never counted.
function orphanChip(r) {
  return r.orphan ? ' <span class="chip warnchip">NO LONGER INVITED</span>' : "";
}
function namesOf(g) {
  return (g.members || []).length
    ? "<div class=names>" + g.members.map(esc).join(" &nbsp;·&nbsp; ") + "</div>"
    : "<div class='names unset'>names not set</div>";
}

function load() {
  msg.textContent = "Loading…";
  Promise.all([
    fetch("/api/rsvps", { headers: auth() }).then(function (r) {
      if (r.status === 401) throw new Error("Wrong password");
      if (!r.ok) throw new Error("Error " + r.status);
      return r.json();
    }),
    fetch("/api/guests", { headers: auth() }).then(function (r) { return r.json(); }),
  ]).then(function (both) {
    var data = both[0];
    GUESTS = both[1].guests || [];
    app.classList.remove("hide");
    var t = data.totals;
    msg.textContent = t.responses + " of " + t.invitations + " invitations answered";
    var warn = data.storage && !data.storage.durable
      ? "<div class=warn><b>These answers won't survive the next deploy.</b> " +
        "No database is configured, so they're being kept in " + esc(data.storage.detail) +
        " inside the running container. Set DATABASE_URL, or download the CSV first.</div>"
      : "";
    // Every figure is a headcount of people, never of invitations.
    function fig(n, label, flag) {
      return "<div class='fig" + (flag ? " flag" : "") + "'><b>" + n + "</b><span>" + label + "</span></div>";
    }
    sum.innerHTML = warn + "<div class=figures>" +
      fig(t.ceremony, "at the ceremony") +
      fig(t.reception, "at the reception") +
      fig(t.vegetarian + " / " + t.standard, "veg / standard") +
      fig(t.coming + " of " + t.seats, "people coming") +
      fig(t.notComing, "said no") +
      fig(t.awaiting, "not heard from", t.awaiting > 0) +
      (t.partial ? fig(t.partial, "families coming in part", true) : "") +
      "</div>" +
      (GUESTS.some(function (g) { return g.test; })
        ? "<p class=muted><span class=chip>TEST</span> rows are listed but left out of every " +
          "figure above, so trying the form can't move the catering numbers.</p>" : "") +
      (data.rsvps.some(function (r) { return r.orphan; })
        ? "<p class=muted><span class='chip warnchip'>NO LONGER INVITED</span> means this " +
          "household answered, then left the guest list. Their answer is kept here but not " +
          "counted. If that was a rename, re-upload with their password in a <b>password</b> " +
          "column and they'll be joined back up.</p>" : "");
    out.innerHTML = "<table><tr><th>Household</th><th>Code</th><th>Coming</th><th>Ceremony</th>" +
      "<th>Reception</th><th>Veg</th><th>Who's coming</th><th>Email</th><th>Note</th><th>When</th></tr>" +
      data.rsvps.map(function (r) {
        var who = (r.attendees || []).map(function (a) {
          var at = [a.ceremony ? "C" : "", a.reception ? "R" : ""].join("");
          return esc(a.name) + (at ? " <b>" + at + "</b>" : " <span class=muted>—</span>") +
            (a.reception && a.vegetarian ? " <i>veg</i>" : "");
        }).join(" &nbsp;·&nbsp; ") || "<span class=muted>nobody</span>";
        var partial = r.party > 0 && r.party < r.seats;
        return "<tr" + (r.test ? " class=testrow" : r.orphan ? " class=orphanrow" : partial ? " class=partial" : "") +
          "><td>" + esc(r.name) + testChip(r) + orphanChip(r) +
          "</td><td class=code>" + esc(r.code) +
          "</td><td class=num><b>" + esc(r.party) + "</b> of " + esc(r.seats) +
          (partial ? " <span class=part>" + (r.seats - r.party) + " not coming</span>" : "") +
          "</td><td class=num>" + esc(r.ceremony) + " of " + esc(r.seats) +
          "</td><td class=num>" + esc(r.reception) + " of " + esc(r.seats) +
          "</td><td class=num>" + esc(r.vegetarian) + "</td><td>" + who +
          "</td><td>" + esc(r.email) + "</td><td>" + esc(r.note) +
          "</td><td class=num>" + esc(String(r.at).slice(0, 16).replace("T", " ")) + "</td></tr>";
      }).join("") +
      data.awaiting.map(function (g) {
        return "<tr class=" + (g.test ? "testrow" : "no") + "><td>" + esc(g.name) + testChip(g) + flag(g) + namesOf(g) +
          "</td><td class=code>" + esc(g.code) +
          "</td><td class=num><b>?</b> of " + esc(g.party) +
          "</td><td colspan=7>no reply yet — " + esc(g.party) +
          (g.party > 1 ? " people" : " person") + " unaccounted for</td></tr>";
      }).join("") + "</table>";
    renderLinks();
    renderRail();
  }).catch(function (e) { msg.textContent = e.message; out.innerHTML = ""; sum.innerHTML = ""; });
}

// ---- invitations & links ----
function shown() {
  return GUESTS.filter(function (g) {
    if (FILTER === "family") return g.party > 1;
    if (FILTER === "ceremony") return g.invite === "ceremony";
    if (FILTER === "both") return g.invite === "both";
    if (FILTER === "coming") return g.replied && g.events !== "none";
    if (FILTER === "noreply") return !g.replied;
    return true;
  });
}
function renderLinks() {
  var rows = shown();
  document.getElementById("links").innerHTML =
    "<p class=muted>" + rows.length + " invitation(s) — one link per household. " +
    "<abbr class=nosurname title='No last name on file'>**</abbr> marks a household with no last name yet.</p>" +
    "<table><tr><th>Household</th><th>Seats</th><th>Invited to</th><th>Send to</th><th>Password</th>" +
    "<th>Invitation link</th><th>Actions</th><th>Status</th></tr>" +
    rows.map(function (g) {
      var status = !g.replied ? "<span class=muted>no reply</span>"
        : g.events === "none" ? "<span class=muted>cannot attend</span>"
        : "<b>" + (EVENTS[g.events] || esc(g.events)) + "</b>";
      return "<tr" + (g.test ? " class=testrow" : "") + "><td>" + esc(g.name) + testChip(g) + flag(g) + namesOf(g) +
        "</td><td class=num>" + esc(g.party) + "</td><td>" +
        (SCOPE[g.invite] || esc(g.invite)) + "</td>" +
        "<td class=muted>" + (g.contact ? esc(g.contact) : "—") + "</td>" +
        "<td class=code>" + esc(g.code) + "</td>" +
        "<td class=link>" + esc(cardFor(g.code)) + "</td>" +
        "<td><button class='mini' data-preview='" + esc(g.code) +
        "' aria-label='Preview the invitation for " + esc(g.name) + "'>preview</button> " +
        "<button class='mini ghost' data-copy='" + esc(g.code) +
        "' aria-label='Copy the invitation link for " + esc(g.name) + "'>copy</button></td>" +
        "<td>" + status + "</td></tr>";
    }).join("") + "</table>";
}
document.addEventListener("click", function (e) {
  var code = e.target.getAttribute && e.target.getAttribute("data-copy");
  if (!code) return;
  navigator.clipboard.writeText(cardFor(code)).then(function () {
    e.target.textContent = "copied";
    setTimeout(function () { e.target.textContent = "copy"; }, 1200);
  });
});
document.querySelectorAll("[data-filter]").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("[data-filter]").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    FILTER = b.dataset.filter;
    linkMsg.textContent = "";
    renderLinks();
  });
});
document.getElementById("copy-all").addEventListener("click", function () {
  var text = shown().map(function (g) { return g.name + "\\t" + g.code + "\\t" + cardFor(g.code); }).join("\\n");
  navigator.clipboard.writeText(text).then(function () {
    linkMsg.textContent = shown().length + " link(s) copied";
  });
});
function download(name, text, type) {
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
document.getElementById("links-csv").addEventListener("click", function () {
  var cell = function (v) {
    var s = String(v == null ? "" : v);
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // Column names the importer reads, so this file can be edited and uploaded
  // straight back — the password column is what keeps an invitation attached
  // through a rename. The two link columns are extra, and ignored on the way in.
  var rows = shown().map(function (g) {
    return [g.name, g.code, g.party, g.invite, g.contact || "", (g.members || []).join("; "),
            g.role || "", g.test ? "yes" : "", cardFor(g.code), linkFor(g.code)].map(cell).join(",");
  });
  download("invitation-links.csv",
    "name,password,party,invite,contact,members,role,test,invitation_link,rsvp_link\\n" +
    rows.join("\\n") + "\\n", "text/csv");
});

// ---- preview tab: the whole list, scrollable, card beside it ----
function renderRail() {
  var rail = document.getElementById("rail");
  rail.innerHTML = "";
  GUESTS.forEach(function (g, i) {
    var li = document.createElement("li");
    var b = document.createElement("button");
    b.type = "button";
    b.innerHTML = "<span class=who>" + esc(g.name) + testChip(g) + flag(g) + "</span><br><span class=meta>" +
      g.party + (g.party > 1 ? " people" : " person") + " · " +
      ((g.members || []).length ? g.members.map(esc).join(", ") : "names not set") + "</span>";
    b.addEventListener("click", function () { showCard(i); });
    li.appendChild(b); rail.appendChild(li);
  });
  if (GUESTS.length) showCard(0);
}
function showCard(i) {
  var rail = document.getElementById("rail");
  Array.prototype.forEach.call(rail.querySelectorAll("button"), function (b, n) {
    b.setAttribute("aria-current", n === i ? "true" : "false");
  });
  document.getElementById("card-frame").src = cardFor(GUESTS[i].code);
}

// ---- uploading a new guest list ----
var pending = null;
function send(body, apply) {
  var m = document.getElementById("import-msg");
  m.textContent = apply ? "Saving…" : "Reading…";
  fetch("/api/guests/import", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, auth()),
    body: JSON.stringify(Object.assign({}, body, { apply: !!apply }))
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) { m.textContent = res.j.error || "That didn't work."; return; }
      pending = body;
      showDiff(res.j);
      m.textContent = res.j.applied
        ? "Saved — " + res.j.invitations + " invitations are live."
        : "Nothing saved yet.";
      document.getElementById("apply").classList.toggle("hide", res.j.applied);
      if (res.j.applied) load();
    })
    .catch(function () { m.textContent = "Couldn't reach the server."; });
}
function importPost(apply) {
  if (apply) { if (pending) send(pending, true); return; }
  var f = document.getElementById("file").files[0];
  if (!f) { document.getElementById("import-msg").textContent = "Choose a file first."; return; }
  var reader = new FileReader();
  reader.onload = function () { send({ file: String(reader.result).split(",")[1], filename: f.name }, false); };
  reader.readAsDataURL(f);
}
document.getElementById("use-seed").addEventListener("click", function () { send({ seed: true }, false); });
function listBlock(title, items, note) {
  if (!items.length) return "";
  return "<section><h3>" + title + " (" + items.length + ")</h3>" +
    (note ? "<p class=muted>" + note + "</p>" : "") +
    "<ul>" + items.map(function (x) {
      return "<li>" + esc(Array.isArray(x) ? x[0] + " — " + x[1] : x) + "</li>";
    }).join("") + "</ul></section>";
}
function showDiff(d) {
  document.getElementById("import-out").innerHTML =
    "<div class=figures><div class=fig><b>" + d.invitations + "</b><span>invitations</span></div>" +
    "<div class=fig><b>" + d.seats + "</b><span>people</span></div>" +
    "<div class=fig><b>" + d.unchanged + "</b><span>unchanged</span></div></div>" +
    "<p class=muted>Read from the <b>" + esc(d.source) + "</b>.</p>" +
    "<div class=diff>" +
    listBlock("New invitations", d.added, "Each gets a fresh password.") +
    listBlock("Changed", d.changed) +
    listBlock("Already replied — would lose their invitation", d.removedAnswered,
      "These households have answered. Applying this would break the link you sent them " +
      "and leave their reply uncounted. If you renamed them, add a password column to the " +
      "sheet (the links CSV has one) and they will be kept.") +
    listBlock("Renamed", d.renamed, "Matched by password, so their invitation is unchanged.") +
    listBlock("No longer on the list", d.removed,
      "These lose their invitation. Check for renames before applying.") +
    listBlock("On the sheet but not invited", d.skipped) +
    listBlock("No headcount on the sheet", d.noCount, "Treated as one seat.") +
    "</div>";
}
document.getElementById("check").addEventListener("click", function () { importPost(false); });
document.getElementById("apply").addEventListener("click", function () { importPost(true); });
document.getElementById("file").addEventListener("change", function () {
  document.getElementById("apply").classList.add("hide");
  document.getElementById("import-msg").textContent = "";
  document.getElementById("import-out").innerHTML = "";
});

// ---- the preview dialog, from the links tab ----
var dlg = document.getElementById("preview");
var frame = document.getElementById("preview-frame");
var previewCode = null;
document.addEventListener("click", function (e) {
  var code = e.target.getAttribute && e.target.getAttribute("data-preview");
  if (!code) return;
  var g = GUESTS.filter(function (x) { return x.code === code; })[0];
  previewCode = code;
  document.getElementById("preview-title").textContent = "Invitation — " + (g ? g.name : code);
  document.getElementById("preview-msg").textContent = "";
  frame.src = cardFor(code);
  if (dlg.showModal) dlg.showModal(); else window.open(cardFor(code), "_blank");
});
document.getElementById("preview-close").addEventListener("click", function () { dlg.close(); });
dlg.addEventListener("close", function () { frame.src = "about:blank"; });
document.getElementById("preview-open").addEventListener("click", function () {
  if (previewCode) window.open(cardFor(previewCode), "_blank", "noopener");
});
document.getElementById("preview-copy").addEventListener("click", function () {
  if (!previewCode) return;
  navigator.clipboard.writeText(cardFor(previewCode)).then(function () {
    document.getElementById("preview-msg").textContent = "copied";
  });
});

// ---- tabs ----
var TABS = ["rsvps", "links", "preview", "list"];
function tab(which) {
  TABS.forEach(function (k) {
    document.getElementById("panel-" + k).classList.toggle("hide", which !== k);
    document.getElementById("tab-" + k).classList.toggle("on", which === k);
  });
}
TABS.forEach(function (k) {
  document.getElementById("tab-" + k).addEventListener("click", function () { tab(k); });
});

document.getElementById("go").addEventListener("click", load);
pw.addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
document.getElementById("csv").addEventListener("click", function () {
  fetch("/api/rsvps.csv", { headers: auth() })
    .then(function (r) { return r.text(); })
    .then(function (t) { download("rsvps.csv", t, "text/csv"); });
});
</script></html>`;

// ---------- routes ----------
export const createApp = (store) => {
const guard = makeGuard();
return http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body, type = "application/json", extra = {}) => {
    res.writeHead(status, { "Content-Type": type, ...extra });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(200, fs.readFileSync(path.join(__dirname, "site", "index.html")),
        "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
    }
    // The invitation card — an envelope with the household's name on it that
    // opens onto their own card. The page reads ?c= and unlocks like any guest.
    if (req.method === "GET" && (url.pathname === "/invite" || url.pathname === "/invite.html")) {
      return send(200, fs.readFileSync(path.join(__dirname, "site", "invite.html")),
        "text/html; charset=utf-8", { "X-Robots-Tag": "noindex", "Cache-Control": "no-cache" });
    }

    if (url.pathname === "/healthz") {
      return send(200, { ok: true, guests: byCode.size, storage: store.kind, durable: store.durable });
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      return serveStatic(req, res, path.join(__dirname, "site", url.pathname));
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      return serveStatic(req, res, path.join(ASSETS_DIR, "favicon-32.png"));
    }

    // Unlock: exchange an invitation password for the guest's name, seat count,
    // the events they may answer for, and any RSVP they already sent.
    if (req.method === "POST" && url.pathname === "/api/unlock") {
      const ip = clientIp(req);
      const wait = guard.lockedOut(ip);
      if (wait) {
        return send(429, { error: "Too many tries — please wait a few minutes." }, "application/json",
          { "Retry-After": String(wait) });
      }
      const { code } = JSON.parse((await readBody(req)) || "{}");
      const guest = byCode.get(norm(code));
      if (!guest) {
        guard.fail(ip);
        return send(404, { error: "unknown code" });
      }
      guard.clear(ip);
      const existing = (await store.all())[guest.code] || null;
      return send(200, {
        name: guest.name,
        party: guest.party,
        invite: guest.invite,
        events: SCOPES[guest.invite].events,
        members: guest.members,
        role: guest.role,
        ask: guest.ask,
        meals: MEALS,
        rsvp: existing,
      }, "application/json", { "Cache-Control": "no-store" });
    }

    if (req.method === "POST" && url.pathname === "/api/rsvp") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const guest = byCode.get(norm(b.code));
      if (!guest) return send(404, { error: "unknown code" });
      // Refuse a body with no attendees rather than reading it as "nobody is
      // coming". A guest on a cached copy of the old form would otherwise be
      // recorded as declining without ever being told.
      if (!Array.isArray(b.attendees)) return send(400, { error: "expected an attendees list" });
      const entry = await store.save(buildRsvp(guest, b));
      // Mirrored to stdout so the service logs keep a copy either way.
      console.log("RSVP " + JSON.stringify(entry));
      return send(200, { ok: true, rsvp: entry }, "application/json", { "Cache-Control": "no-store" });
    }

    if (req.method === "GET" && (url.pathname === "/api/rsvps" || url.pathname === "/api/rsvps.csv")) {
      if (!authorized(req)) return send(401, { error: "unauthorized" });
      const all = await store.all();
      // Test invitations are listed but never counted, so trying the form out
      // can't move the catering numbers.
      const isTest = (code) => (byCode.get(norm(code)) || {}).test === true;
      const known = (code) => byCode.has(norm(code));
      const rsvps = Object.values(all)
        .map((r) => ({ ...r, test: isTest(r.code), orphan: !known(r.code) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (url.pathname.endsWith(".csv")) {
        return send(200, toCsv(rsvps), "text/csv; charset=utf-8",
          { "Content-Disposition": 'attachment; filename="rsvps.csv"' });
      }
      const awaiting = [...byCode.values()]
        .filter((g) => !all[g.code])
        .map(({ code, name, invite, party, members, test }) =>
          ({ code, name, invite, party, members, test, needsSurname: needsSurname(name) }));
      return send(200, {
        invited: [...byCode.values()].filter((g) => !g.test).length,
        // Orphans — answers whose invitation was removed or renamed away — are
        // shown but not counted, so nobody is counted twice.
        totals: totals(rsvps.filter((r) => !r.test && !r.orphan), awaiting.filter((g) => !g.test)),
        rsvps, awaiting,
        storage: { kind: store.kind, detail: store.detail, durable: store.durable },
      }, "application/json", { "Cache-Control": "no-store" });
    }

    // Every invitation, with whether it has been answered — the admin page turns
    // these into personal links using its own origin, so they're always right.
    if (req.method === "GET" && url.pathname === "/api/guests") {
      if (!authorized(req)) return send(401, { error: "unauthorized" });
      const all = await store.all();
      const guests = [...byCode.values()]
        .map((g) => ({
          code: g.code, name: g.name, party: g.party, invite: g.invite,
          contact: g.contact, members: g.members, role: g.role, test: g.test,
          needsSurname: needsSurname(g.name),
          replied: Boolean(all[g.code]),
          events: all[g.code] ? all[g.code].events : null,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return send(200, { guests }, "application/json", { "Cache-Control": "no-store" });
    }

    // Upload a spreadsheet. Two steps on purpose: the first call reports what
    // would change, the second applies it. Nothing is written without the
    // second call, so a wrong file can't quietly rewrite the guest list.
    if (req.method === "POST" && url.pathname === "/api/guests/import") {
      if (!authorized(req)) return send(401, { error: "unauthorized" });
      const b = JSON.parse((await readBody(req, UPLOAD_BODY)) || "{}");
      let parsed;
      if (b.seed) {
        // The list that shipped with this deploy. The database is the source of
        // truth once anything is uploaded, so a redeploy can't change it on its
        // own — this is how you pull the repo's version in deliberately.
        parsed = { guests: seedGuests(), skipped: [], source: "list shipped with this deploy" };
      } else if (typeof b.file === "string" && b.file) {
        try {
          parsed = readUpload(Buffer.from(b.file, "base64"), String(b.filename || ""));
        } catch (err) {
          return send(400, { error: "Couldn't read that file — " + err.message });
        }
      } else {
        return send(400, { error: "no file" });
      }
      const dupes = parsed.guests.map((g) => g.name)
        .filter((n, i, a) => a.indexOf(n) !== i);
      if (dupes.length) {
        return send(400, { error: `The same name appears twice: ${[...new Set(dupes)].join(", ")}` });
      }
      const answered = new Set(Object.keys(await store.all()));
      const plan = merge(guestList, parsed.guests, (lo, hi) => crypto.randomInt(lo, hi), answered);
      const preview = {
        source: parsed.source,
        invitations: plan.list.length,
        seats: plan.list.reduce((n, g) => n + g.party, 0),
        added: plan.added, changed: plan.changed, removed: plan.removed,
        removedAnswered: plan.removedAnswered, renamed: plan.renamed,
        unchanged: plan.unchanged.length,
        skipped: parsed.skipped,
        noCount: parsed.guests.filter((g) => g.noCount).map((g) => g.name),
      };
      if (!b.apply) return send(200, { ...preview, applied: false });
      await store.putGuests(plan.list);
      setGuests(plan.list);
      console.log(`guest list replaced: ${plan.list.length} invitations ` +
        `(+${plan.added.length} ~${plan.changed.length} -${plan.removed.length})`);
      return send(200, { ...preview, applied: true });
    }

    if (req.method === "GET" && url.pathname === "/admin") {
      return send(200, ADMIN_HTML, "text/html; charset=utf-8", { "X-Robots-Tag": "noindex" });
    }

    send(404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(500, { error: "server error" });
  }
});
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is unset — /admin and the RSVP export are disabled.");
  const store = await createStore();
  console.log(`RSVPs stored in ${store.kind}: ${store.detail}`);
  await loadGuests(store);
  if (!store.durable) {
    console.warn("Nothing durable is configured — RSVPs are wiped by the next deploy or restart. " +
      "Set DATABASE_URL to a Postgres instance and they'll persist.");
  }
  createApp(store).listen(PORT, () => console.log(`wedding site listening on :${PORT} — ${byCode.size} guests loaded`));
}
