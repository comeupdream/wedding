// Wedding invite portal — static site + RSVP API.
// Zero dependencies: guest passwords are validated here, never shipped to the page.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";

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
      // How to reach them — email, phone, "via the WhatsApp group". Carried from
      // the spreadsheet so the admin export is a ready-to-send list.
      contact: String(g.contact || ""),
      // Named people on the invitation, where we know them. A household answers
      // per person, so these prefill the form; blanks are typed in by the guest.
      members: Array.isArray(g.members) ? g.members.map(String).slice(0, 20) : [],
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

export const totals = (rows) => {
  const t = { responses: rows.length, guests: 0, ceremony: 0, reception: 0, declined: 0, vegetarian: 0, standard: 0 };
  for (const r of rows) {
    if (r.events === "none") { t.declined += 1; continue; }
    t.guests += r.party;
    t.ceremony += r.ceremony;
    t.reception += r.reception;
    t.vegetarian += r.vegetarian;
    t.standard += r.standard;
  }
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
<title>RSVPs — Sharon &amp; Zachary</title>
<style>
  /* Colours measured against #FBF3E4: every one clears 7:1, WCAG AAA. */
  body{font-family:Georgia,serif;background:#FBF3E4;color:#3A2420;max-width:78rem;margin:2rem auto;padding:0 1rem}
  h1{font-size:1.4rem;margin-bottom:.8rem}
  input,button,select{font:inherit;padding:.5rem .8rem;border:1px solid #8A2A1B;min-height:2.75rem}
  button{background:#8A2A1B;color:#FFF6E8;cursor:pointer}
  button.ghost{background:transparent;color:#8A2A1B}
  button.ghost.on{background:#8A2A1B;color:#FFF6E8}
  button.mini{padding:.35rem .6rem;font-size:.78rem;min-height:2.25rem}
  table{border-collapse:collapse;width:100%;margin-top:1rem;font-size:.92rem}
  th,td{border:1px solid #d8c4a5;padding:.45rem .6rem;text-align:left;vertical-align:top}
  th{background:#F3E6CE} .muted{color:#57403A;font-style:italic}
  .totals{margin-top:1.2rem;padding:.8rem 1rem;background:#F3E6CE;border:1px solid #d8c4a5}
  .totals b{font-size:1.1rem} .no{color:#6B4F47}
  .warn{margin-top:1.2rem;padding:.8rem 1rem;background:#F7DFD6;border:1px solid #8A2A1B;font-size:.9rem;color:#2B1A17}
  .tabs{margin:1.4rem 0 .4rem;display:flex;gap:.5rem}
  .bar{margin:1rem 0;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  .link{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;word-break:break-all;color:#57403A}
  .code{font-family:ui-monospace,Menlo,monospace;font-size:1rem;letter-spacing:.08em}
  .hide{display:none}
  .ok{color:#1F5129;font-style:italic}
  dialog{border:1px solid #8A2A1B;background:#FBF3E4;color:#3A2420;padding:0;max-width:min(46rem,94vw);width:100%}
  dialog::backdrop{background:rgba(46,26,46,.72)}
  :focus-visible{outline:3px solid #8A2A1B;outline-offset:2px}
  .dlg-head{display:flex;gap:1rem;align-items:center;justify-content:space-between;padding:.7rem 1rem;border-bottom:1px solid #d8c4a5}
  .dlg-head h2{font-size:1rem;margin:0}
  .dlg-body{padding:0;background:#2E1A2E}
  .dlg-body iframe{display:block;width:100%;height:min(70vh,40rem);border:0}
  .dlg-foot{display:flex;gap:.5rem;flex-wrap:wrap;padding:.7rem 1rem;border-top:1px solid #d8c4a5}
</style>
<main>
<h1>Sharon &amp; Zachary — admin</h1>
<p><label for="pw">Admin password</label>
<input id="pw" type="password" autocomplete="current-password"> <button id="go">Open</button>
<span class="muted" id="msg" role="status"></span></p>

<div id="app" class="hide">
  <div class="tabs">
    <button class="ghost on" id="tab-rsvps">RSVPs</button>
    <button class="ghost" id="tab-links">Invitations &amp; links</button>
  </div>

  <div id="panel-rsvps">
    <div class="bar"><button id="csv">Download RSVP CSV</button><span class="muted" id="rsvp-msg"></span></div>
    <div id="sum"></div>
    <div id="out"></div>
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

  <div id="panel-links" class="hide">
    <div class="bar">
      <button class="ghost on" data-filter="all">Everyone</button>
      <button class="ghost" data-filter="family">Households (2+)</button>
      <button class="ghost" data-filter="ceremony">Ceremony only</button>
      <button class="ghost" data-filter="both">Full invite</button>
      <button class="ghost" data-filter="coming">Coming</button>
      <button class="ghost" data-filter="noreply">No reply yet</button>
      <button id="copy-all">Copy these links</button>
      <button id="links-csv">Download links CSV</button>
      <span class="ok" id="link-msg"></span>
    </div>
    <div id="links"></div>
  </div>
</div>
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

// ---- the personal link, exactly as a guest receives it ----
function linkFor(code) { return location.origin + "/?c=" + encodeURIComponent(code) + "#rsvp"; }
// The card is what you actually send: an envelope with their name on it, which
// opens onto their invitation and leads through to the RSVP form.
function cardFor(code) { return location.origin + "/invite?c=" + encodeURIComponent(code); }

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
    msg.textContent = t.responses + " of " + data.invited + " invitations answered";
    var warn = data.storage && !data.storage.durable
      ? "<div class=warn><b>These answers won't survive the next deploy.</b> " +
        "No database is configured, so they're being kept in " + esc(data.storage.detail) +
        " inside the running container. Set DATABASE_URL, or download the CSV " +
        "before you deploy again.</div>"
      : "";
    sum.innerHTML = warn + "<div class=totals><b>" + t.ceremony + "</b> at the ceremony &nbsp;·&nbsp; <b>" +
      t.reception + "</b> at the reception &nbsp;·&nbsp; <b>" + t.vegetarian +
      "</b> vegetarian / <b>" + t.standard + "</b> standard meals &nbsp;·&nbsp; <b>" +
      t.declined + "</b> cannot attend &nbsp;·&nbsp; <b>" + data.awaiting.length + "</b> awaiting reply</div>";
    out.innerHTML = "<table><tr><th>Guest</th><th>Code</th><th>Cer.</th><th>Rec.</th>" +
      "<th>Veg</th><th>Who's coming</th><th>Email</th><th>Note</th><th>When</th></tr>" +
      data.rsvps.map(function (r) {
        // Each person, with what they said yes to.
        var who = (r.attendees || []).map(function (a) {
          var at = [a.ceremony ? "C" : "", a.reception ? "R" : ""].join("");
          var tag = at ? " <b>" + at + "</b>" : " <span class=muted>—</span>";
          return esc(a.name) + tag + (a.reception && a.vegetarian ? " <i>veg</i>" : "");
        }).join(" &nbsp;·&nbsp; ") || "<span class=muted>nobody</span>";
        return "<tr><td>" + esc(r.name) + "</td><td>" + esc(r.code) +
          "</td><td>" + esc(r.ceremony) + " of " + esc(r.seats) +
          "</td><td>" + esc(r.reception) + " of " + esc(r.seats) +
          "</td><td>" + esc(r.vegetarian) + "</td><td>" + who +
          "</td><td>" + esc(r.email) + "</td><td>" + esc(r.note) +
          "</td><td>" + esc(String(r.at).slice(0, 16).replace("T", " ")) + "</td></tr>";
      }).join("") +
      data.awaiting.map(function (g) {
        return "<tr class=no><td>" + esc(g.name) + "</td><td>" + esc(g.code) +
          "</td><td colspan=7 class=muted>no reply yet — " + esc(g.party) +
          (g.party > 1 ? " seats" : " seat") + " held</td></tr>";
      }).join("") + "</table>";
    renderLinks();
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
    "<p class=muted>" + rows.length + " invitation(s) — one link per household, seats included.</p>" +
    "<table><tr><th>Guest</th><th>Seats</th><th>Invited to</th><th>Send to</th><th>Password</th>" +
    "<th>Invitation link</th><th>Actions</th><th>Status</th></tr>" +
    rows.map(function (g) {
      var status = !g.replied ? "<span class=muted>no reply</span>"
        : g.events === "none" ? "<span class=muted>cannot attend</span>"
        : "<b>" + (EVENTS[g.events] || esc(g.events)) + "</b>";
      return "<tr><td>" + esc(g.name) + "</td><td>" + esc(g.party) + "</td><td>" +
        (SCOPE[g.invite] || esc(g.invite)) + "</td>" +
        "<td class=muted>" + (g.contact ? esc(g.contact) : "—") + "</td>" +
        "<td class=code>" + esc(g.code) + "</td>" +
        "<td class=link>" + esc(cardFor(g.code)) + "</td>" +
        "<td class=rowacts><button class='mini' data-preview='" + esc(g.code) +
        "' aria-label='Preview the invitation for " + esc(g.name) + "'>preview</button> " +
        "<button class='mini' data-copy='" + esc(g.code) +
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
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
document.getElementById("links-csv").addEventListener("click", function () {
  var cell = function (v) {
    var s = String(v == null ? "" : v);
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var rows = shown().map(function (g) {
    return [g.name, g.code, g.party, SCOPE[g.invite] || g.invite, g.contact || "",
            cardFor(g.code), linkFor(g.code)].map(cell).join(",");
  });
  download("invitation-links.csv",
    "name,password,seats,invited,send_to,invitation_link,rsvp_link\\n" + rows.join("\\n") + "\\n", "text/csv");
});

// ---- invitation preview ----
var dlg = document.getElementById("preview");
var frame = document.getElementById("preview-frame");
var previewCode = null;
function preview(code, name) {
  previewCode = code;
  document.getElementById("preview-title").textContent = "Invitation preview — " + name;
  document.getElementById("preview-msg").textContent = "";
  frame.src = cardFor(code);
  if (dlg.showModal) dlg.showModal(); else window.open(cardFor(code), "_blank");
}
document.addEventListener("click", function (e) {
  var code = e.target.getAttribute && e.target.getAttribute("data-preview");
  if (!code) return;
  var g = GUESTS.filter(function (x) { return x.code === code; })[0];
  preview(code, g ? g.name : code);
});
document.getElementById("preview-close").addEventListener("click", function () { dlg.close(); });
// Blank the iframe on close so the next preview always animates from sealed.
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
function tab(which) {
  document.getElementById("panel-rsvps").classList.toggle("hide", which !== "rsvps");
  document.getElementById("panel-links").classList.toggle("hide", which !== "links");
  document.getElementById("tab-rsvps").classList.toggle("on", which === "rsvps");
  document.getElementById("tab-links").classList.toggle("on", which === "links");
}
document.getElementById("tab-rsvps").addEventListener("click", function () { tab("rsvps"); });
document.getElementById("tab-links").addEventListener("click", function () { tab("links"); });

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
      const rsvps = Object.values(all).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (url.pathname.endsWith(".csv")) {
        return send(200, toCsv(rsvps), "text/csv; charset=utf-8",
          { "Content-Disposition": 'attachment; filename="rsvps.csv"' });
      }
      const awaiting = [...byCode.values()]
        .filter((g) => !all[g.code])
        .map(({ code, name, invite, party }) => ({ code, name, invite, party }));
      return send(200, {
        invited: byCode.size, totals: totals(rsvps), rsvps, awaiting,
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
          code: g.code, name: g.name, party: g.party, invite: g.invite, contact: g.contact,
          replied: Boolean(all[g.code]),
          events: all[g.code] ? all[g.code].events : null,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return send(200, { guests }, "application/json", { "Cache-Control": "no-store" });
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
  if (!store.durable) {
    console.warn("Nothing durable is configured — RSVPs are wiped by the next deploy or restart. " +
      "Set DATABASE_URL to a Postgres instance and they'll persist.");
  }
  createApp(store).listen(PORT, () => console.log(`wedding site listening on :${PORT} — ${byCode.size} guests loaded`));
}
