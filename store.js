// Where the RSVPs live.
//
// Postgres when DATABASE_URL is set — that's the deployed setup, and the whole
// point is that answers outlive a deploy. Files when it isn't, so `npm start`
// and the tests work on a laptop with nothing installed. Both stores expose the
// same three calls, so nothing above here knows which one it's talking to.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- files ----------
// Only a directory that already exists counts as a disk: a platform creates the
// mount point, so if none of these are there, nothing durable is attached.
const MOUNTS = ["/var/data", "/data"];
const mounted = (dir) => {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return fs.statSync(dir).isDirectory();
  } catch { return false; }
};
export const resolveStorage = (env = process.env, mounts = MOUNTS) => {
  if (env.DATA_DIR) return { dir: env.DATA_DIR, durable: true, why: "DATA_DIR" };
  const disk = mounts.find(mounted);
  if (disk) return { dir: disk, durable: true, why: "mounted disk" };
  return { dir: path.join(__dirname, "data"), durable: false, why: "no disk attached" };
};

const fileStore = (env) => {
  const { dir, durable, why } = resolveStorage(env);
  const file = path.join(dir, "rsvps.json");
  const log = path.join(dir, "rsvps.log.jsonl");
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  };
  return {
    kind: "files",
    durable,
    detail: `${dir} (${why})`,
    async all() { return read(); },
    async save(entry) {
      fs.mkdirSync(dir, { recursive: true });
      const all = read();
      const prev = all[entry.code];
      all[entry.code] = { ...entry, firstAt: (prev && (prev.firstAt || prev.at)) || entry.at };
      fs.writeFileSync(file + ".tmp", JSON.stringify(all, null, 1));
      fs.renameSync(file + ".tmp", file);
      fs.appendFileSync(log, JSON.stringify(entry) + "\n");
      return all[entry.code];
    },
    async close() {},
  };
};

// ---------- postgres ----------
const SCHEMA = `
create table if not exists rsvps (
  code       text primary key,
  name       text not null,
  invite     text not null,
  events     text not null,
  party      integer not null,
  seats      integer not null,
  vegetarian integer not null,
  standard   integer not null,
  email      text not null default '',
  note       text not null default '',
  at         timestamptz not null,
  first_at   timestamptz not null
);
create table if not exists rsvp_log (
  id    bigserial primary key,
  code  text not null,
  entry jsonb not null,
  at    timestamptz not null default now()
);
-- Added when households moved to answering per person. Written as ALTERs so an
-- existing database picks them up on the next boot without a migration step.
alter table rsvps add column if not exists ceremony  integer not null default 0;
alter table rsvps add column if not exists reception integer not null default 0;
alter table rsvps add column if not exists attendees jsonb   not null default '[]'::jsonb;
`;

const UPSERT = `
insert into rsvps (code, name, invite, events, party, seats, ceremony, reception,
                   vegetarian, standard, attendees, email, note, at, first_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
on conflict (code) do update set
  name = excluded.name, invite = excluded.invite, events = excluded.events,
  party = excluded.party, seats = excluded.seats, ceremony = excluded.ceremony,
  reception = excluded.reception, vegetarian = excluded.vegetarian,
  standard = excluded.standard, attendees = excluded.attendees,
  email = excluded.email, note = excluded.note, at = excluded.at
returning *;
`;

// Row -> the same shape the file store returns, so callers can't tell them apart.
const fromRow = (r) => ({
  code: r.code, name: r.name, invite: r.invite, events: r.events,
  party: r.party, seats: r.seats, ceremony: r.ceremony, reception: r.reception,
  vegetarian: r.vegetarian, standard: r.standard, attendees: r.attendees || [],
  email: r.email, note: r.note,
  at: r.at.toISOString(), firstAt: r.first_at.toISOString(),
});

const pgStore = async (url) => {
  const { default: pg } = await import("pg");
  // Managed providers hand out certs signed by their own CA, so verification is
  // off; the connection is still encrypted. A URL with no sslmode (Render's
  // internal one) stays on the private network unencrypted, which is its design.
  const mode = /[?&]sslmode=([a-z-]+)/.exec(url)?.[1];
  const pool = new pg.Pool({
    connectionString: url,
    ssl: mode && mode !== "disable" ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", (err) => console.error("postgres pool error", err));
  await pool.query(SCHEMA);
  const host = (() => {
    try { return new URL(url).host; } catch { return "postgres"; }
  })();
  return {
    kind: "postgres",
    durable: true,
    detail: host,
    async all() {
      const { rows } = await pool.query("select * from rsvps");
      return Object.fromEntries(rows.map((r) => [r.code, fromRow(r)]));
    },
    async save(entry) {
      const { rows } = await pool.query(UPSERT, [
        entry.code, entry.name, entry.invite, entry.events, entry.party, entry.seats,
        entry.ceremony, entry.reception, entry.vegetarian, entry.standard,
        JSON.stringify(entry.attendees || []), entry.email, entry.note, entry.at,
      ]);
      // Append-only history, so an amended answer never erases what came before.
      await pool.query("insert into rsvp_log (code, entry) values ($1, $2)", [entry.code, entry]);
      return fromRow(rows[0]);
    },
    async close() { await pool.end(); },
  };
};

export const createStore = async (env = process.env) =>
  env.DATABASE_URL ? pgStore(env.DATABASE_URL) : fileStore(env);
