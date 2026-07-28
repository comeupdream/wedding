// Wedding invite portal — static site + RSVP API.
// Zero dependencies: guest codes are validated here, never shipped to the page.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const RSVP_FILE = path.join(DATA_DIR, "rsvps.json");

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const codes = JSON.parse(fs.readFileSync(path.join(__dirname, "guest-codes.json"), "utf8"));
const byCode = new Map(codes.map((g) => [norm(g.code), g]));

const readRsvps = () => {
  try { return JSON.parse(fs.readFileSync(RSVP_FILE, "utf8")); } catch { return []; }
};
const writeRsvp = (entry) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const all = readRsvps();
  all.push(entry);
  fs.writeFileSync(RSVP_FILE, JSON.stringify(all, null, 1));
};

// crude per-IP throttle so codes can't be brute-forced
const attempts = new Map();
const throttled = (ip) => {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  attempts.set(ip, recent);
  if (recent.length >= 20) return true;
  recent.push(now);
  return false;
};

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

const ADMIN_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RSVPs — Sharon &amp; Zachary</title>
<style>
  body{font-family:Georgia,serif;background:#FBF3E4;color:#3A2420;max-width:64rem;margin:2rem auto;padding:0 1rem}
  h1{font-size:1.4rem} input,button{font:inherit;padding:.5rem .8rem;border:1px solid #B33F2E}
  button{background:#B33F2E;color:#FBF3E4;cursor:pointer}
  table{border-collapse:collapse;width:100%;margin-top:1.2rem;font-size:.92rem}
  th,td{border:1px solid #d8c4a5;padding:.45rem .6rem;text-align:left;vertical-align:top}
  th{background:#F3E6CE} .muted{color:#6E5247;font-style:italic}
</style>
<h1>RSVPs</h1>
<p><input id="pw" type="password" placeholder="Admin password"> <button id="go">View</button>
<span class="muted" id="msg"></span></p>
<div id="out"></div>
<script>
document.getElementById("go").addEventListener("click", function () {
  var msg = document.getElementById("msg"), out = document.getElementById("out");
  msg.textContent = "Loading…";
  fetch("/api/rsvps", { headers: { Authorization: "Bearer " + document.getElementById("pw").value } })
    .then(function (r) { if (r.status === 401) throw new Error("Wrong password"); if (!r.ok) throw new Error("Error"); return r.json(); })
    .then(function (rows) {
      msg.textContent = rows.length + " response(s)";
      var esc = function (s) { return String(s || "").replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
      out.innerHTML = "<table><tr><th>Guest</th><th>Joining for</th><th>Seats</th><th>Dinner</th><th>Email</th><th>Note</th><th>When</th></tr>" +
        rows.map(function (r) {
          return "<tr><td>" + esc(r.name) + "</td><td>" + esc(r.events) + "</td><td>" + esc(r.party) +
            "</td><td>" + esc(r.dinner) + "</td><td>" + esc(r.email) + "</td><td>" + esc(r.note) +
            "</td><td>" + esc(r.at) + "</td></tr>";
        }).join("") + "</table>";
    })
    .catch(function (e) { msg.textContent = e.message; out.innerHTML = ""; });
});
</script>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "Content-Type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(200, fs.readFileSync(path.join(__dirname, "site", "index.html")), "text/html; charset=utf-8");
    }
    if (url.pathname === "/healthz") return send(200, { ok: true });

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      return serveStatic(req, res, path.join(__dirname, "site", url.pathname));
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      return serveStatic(req, res, path.join(ASSETS_DIR, "favicon-32.png"));
    }

    if (req.method === "POST" && url.pathname === "/api/unlock") {
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      if (throttled(ip)) return send(429, { error: "Too many attempts — wait a minute." });
      const { code } = JSON.parse((await readBody(req)) || "{}");
      const guest = byCode.get(norm(code));
      if (!guest) return send(404, { error: "unknown code" });
      return send(200, { name: guest.name, party: guest.party });
    }

    if (req.method === "POST" && url.pathname === "/api/rsvp") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const guest = byCode.get(norm(b.code));
      if (!guest) return send(404, { error: "unknown code" });
      const entry = {
        code: guest.code,
        name: guest.name,
        events: ["both", "ceremony", "reception", "none"].includes(b.events) ? b.events : "both",
        party: Math.max(1, Math.min(guest.party, parseInt(b.party, 10) || guest.party)),
        email: String(b.email || "").slice(0, 200),
        dinner: String(b.dinner || "").slice(0, 40),
        note: String(b.note || "").slice(0, 2000),
        at: new Date().toISOString(),
      };
      writeRsvp(entry);
      // Mirrored to stdout so Render logs keep a copy even without a disk.
      console.log("RSVP " + JSON.stringify(entry));
      return send(200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/rsvps") {
      const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (!ADMIN_PASSWORD || auth !== ADMIN_PASSWORD) return send(401, { error: "unauthorized" });
      return send(200, readRsvps());
    }

    if (req.method === "GET" && url.pathname === "/admin") {
      return send(200, ADMIN_HTML, "text/html; charset=utf-8");
    }

    send(404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(500, { error: "server error" });
  }
}).listen(PORT, () => console.log("wedding site listening on :" + PORT));
