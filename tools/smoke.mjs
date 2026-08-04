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
  { code: "4821", name: "Herpal Family", party: 3, invite: "both" },
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

  // --- rsvp ---------------------------------------------------------------
  r = await post("/api/rsvp", { code: "4821", events: "both", party: 3, vegetarian: 2, email: "h@example.com", note: "Can't wait" });
  let saved = (await r.json()).rsvp;
  const firstAt = saved.firstAt;
  check("RSVP for both events is stored", r.status === 200 && saved.events === "both" && saved.party === 3);
  check("vegetarian and standard meals split", saved.vegetarian === 2 && saved.standard === 1, JSON.stringify(saved));

  r = await post("/api/rsvp", { code: "4821", events: "ceremony", party: 2, vegetarian: 9, email: "h@example.com" });
  saved = (await r.json()).rsvp;
  check("re-submitting replaces the answer", saved.events === "ceremony" && saved.party === 2);
  check("vegetarian count is clamped to the party", saved.vegetarian === 2, JSON.stringify(saved));
  check("the first-answered timestamp is kept", saved.firstAt === firstAt, `${saved.firstAt} vs ${firstAt}`);

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

  // --- admin --------------------------------------------------------------
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
  check("export reports which store is in use", data.storage.kind === store.kind && data.storage.durable === store.durable,
    JSON.stringify(data.storage));

  r = await fetch(base + "/api/rsvps.csv", { headers: { Authorization: "Bearer s3cret" } });
  const csv = await r.text();
  check("CSV export has a header and a row per guest",
    csv.startsWith("code,name,invite,events") && csv.trim().split("\n").length === 3);

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
  const pgStore = await createStore({ DATABASE_URL: dbUrl });
  check("postgres is used when DATABASE_URL is set", pgStore.kind === "postgres" && pgStore.durable);
  await suite("postgres store", pgStore);

  // The whole reason Postgres is here: a fresh process — a redeploy — still
  // sees every answer. Nothing is carried over but the connection string.
  console.log("\nsurviving a restart");
  const restarted = await createStore({ DATABASE_URL: dbUrl });
  const after = await restarted.all();
  check("RSVPs are still there after a restart", Object.keys(after).length === 2, JSON.stringify(Object.keys(after)));
  check("the answers come back intact", after["4821"].events === "none" && after["7305"].vegetarian === 0,
    JSON.stringify(after["4821"]));
  await restarted.close();

  // The audit log is the one thing the API never exposes, so check it directly.
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: dbUrl });
  const { rows } = await pool.query("select count(*)::int as n from rsvp_log where code = '4821'");
  console.log("\npostgres internals");
  check("every submission is kept in the audit log", rows[0].n === 3, `${rows[0].n} rows`);
  const cols = await pool.query(
    "select column_name from information_schema.columns where table_name = 'rsvps' order by ordinal_position");
  check("the rsvps table has the expected columns",
    cols.rows.map((c) => c.column_name).join(",") ===
    "code,name,invite,events,party,seats,vegetarian,standard,email,note,at,first_at",
    cols.rows.map((c) => c.column_name).join(","));
  await pool.end();
  await pgStore.close();
} else {
  console.log("\nskipped the postgres suite — set TEST_DATABASE_URL to run it");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
