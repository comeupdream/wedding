#!/usr/bin/env node
// End-to-end smoke test for the RSVP backend. Runs the real server against a
// throwaway guest list and data directory: node tools/smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wedding-smoke-"));
const guestsFile = path.join(tmp, "guests.json");
fs.writeFileSync(guestsFile, JSON.stringify([
  { code: "4821", name: "Herpal Family", party: 3, invite: "both" },
  { code: "7305", name: "Gita Aunty", party: 1, invite: "ceremony" },
]));

process.env.DATA_DIR = path.join(tmp, "data");
process.env.GUESTS_FILE = guestsFile;
process.env.ADMIN_PASSWORD = "s3cret";
process.env.PORT = "0";

const { createApp } = await import("../server.js");
const server = createApp().listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures++;
};
const post = (p, body) => fetch(base + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

// --- unlock ---------------------------------------------------------------
let r = await post("/api/unlock", { code: "4821" });
let g = await r.json();
check("unlock with a valid password", r.status === 200 && g.name === "Herpal Family", JSON.stringify(g));
check("unlock returns seats and scope", g.party === 3 && g.invite === "both", JSON.stringify(g));
check("full invite offers all four answers", g.events.length === 4);
check("no RSVP on file yet", g.rsvp === null);

r = await post("/api/unlock", { code: "7305" });
g = await r.json();
check("ceremony-only invite offers ceremony or decline",
  JSON.stringify(g.events) === JSON.stringify(["ceremony", "none"]), JSON.stringify(g.events));

r = await post("/api/unlock", { code: "0000" });
check("unknown password is rejected", r.status === 404);

// --- rsvp -----------------------------------------------------------------
r = await post("/api/rsvp", { code: "4821", events: "both", party: 3, vegetarian: 2, email: "h@example.com", note: "Can't wait" });
let saved = (await r.json()).rsvp;
check("RSVP for both events is stored", r.status === 200 && saved.events === "both" && saved.party === 3);
check("vegetarian and standard meals split", saved.vegetarian === 2 && saved.standard === 1, JSON.stringify(saved));

r = await post("/api/rsvp", { code: "4821", events: "ceremony", party: 2, vegetarian: 9, email: "h@example.com" });
saved = (await r.json()).rsvp;
check("re-submitting replaces the answer", saved.events === "ceremony" && saved.party === 2);
check("vegetarian count is clamped to the party", saved.vegetarian === 2, JSON.stringify(saved));

r = await post("/api/rsvp", { code: "7305", events: "reception", party: 1, email: "g@example.com" });
saved = (await r.json()).rsvp;
check("ceremony-only guest cannot claim the reception", saved.events === "ceremony", saved.events);

r = await post("/api/rsvp", { code: "4821", events: "none", party: 3, email: "h@example.com" });
saved = (await r.json()).rsvp;
check("declining zeroes the headcount", saved.events === "none" && saved.party === 0);

r = await post("/api/unlock", { code: "4821" });
g = await r.json();
check("unlock replays the stored answer", g.rsvp && g.rsvp.events === "none");

r = await post("/api/rsvp", { code: "0000", events: "both" });
check("RSVP with an unknown password is rejected", r.status === 404);

// --- admin ----------------------------------------------------------------
r = await fetch(base + "/api/rsvps");
check("export needs the admin password", r.status === 401);

r = await fetch(base + "/api/rsvps", { headers: { Authorization: "Bearer wrong" } });
check("export rejects a wrong admin password", r.status === 401);

r = await fetch(base + "/api/rsvps", { headers: { Authorization: "Bearer s3cret" } });
const data = await r.json();
check("export lists both responses", r.status === 200 && data.rsvps.length === 2, JSON.stringify(data.totals));
check("totals count the ceremony headcount", data.totals.ceremony === 1, JSON.stringify(data.totals));
check("totals count declines", data.totals.declined === 1, JSON.stringify(data.totals));
check("nobody is left awaiting a reply", data.awaiting.length === 0);

r = await fetch(base + "/api/rsvps.csv", { headers: { Authorization: "Bearer s3cret" } });
const csv = await r.text();
check("CSV export has a header and a row per guest",
  csv.startsWith("code,name,invite,events") && csv.trim().split("\n").length === 3);

// --- throttle -------------------------------------------------------------
let throttled = false;
for (let i = 0; i < 12; i++) {
  const res = await post("/api/unlock", { code: String(1000 + i) });
  if (res.status === 429) { throttled = true; break; }
}
check("repeated wrong guesses get throttled", throttled);
r = await post("/api/unlock", { code: "4821" });
check("a correct password is still refused while locked out", r.status === 429);

// --- static ---------------------------------------------------------------
r = await fetch(base + "/healthz");
check("health check reports the guest count", r.status === 200 && (await r.json()).guests === 2);
r = await fetch(base + "/");
check("the invite page is served", r.status === 200 && r.headers.get("content-type").includes("text/html"));
r = await fetch(base + "/assets/../../server.js");
check("asset paths can't escape the site directory", r.status === 404);

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
