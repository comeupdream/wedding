#!/usr/bin/env node
// End-to-end smoke test for the RSVP backend. Runs the real server against a
// throwaway guest list:
//
//   node tools/smoke.mjs                               # file store
//   TEST_DATABASE_URL=postgres://... node tools/smoke.mjs   # both stores
//
// The whole suite runs against every store, because the point of the store
// abstraction is that nothing above it can tell the difference.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wedding-smoke-"));
const guestsFile = path.join(tmp, "guests.json");
fs.writeFileSync(guestsFile, JSON.stringify([
  { code: "4821", name: "The Dodsons", party: 3, invite: "both", members: ["Amy", "Chris", "Dexter"] },
  { code: "7305", name: "Gita Aunty", party: 1, invite: "ceremony" },
]));
process.env.GUESTS_FILE = guestsFile;
process.env.ADMIN_PASSWORD = "s3cret";

// Imported after the env is set: server.js reads the guest list on load, and a
// static import would be hoisted above these assignments.
const { createApp } = await import("../server.js");
const { createStore, resolveStorage } = await import("../store.js");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures++;
};

const suite = async (label, store) => {
  console.log(`\n${label}`);
  const server = createApp(store).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  // --- unlock -------------------------------------------------------------
  let r = await post("/api/unlock", { code: "4821" });
  let g = await r.json();
  check("unlock with a valid password", r.status === 200 && g.name === "The Dodsons", JSON.stringify(g));
  check("unlock returns seats and scope", g.party === 3 && g.invite === "both", JSON.stringify(g));
  check("unlock names the household members",
    JSON.stringify(g.members) === JSON.stringify(["Amy", "Chris", "Dexter"]), JSON.stringify(g.members));
  check("full invite offers all four answers", g.events.length === 4);
  check("no RSVP on file yet", g.rsvp === null);

  r = await post("/api/unlock", { code: "7305" });
  g = await r.json();
  check("ceremony-only invite offers ceremony or decline",
    JSON.stringify(g.events) === JSON.stringify(["ceremony", "none"]), JSON.stringify(g.events));

  r = await post("/api/unlock", { code: "0000" });
  check("unknown password is rejected", r.status === 404);

  // --- per-person answers -------------------------------------------------
  // Amy comes to both and eats vegetarian, Chris to the ceremony only,
  // Dexter to the reception only. Three people, three different answers.
  r = await post("/api/rsvp", { code: "4821", email: "dodson@example.com", note: "Can't wait", attendees: [
    { name: "Amy", ceremony: true, reception: true, vegetarian: true },
    { name: "Chris", ceremony: true, reception: false },
    { name: "Dexter", ceremony: false, reception: true },
  ] });
  let saved = (await r.json()).rsvp;
  const firstAt = saved.firstAt;
  check("each person's answer is kept", saved.attendees.length === 3, JSON.stringify(saved.attendees));
  check("ceremony headcount counts only the ceremony ticks", saved.ceremony === 2, JSON.stringify(saved));
  check("reception headcount counts only the reception ticks", saved.reception === 2, JSON.stringify(saved));
  check("party is everyone coming to anything", saved.party === 3, JSON.stringify(saved));
  check("a household split across both events reads as both", saved.events === "both", saved.events);
  check("vegetarian is counted per person", saved.vegetarian === 1 && saved.standard === 1, JSON.stringify(saved));

  // A ceremony-only guest can't be given a reception seat, however the request is shaped.
  r = await post("/api/rsvp", { code: "7305", email: "g@example.com", attendees: [
    { name: "Gita Aunty", ceremony: false, reception: true, vegetarian: true },
  ] });
  saved = (await r.json()).rsvp;
  check("ceremony-only guest cannot claim the reception",
    saved.reception === 0 && saved.events === "none", JSON.stringify(saved));

  // Extra rows beyond the seats held are dropped.
  r = await post("/api/rsvp", { code: "4821", email: "dodson@example.com", attendees: [
    { name: "Amy", ceremony: true, reception: true },
    { name: "Chris", ceremony: true, reception: true },
    { name: "Dexter", ceremony: true, reception: true },
    { name: "Gatecrasher", ceremony: true, reception: true },
  ] });
  saved = (await r.json()).rsvp;
  check("a party can't grow past its seats", saved.attendees.length === 3 && saved.party === 3, JSON.stringify(saved));
  check("re-submitting replaces the earlier answer", saved.ceremony === 3 && saved.reception === 3);
  check("the first-answered timestamp is kept", saved.firstAt === firstAt, `${saved.firstAt} vs ${firstAt}`);

  // Nobody ticked: the household declines.
  r = await post("/api/rsvp", { code: "4821", email: "dodson@example.com", attendees: [
    { name: "Amy", ceremony: false, reception: false },
    { name: "Chris", ceremony: false, reception: false },
    { name: "Dexter", ceremony: false, reception: false },
  ] });
  saved = (await r.json()).rsvp;
  check("nobody coming reads as a decline", saved.events === "none" && saved.party === 0);

  // Back to yes, so the export below has something to total.
  await post("/api/rsvp", { code: "4821", email: "dodson@example.com", attendees: [
    { name: "Amy", ceremony: true, reception: true, vegetarian: true },
    { name: "Chris", ceremony: true, reception: false },
    { name: "Dexter", ceremony: false, reception: true },
  ] });

  r = await post("/api/unlock", { code: "4821" });
  g = await r.json();
  check("unlock replays each person's answer",
    g.rsvp && g.rsvp.attendees[0].name === "Amy" && g.rsvp.attendees[0].vegetarian === true,
    JSON.stringify(g.rsvp && g.rsvp.attendees));

  r = await post("/api/rsvp", { code: "0000", attendees: [] });
  check("RSVP with an unknown password is rejected", r.status === 404);

  // A cached copy of the old form posts no attendees list. That must fail loudly
  // rather than be read as "nobody is coming".
  r = await post("/api/rsvp", { code: "4821", events: "both", party: 3, vegetarian: 1, email: "x@example.com" });
  check("a body with no attendees is refused", r.status === 400, String(r.status));
  r = await post("/api/unlock", { code: "4821" });
  check("...and the earlier answer is left untouched", (await r.json()).rsvp.party === 3);

  // --- admin --------------------------------------------------------------
  r = await fetch(base + "/api/rsvps");
  check("export needs the admin password", r.status === 401);

  r = await fetch(base + "/api/rsvps", { headers: { Authorization: "Bearer wrong" } });
  check("export rejects a wrong admin password", r.status === 401);

  r = await fetch(base + "/api/rsvps", { headers: { Authorization: "Bearer s3cret" } });
  const data = await r.json();
  check("export lists both responses", r.status === 200 && data.rsvps.length === 2, JSON.stringify(data.totals));
  check("totals count the ceremony headcount", data.totals.ceremony === 2, JSON.stringify(data.totals));
  check("totals count the reception headcount", data.totals.reception === 2, JSON.stringify(data.totals));
  check("totals count meals from reception guests only",
    data.totals.vegetarian === 1 && data.totals.standard === 1, JSON.stringify(data.totals));
  check("totals count declines", data.totals.declined === 1, JSON.stringify(data.totals));
  check("nobody is left awaiting a reply", data.awaiting.length === 0);
  check("export reports which store is in use", data.storage.kind === store.kind && data.storage.durable === store.durable,
    JSON.stringify(data.storage));

  r = await fetch(base + "/api/rsvps.csv", { headers: { Authorization: "Bearer s3cret" } });
  const csv = await r.text();
  check("CSV export has a header and a row per guest",
    csv.startsWith("code,name,invite,events") && csv.trim().split("\n").length === 3);
  check("CSV spells out who is coming to what",
    csv.includes("Amy (ceremony + reception, vegetarian)") && csv.includes("Chris (ceremony)"),
    csv.split("\n")[1]);

  // --- throttle -----------------------------------------------------------
  let throttled = false;
  for (let i = 0; i < 12; i++) {
    const res = await post("/api/unlock", { code: String(1000 + i) });
    if (res.status === 429) { throttled = true; break; }
  }
  check("repeated wrong guesses get throttled", throttled);
  r = await post("/api/unlock", { code: "4821" });
  check("a correct password is still refused while locked out", r.status === 429);

  // --- static -------------------------------------------------------------
  r = await fetch(base + "/healthz");
  const health = await r.json();
  check("health check reports guests and storage", health.guests === 2 && health.storage === store.kind);
  r = await fetch(base + "/");
  check("the invite page is served", r.status === 200 && r.headers.get("content-type").includes("text/html"));
  r = await fetch(base + "/assets/../../server.js");
  check("asset paths can't escape the site directory", r.status === 404);
  r = await fetch(base + "/invite?c=4821");
  check("the invitation card is served", r.status === 200 && r.headers.get("content-type").includes("text/html"));
  check("pages aren't cached, so nobody submits a stale form",
    r.headers.get("cache-control") === "no-cache");
  check("the card is kept out of search results", r.headers.get("x-robots-tag") === "noindex");
  r = await fetch(base + "/assets/fonts.css");
  check("the shared font stylesheet is served as CSS",
    r.status === 200 && r.headers.get("content-type").startsWith("text/css"), r.headers.get("content-type"));

  server.close();
};

// --- storage selection ------------------------------------------------------
console.log("storage selection");
const disk = fs.mkdtempSync(path.join(os.tmpdir(), "wedding-disk-"));
let where = resolveStorage({}, [disk]);
check("a mounted disk is found without an env var", where.dir === disk && where.durable, JSON.stringify(where));
where = resolveStorage({}, ["/definitely-not-mounted"]);
check("no disk falls back to a working copy", !where.durable && where.dir.endsWith("data"), JSON.stringify(where));
where = resolveStorage({ DATA_DIR: "/somewhere/else" }, [disk]);
check("DATA_DIR still wins if it's set", where.dir === "/somewhere/else" && where.durable);
fs.rmSync(disk, { recursive: true, force: true });

const fileStore = await createStore({ DATA_DIR: path.join(tmp, "data") });
check("files are used when DATABASE_URL is unset", fileStore.kind === "files");
await suite("file store", fileStore);

// --- postgres ---------------------------------------------------------------
const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) {
  {
    const { default: pg } = await import("pg");
    const wipe = new pg.Pool({ connectionString: dbUrl });
    await wipe.query("drop table if exists rsvps, rsvp_log");
    await wipe.end();
  }
  const pgStore = await createStore({ DATABASE_URL: dbUrl });
  check("postgres is used when DATABASE_URL is set", pgStore.kind === "postgres" && pgStore.durable);
  await suite("postgres store", pgStore);

  // The whole reason Postgres is here: a fresh process — a redeploy — still
  // sees every answer. Nothing is carried over but the connection string.
  console.log("\nsurviving a restart");
  const restarted = await createStore({ DATABASE_URL: dbUrl });
  const after = await restarted.all();
  check("RSVPs are still there after a restart", Object.keys(after).length === 2, JSON.stringify(Object.keys(after)));
  check("every person's answer survives the restart",
    after["4821"].attendees.length === 3 && after["4821"].attendees[0].vegetarian === true,
    JSON.stringify(after["4821"].attendees));
  await restarted.close();

  // The audit log is the one thing the API never exposes, so check it directly.
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: dbUrl });
  const { rows } = await pool.query("select count(*)::int as n from rsvp_log where code = '4821'");
  console.log("\npostgres internals");
  check("every submission is kept in the audit log", rows[0].n === 4, `${rows[0].n} rows`);
  const cols = await pool.query(
    "select column_name from information_schema.columns where table_name = 'rsvps' order by ordinal_position");
  check("the rsvps table has the expected columns",
    cols.rows.map((c) => c.column_name).join(",") ===
    // ceremony/reception/attendees sit at the end: they arrived as ALTERs on an
    // existing table, which is exactly how a live database picks them up.
    "code,name,invite,events,party,seats,vegetarian,standard,email,note,at,first_at,ceremony,reception,attendees",
    cols.rows.map((c) => c.column_name).join(","));
  await pool.end();
  await pgStore.close();
} else {
  console.log("\nskipped the postgres suite — set TEST_DATABASE_URL to run it");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
