// Wedding invite portal — static site + RSVP API.
// Zero dependencies: guest passwords are validated here, never shipped to the page.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const GUESTS_FILE = process.env.GUESTS_FILE || path.join(__dirname, "guest-codes.json");
const RSVP_FILE = path.join(DATA_DIR, "rsvps.json");
const RSVP_LOG = path.join(DATA_DIR, "rsvps.log.jsonl");

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

const loadGuests = () => {
  const raw = JSON.parse(fs.readFileSync(GUESTS_FILE, "utf8"));
  const map = new Map();
  for (const g of raw) {
    const invite = SCOPES[g.invite] ? g.invite : "both";
    map.set(norm(g.code), {
      code: String(g.code),
      name: String(g.name),
      party: Math.max(1, parseInt(g.party, 10) || 1),
      invite,
    });
  }
  return map;
};
let byCode = loadGuests();
// `kill -HUP <pid>` picks up guest-list edits without dropping connections.
process.on("SIGHUP", () => {
  try {
    byCode = loadGuests();
    console.log(`reloaded ${byCode.size} guests`);
  } catch (err) {
    console.error("guest reload failed", err);
  }
});

// ---------- storage ----------
// rsvps.json holds the current answer per guest (re-submitting replaces it);
// rsvps.log.jsonl keeps every submission ever received, as an audit trail.
const readAll = () => {
  try { return JSON.parse(fs.readFileSync(RSVP_FILE, "utf8")); } catch { return {}; }
};
const saveRsvp = (entry) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const all = readAll();
  const prev = all[entry.code];
  all[entry.code] = prev ? { ...entry, firstAt: prev.firstAt || prev.at } : entry;
  const tmp = RSVP_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
  fs.renameSync(tmp, RSVP_FILE);
  fs.appendFileSync(RSVP_LOG, JSON.stringify(entry) + "\n");
  return all[entry.code];
};

// ---------- brute-force guard ----------
// Passwords are four digits, so the throttle is the security boundary: a client
// gets 8 wrong guesses per 15 minutes, then has to wait the window out.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 8;
const fails = new Map();
const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.socket.remoteAddress || "unknown";
const recentFails = (ip) => {
  const now = Date.now();
  const recent = (fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length) fails.set(ip, recent); else fails.delete(ip);
  return recent;
};
const lockedOut = (ip) => {
  const recent = recentFails(ip);
  if (recent.length < MAX_FAILS) return 0;
  return Math.ceil((WINDOW_MS - (Date.now() - recent[0])) / 1000);
};
const noteFail = (ip) => fails.set(ip, [...recentFails(ip), Date.now()]);
setInterval(() => { for (const ip of fails.keys()) recentFails(ip); }, WINDOW_MS).unref();

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
  ".ico": "image/x-icon",
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

const readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 10_000) { reject(new Error("body too large")); req.destroy(); }
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});

// ---------- RSVP shaping ----------
export const buildRsvp = (guest, b, now = new Date()) => {
  const allowed = SCOPES[guest.invite].events;
  const events = allowed.includes(b.events) ? b.events : allowed[0];
  const attending = events === "none"
    ? 0
    : Math.max(1, Math.min(guest.party, parseInt(b.party, 10) || guest.party));
  const vegetarian = Math.max(0, Math.min(attending, parseInt(b.vegetarian, 10) || 0));
  return {
    code: guest.code,
    name: guest.name,
    invite: guest.invite,
    events,
    party: attending,
    seats: guest.party,
    vegetarian,
    standard: attending - vegetarian,
    email: String(b.email || "").trim().slice(0, 200),
    note: String(b.note || "").trim().slice(0, 2000),
    at: now.toISOString(),
  };
};

export const totals = (rows) => {
  const t = { responses: rows.length, ceremony: 0, reception: 0, declined: 0, vegetarian: 0, standard: 0 };
  for (const r of rows) {
    if (r.events === "none") { t.declined += 1; continue; }
    if (r.events === "both" || r.events === "ceremony") t.ceremony += r.party;
    if (r.events === "both" || r.events === "reception") t.reception += r.party;
    t.vegetarian += r.vegetarian;
    t.standard += r.standard;
  }
  return t;
};

const CSV_COLS = ["code", "name", "invite", "events", "party", "seats", "vegetarian", "standard", "email", "note", "at"];
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (rows) =>
  [CSV_COLS.join(","), ...rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";

// ---------- admin dashboard ----------
const ADMIN_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>RSVPs — Sharon &amp; Zachary</title>
<style>
  body{font-family:Georgia,serif;background:#FBF3E4;color:#3A2420;max-width:72rem;margin:2rem auto;padding:0 1rem}
  h1{font-size:1.4rem} input,button{font:inherit;padding:.5rem .8rem;border:1px solid #B33F2E}
  button{background:#B33F2E;color:#FBF3E4;cursor:pointer}
  table{border-collapse:collapse;width:100%;margin-top:1.2rem;font-size:.92rem}
  th,td{border:1px solid #d8c4a5;padding:.45rem .6rem;text-align:left;vertical-align:top}
  th{background:#F3E6CE} .muted{color:#6E5247;font-style:italic}
  .totals{margin-top:1.2rem;padding:.8rem 1rem;background:#F3E6CE;border:1px solid #d8c4a5}
  .totals b{font-size:1.1rem} .no{color:#8a6a60}
</style>
<h1>RSVPs</h1>
<p><input id="pw" type="password" placeholder="Admin password"> <button id="go">View</button>
<button id="csv" hidden>Download CSV</button> <span class="muted" id="msg"></span></p>
<div id="sum"></div>
<div id="out"></div>
<script>
var pw = document.getElementById("pw"), msg = document.getElementById("msg");
var out = document.getElementById("out"), sum = document.getElementById("sum"), csv = document.getElementById("csv");
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
var EVENTS = { both: "Ceremony &amp; reception", ceremony: "Ceremony only", reception: "Reception only", none: "Cannot attend" };
function load() {
  msg.textContent = "Loading…";
  fetch("/api/rsvps", { headers: { Authorization: "Bearer " + pw.value } })
    .then(function (r) {
      if (r.status === 401) throw new Error("Wrong password");
      if (!r.ok) throw new Error("Error " + r.status);
      return r.json();
    })
    .then(function (data) {
      var t = data.totals;
      msg.textContent = t.responses + " of " + data.invited + " invitations answered";
      csv.hidden = false;
      sum.innerHTML = "<div class=totals><b>" + t.ceremony + "</b> at the ceremony &nbsp;·&nbsp; <b>" +
        t.reception + "</b> at the reception &nbsp;·&nbsp; <b>" + t.vegetarian +
        "</b> vegetarian / <b>" + t.standard + "</b> standard meals &nbsp;·&nbsp; <b>" +
        t.declined + "</b> cannot attend &nbsp;·&nbsp; <b>" + data.awaiting.length + "</b> awaiting reply</div>";
      out.innerHTML = "<table><tr><th>Guest</th><th>Code</th><th>Invited to</th><th>Joining for</th>" +
        "<th>Seats</th><th>Veg</th><th>Email</th><th>Note</th><th>When</th></tr>" +
        data.rsvps.map(function (r) {
          return "<tr><td>" + esc(r.name) + "</td><td>" + esc(r.code) + "</td><td>" + esc(r.invite) +
            "</td><td>" + (EVENTS[r.events] || esc(r.events)) + "</td><td>" + esc(r.party) + " of " + esc(r.seats) +
            "</td><td>" + esc(r.vegetarian) + "</td><td>" + esc(r.email) + "</td><td>" + esc(r.note) +
            "</td><td>" + esc(String(r.at).slice(0, 16).replace("T", " ")) + "</td></tr>";
        }).join("") +
        data.awaiting.map(function (g) {
          return "<tr class=no><td>" + esc(g.name) + "</td><td>" + esc(g.code) + "</td><td>" + esc(g.invite) +
            "</td><td colspan=6 class=muted>no reply yet</td></tr>";
        }).join("") + "</table>";
    })
    .catch(function (e) { msg.textContent = e.message; out.innerHTML = ""; sum.innerHTML = ""; });
}
document.getElementById("go").addEventListener("click", load);
pw.addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
csv.addEventListener("click", function () {
  fetch("/api/rsvps.csv", { headers: { Authorization: "Bearer " + pw.value } })
    .then(function (r) { return r.blob(); })
    .then(function (b) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = "rsvps.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
});
</script>`;

// ---------- routes ----------
export const createApp = () => http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body, type = "application/json", extra = {}) => {
    res.writeHead(status, { "Content-Type": type, ...extra });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(200, fs.readFileSync(path.join(__dirname, "site", "index.html")), "text/html; charset=utf-8");
    }
    if (url.pathname === "/healthz") return send(200, { ok: true, guests: byCode.size });

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
      const wait = lockedOut(ip);
      if (wait) {
        return send(429, { error: "Too many tries — please wait a few minutes." }, "application/json",
          { "Retry-After": String(wait) });
      }
      const { code } = JSON.parse((await readBody(req)) || "{}");
      const guest = byCode.get(norm(code));
      if (!guest) {
        noteFail(ip);
        return send(404, { error: "unknown code" });
      }
      fails.delete(ip);
      const existing = readAll()[guest.code] || null;
      return send(200, {
        name: guest.name,
        party: guest.party,
        invite: guest.invite,
        events: SCOPES[guest.invite].events,
        meals: MEALS,
        rsvp: existing,
      }, "application/json", { "Cache-Control": "no-store" });
    }

    if (req.method === "POST" && url.pathname === "/api/rsvp") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const guest = byCode.get(norm(b.code));
      if (!guest) return send(404, { error: "unknown code" });
      const entry = saveRsvp(buildRsvp(guest, b));
      // Mirrored to stdout so Render logs keep a copy even without a disk.
      console.log("RSVP " + JSON.stringify(entry));
      return send(200, { ok: true, rsvp: entry }, "application/json", { "Cache-Control": "no-store" });
    }

    if (req.method === "GET" && (url.pathname === "/api/rsvps" || url.pathname === "/api/rsvps.csv")) {
      if (!authorized(req)) return send(401, { error: "unauthorized" });
      const all = readAll();
      const rsvps = Object.values(all).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (url.pathname.endsWith(".csv")) {
        return send(200, toCsv(rsvps), "text/csv; charset=utf-8",
          { "Content-Disposition": 'attachment; filename="rsvps.csv"' });
      }
      const awaiting = [...byCode.values()]
        .filter((g) => !all[g.code])
        .map(({ code, name, invite, party }) => ({ code, name, invite, party }));
      return send(200, { invited: byCode.size, totals: totals(rsvps), rsvps, awaiting },
        "application/json", { "Cache-Control": "no-store" });
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is unset — /admin and the RSVP export are disabled.");
  createApp().listen(PORT, () => console.log(`wedding site listening on :${PORT} — ${byCode.size} guests loaded`));
}
