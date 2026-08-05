# Sharon & Zachary — Wedding

Planning files, the invite website, and the RSVP backend for the wedding at
Lydia Mountain, Virginia — **Saturday, October 10, 2026**.

## Contents

- `WEDDING_GUEST_LIST.xlsx` — the planning workbook:
  - **Guest List** — every guest with counts by column (Richmond / Other Cities / India / Sharon's side), formula totals (87 guests)
  - **Guest Codes** — the original invitation codes
  - **Budget** — 14 line items, $36,250 total
  - **Indian Food** — itemized caterer quote, $5,100
  - **American Dinner** — $115/person menu and cost calculator
  - **Original (backup)** — the untouched original tally sheet
- `guest-codes.json` — the live guest list the server reads: one entry per
  invitation with its password, seat count, and which events it covers
- `server.js` — the web service: serves the site, validates passwords, stores RSVPs
- `tools/` — password generator, link generator, and an end-to-end smoke test
- `site/index.html` — the invite website, fully self-contained (fonts and images embedded)
- `site/invite.html` — the personal invitation card: envelope, wax seal, and the card inside
- `site/img/` — original photos (engagement + venue) before web optimization

## Running it locally

```sh
npm start                       # http://localhost:3000
ADMIN_PASSWORD=letmein npm start   # also unlocks http://localhost:3000/admin
npm test                        # end-to-end check of the whole RSVP flow
```

## Invitations

Every invitation has its own **four-digit password**. One invitation covers a
whole household — the seat count is on the guest record, so a family of four
answers once. 62 invitations, 104 seats.

### Updating the guest list from the workbook

`WEDDING_GUEST_LIST.xlsx` stays the planning source of truth. Export its **Guest
List** tab as CSV over `guests.csv`, then:

```sh
node tools/import-guests.mjs              # show what would change
node tools/import-guests.mjs --write      # apply it
```

It keeps the password of anyone already on the list, so links you've already
sent keep working, and mints one for everybody new. Columns: `name`, `party`,
`invite`, `contact` — only `name` is required.

Four rows in the workbook are deliberately not invitations: Sharon and Zachary
themselves, and the two tentative "estimate, up to 5" placeholders for the
bride's extended family. Give those real names in the sheet and they'll import.

### Passwords

```sh
npm run codes                             # give a password to anyone missing one
npm run codes -- --all                    # regenerate every password
npm run codes -- --list                   # print the list, change nothing
npm run codes -- --add "Cousin Ravi" --party 2
```

Passwords are drawn from 1000–9999, skipping easy guesses (1111, 1234, 9876) and
anything already in use. Regenerating invalidates the old ones, so only run
`--all` before invitations go out.

### Ceremony-only invitations

Each guest is invited to `both` (default), `ceremony`, or `reception`. That
choice decides what the RSVP form even offers — a ceremony-only guest can pick
*Ceremony* or *Cannot attend*, and the server rejects a reception RSVP from them
even if the request is forged.

```sh
npm run codes -- --scope ceremony --who "Gita Aunty,Loey"
npm run codes -- --scope both --who "Gita Aunty"          # put someone back
```

Guests invited to both events choose **ceremony, reception, or both** when they
RSVP.

### Personal links

Every invitation gets a link with its password already in it, so nobody has to
type anything — the site unlocks on load and scrubs the password out of the
address bar. `https://your-site.example/?c=4821#rsvp`

**The easy way: `/admin` → Invitations & links.** Every household with its
password, its invitation link, a copy button, and where to send it. **Preview**
opens that family's actual invitation in a modal, so you can see exactly what
they'll get before you send it. Filter to households, ceremony-only invites,
who's coming, or who hasn't replied, then **Copy these links** or **Download
links CSV** for just that group. Links are built from the address you're on, so
they're always the right hostname.

### The invitation card

The link you send opens `/invite?c=####`: a vanilla envelope addressed to the
household in script, sealed with a red wax **W**. Opening it — by click, tap, or
keyboard — breaks the seal: the wax splits into shards struck out from its
centre and a puff of maple leaves and a couple of small hearts drifts out and
falls, all drawn on a canvas rather than played from a file, so no two openings
look the same. It runs about 2.2 seconds, clears its own canvas, and stops.
Behind it the flap lifts and the card rises into the envelope's place, showing: both names, everyone on that invitation by name,
the date, what they're invited to, how many seats are held, and a button through
to the RSVP form that carries their password. Someone who opens it with a bad
link still gets a card; it just asks for the password at the RSVP step.

The same thing from a terminal, if you'd rather:

```sh
npm run links -- --base https://your-site.onrender.com
npm run links -- --base https://your-site.onrender.com --scope ceremony
npm run links -- --base https://your-site.onrender.com --format csv --out links.csv
npm run links -- --base https://your-site.onrender.com --who "Herpal,Durga"
```

Formats: `table` (default), `csv` for a mail merge, `md`, `txt` for pasting into
a message.

### How a household answers

One invitation, one row per seat. Each person ticks **Ceremony**, **Reception**,
both, or neither — so a family can split however they need, and the ceremony and
reception headcounts are counted separately rather than inferred from one
dropdown. Where the workbook names the people, the rows are prefilled; where it
doesn't, the household types who's coming.

**Vegetarian** is the one food question, asked per person and only of those
staying for the reception. `/admin` totals it alongside the two headcounts, and
the CSV spells each household out — `Amy (ceremony + reception, vegetarian);
Chris (ceremony)` — so the caterer needs nothing else.

A ceremony-only invitation never shows a reception tick, and the server rejects
one even if the request is forged.

## Collecting RSVPs

`/admin` asks for `ADMIN_PASSWORD` and shows every answer, who hasn't replied
yet, headcounts for the ceremony and the reception, and the meal split. The
**Download CSV** button pulls the whole list for the caterer.

Guests can RSVP again at any time — the latest answer replaces the earlier one,
and unlocking shows them what they last sent so they can amend it.

### Where the answers live

Set `DATABASE_URL` and RSVPs go to Postgres — two tables, `rsvps` (the current
answer per invitation) and `rsvp_log` (every submission ever received, so an
amended answer never erases what came before). The server creates both on first
boot; there's no migration step.

With no `DATABASE_URL` it falls back to JSON files, which is what makes
`npm start` and the tests work on a laptop with nothing installed. That fallback
is not durable, and it says so — in the startup logs and in red at the top of
`/admin`. Every RSVP is also printed to the service logs as a backup copy either
way.

If you point `DATABASE_URL` at a provider outside Render, append `?sslmode=require`
so the connection is encrypted.

## Accessibility

The invite page, the invitation card, and `/admin` are checked against **WCAG 2.2
AAA** — axe-core reports zero violations across every state, including the
opened card, the RSVP form, and the admin links tab.

The opening animation is held to the same bar: `prefers-reduced-motion` skips
the particles entirely, nothing flashes, and it ends well inside the five
seconds past which WCAG asks for a pause control.

What that meant in practice: every text colour is measured rather than guessed
(the `--maple-ink`, `--gold-ink` and `--ink-muted` tokens all clear 7:1 on paper,
and the comments record the ratios); each RSVP checkbox carries its own name, so
it reads as "Amy — Ceremony" rather than an unlabelled box; the envelope is a
real button that opens on Enter or Space and moves focus to the card; and
`prefers-reduced-motion` turns the flap animation off entirely.

Re-run it after any visual change — a colour tweak is the easiest way to fall
back out of AAA.

## Deploying

`render.yaml` is a Render blueprint: push to GitHub, then **New + → Blueprint**
and point it at this repo. It must be a **Web Service**, not a Static Site — the
site and the API are the same process.

The blueprint creates two things: the web service and a `basic-256mb` Postgres
instance, with `DATABASE_URL` wired between them automatically. The one thing to
do by hand is set `ADMIN_PASSWORD` in the Render dashboard.

Don't drop the database to Render's free Postgres plan — it is deleted 30 days
after creation, taking every RSVP with it.

Editing `guest-codes.json` needs a redeploy to take effect (or `kill -HUP` the
process if you're on a shell).

### A note on four-digit passwords

Four digits is 9,000 combinations, which a script could walk through — so the
throttle is the real lock: eight wrong guesses from one address buys a
15-minute timeout. That is plenty for a wedding guest list, where the worst case
is a stranger seeing the invite page and RSVPing as someone else. If you want
something stronger, `npm run codes -- --all --length 6` widens every password;
the links carry it either way.
