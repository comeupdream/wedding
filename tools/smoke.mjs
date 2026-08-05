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
const { createApp, loadGuests } = await import("../server.js");
const { createStore, resolveStorage } = await import("../store.js");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures++;
};

const suite = async (label, store) => {
  console.log(`\n${label}`);
  // Put the fixture list in the store first: loadGuests only seeds from the repo
  // file when the store is empty, and a reused database will not be.
  await store.putGuests(JSON.parse(fs.readFileSync(guestsFile, "utf8")));
  await loadGuests(store);
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

  // A household where only some can come: the totals must say two people, and
  // must not quietly count the missing one as attending or as unanswered.
  await post("/api/rsvp", { code: "4821", email: "d@example.com", attendees: [
    { name: "Amy", ceremony: true, reception: true },
    { name: "Chris", ceremony: true, reception: true },
    { name: "Dexter", ceremony: false, reception: false },
  ] });
  r = await fetch(base + "/api/rsvps", { headers: { Authorization: "Bearer s3cret" } });
  const split = (await r.json());
  const dodsons = split.rsvps.find((x) => x.code === "4821");
  check("a part-attending family reports who is coming", dodsons.party === 2 && dodsons.seats === 3,
    JSON.stringify(dodsons));
  check("the one who can't come is counted as not coming",
    split.totals.notComing === 2, JSON.stringify(split.totals));
  check("a part-attending family is flagged as partial", split.totals.partial === 1,
    JSON.stringify(split.totals));
  check("the ceremony headcount is people, not invitations",
    split.totals.ceremony === 2, JSON.stringify(split.totals));

  // Put it back so the export checks below see the original answer.
  await post("/api/rsvp", { code: "4821", email: "dodson@example.com", attendees: [
    { name: "Amy", ceremony: true, reception: true, vegetarian: true },
    { name: "Chris", ceremony: true, reception: false },
    { name: "Dexter", ceremony: false, reception: true },
  ] });

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
  const t = data.totals;
  check("totals count the ceremony headcount", t.ceremony === 2, JSON.stringify(t));
  check("totals count the reception headcount", t.reception === 2, JSON.stringify(t));
  check("totals count meals from reception guests only",
    t.vegetarian === 1 && t.standard === 1, JSON.stringify(t));
  // The Dodsons are 3 seats with 3 coming; Gita Aunty is 1 seat and declined.
  check("seats counts every invited person, not every invitation", t.seats === 4, JSON.stringify(t));
  check("coming is a headcount of people", t.coming === 3, JSON.stringify(t));
  check("a decline is counted as a person, not an invitation", t.notComing === 1, JSON.stringify(t));
  check("nobody is left unaccounted for once all have answered", t.awaiting === 0, JSON.stringify(t));
  check("the headcounts add up to the seats invited",
    t.coming + t.notComing + t.awaiting === t.seats, JSON.stringify(t));
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

// --- reading a spreadsheet ---------------------------------------------------
console.log("spreadsheet import");
const { readUpload, merge, parseCsv } = await import("../guest-import.js");
const csv = Buffer.from(
  "name,party,invite,contact,members\n" +
  "The Dodsons,4,both,amy@example.com,Amy; Chris; Dexter; Taylor\n" +
  'Gita Aunty,1,ceremony,,\n' +
  '"Bawa, Toffee and Harry",2,both,,Toffee; Harry\n');
let up = readUpload(csv, "list.csv");
check("a CSV export is read", up.guests.length === 3, JSON.stringify(up.guests.map((g) => g.name)));
check("quoted commas survive", up.guests[2].name === "Bawa, Toffee and Harry", up.guests[2].name);
check("members are split on semicolons", up.guests[0].members.join("|") === "Amy|Chris|Dexter|Taylor");
check("a ceremony-only scope is read", up.guests[1].invite === "ceremony");

// The planning workbook's own layout: banners, headcount columns, NOT COMING.
const sheet = Buffer.from(
  "Guest List,Guests Email or phone #,RICHMOND,OTHER CITIES,INDIA,SHARON'S\n" +
  "GROOM'S SIDE — IMMEDIATE FAMILY,,,,,\n" +
  "Zachary (Groom),,1,,,\n" +
  "Mother – Rashmi,,1,,,\n" +
  "Ravi & Geeta Varma,v@example.com,,2,,\n" +
  '"Cousins (estimate, up to 5)",,,,,5\n' +
  "Blank Count Person,,,,,\n" +
  "TOTAL,,2,2,,5\n" +
  "NOT COMING,,,,,\n" +
  "Pratima & Ravi,p@example.com,,,,\n");
up = readUpload(sheet, "book.csv");
const names = up.guests.map((g) => g.name);
check("section banners are skipped", !names.includes("GROOM'S SIDE — IMMEDIATE FAMILY"), names.join("|"));
check("the couple are not invitations", !names.some((n) => /Groom|Bride/.test(n)), names.join("|"));
check("placeholder estimate rows are skipped", !names.some((n) => /estimate/.test(n)));
check("NOT COMING is honoured", !names.includes("Pratima & Ravi"), names.join("|"));
check("headcounts add across the columns", up.guests.find((g) => g.name.startsWith("Ravi")).party === 2);
check("a blank headcount falls back to one seat",
  up.guests.find((g) => g.name === "Blank Count Person").party === 1);
check("skipped rows are reported back", up.skipped.length === 3, JSON.stringify(up.skipped));

const before = [{ code: "4821", name: "The Dodsons", party: 3, invite: "ceremony", contact: "", members: [] }];
const plan = merge(before, readUpload(csv).guests, (lo, hi) => lo + Math.floor(Math.random() * (hi - lo)));
check("an existing password is kept", plan.list.find((g) => g.name === "The Dodsons").code === "4821");
check("a scope set by hand is kept", plan.list.find((g) => g.name === "The Dodsons").invite === "ceremony");
check("new guests get fresh passwords",
  plan.added.length === 2 && plan.list.filter((g) => /^\d{4}$/.test(g.code)).length === 3,
  JSON.stringify(plan.added));
check("a changed seat count is reported", plan.changed.some((c) => c.includes("seats 3")), plan.changed.join("|"));
check("passwords never collide", new Set(plan.list.map((g) => g.code)).size === 3);
check("the real workbook parses", (() => {
  try {
    const wb = fs.readFileSync("/root/.claude/uploads/37f4758c-02f6-5314-99c5-ad3acb2225b6/a7a62819-WEDDING_GUEST_LIST_4_1.xlsx");
    const r = readUpload(wb, "WEDDING_GUEST_LIST.xlsx");
    // 103, not 104: one row has no headcount at all and is flagged rather than guessed.
    return r.guests.length === 69 && r.guests.reduce((n, g) => n + g.party, 0) === 103
      && r.guests.filter((g) => g.noCount).length === 1;
  } catch (e) { return e.code === "ENOENT"; }   // not present outside this session
})());

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
    await wipe.query("drop table if exists rsvps, rsvp_log, guests");
    await wipe.end();
  }
  const pgStore = await createStore({ DATABASE_URL: dbUrl });
  check("postgres is used when DATABASE_URL is set", pgStore.kind === "postgres" && pgStore.durable);
  await suite("postgres store", pgStore);

  // A standing at the wedding has to survive the store, not just live in memory:
  // the gold and silver seals are driven entirely by this field.
  await pgStore.putGuests([
    { code: "4821", name: "The Dodsons", party: 3, invite: "both", contact: "",
      members: ["Amy", "Chris", "Dexter"], role: "" },
    { code: "9999", name: "TEST", party: 2, invite: "both", contact: "",
      members: [], role: "", ask: "", test: true },
    { code: "1001", name: "Jon Snyder", party: 1, invite: "both", contact: "",
      members: ["Jon"], role: "best-man" },
    { code: "1002", name: "Carson Whitmore", party: 1, invite: "both", contact: "",
      members: ["Carson"], role: "groomsman" },
  ]);
  const back = await pgStore.guests();
  console.log("\nroles through postgres");
  check("the best man's role survives the database",
    (back.find((g) => g.code === "1001") || {}).role === "best-man",
    JSON.stringify(back.map((g) => [g.code, g.role])));
  check("a groomsman's role survives too",
    (back.find((g) => g.code === "1002") || {}).role === "groomsman");
  check("everyone else has no role", (back.find((g) => g.code === "4821") || {}).role === "");
  check("a test invitation stays a test invitation through the database",
    (back.find((g) => g.code === "9999") || {}).test === true &&
    (back.find((g) => g.code === "4821") || {}).test === false,
    JSON.stringify(back.map((g) => [g.code, g.test])));
  await pgStore.putGuests(JSON.parse(fs.readFileSync(guestsFile, "utf8")));

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
  check("every submission is kept in the audit log", rows[0].n === 6, `${rows[0].n} rows`);
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
