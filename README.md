# Sharon & Zachary — Wedding

Planning files, the invite website, and the RSVP backend for the wedding at
Lydia Mountain, Virginia.

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
answers once.

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

The link generator puts the password straight into the URL, so nobody has to
type anything — the site unlocks on load and scrubs the password out of the
address bar.

```sh
npm run links -- --base https://your-site.onrender.com
npm run links -- --base https://your-site.onrender.com --scope ceremony
npm run links -- --base https://your-site.onrender.com --format csv --out links.csv
npm run links -- --base https://your-site.onrender.com --who "Herpal,Durga"
```

Formats: `table` (default), `csv` for a mail merge, `md`, `txt` for pasting into
a message. Each link looks like `https://your-site.example/?c=4821#rsvp`.

### Dinner

One food option, asked only of guests staying for the reception: **vegetarian**.
A single guest picks standard or vegetarian; a household is asked how many of
their party need a vegetarian meal. The `/admin` dashboard totals both.

## Collecting RSVPs

`/admin` asks for `ADMIN_PASSWORD` and shows every answer, who hasn't replied
yet, headcounts for the ceremony and the reception, and the meal split. The
**Download CSV** button pulls the whole list for the caterer.

Guests can RSVP again at any time — the latest answer replaces the earlier one,
and unlocking shows them what they last sent so they can amend it.

Storage lives under `DATA_DIR`: `rsvps.json` holds the current answer per
invitation, `rsvps.log.jsonl` appends every submission ever received. Each one is
also printed to the service logs as a third copy.

## Deploying

`render.yaml` is a Render blueprint: push to GitHub, then **New + → Blueprint**
and point it at this repo. Set `ADMIN_PASSWORD` in the Render dashboard once the
service exists. The blueprint mounts a 1 GB disk at `/var/data` so RSVPs survive
deploys — see the comments in `render.yaml` to run on the free plan instead.

Editing `guest-codes.json` needs a redeploy to take effect (or `kill -HUP` the
process if you're on a shell).

### A note on four-digit passwords

Four digits is 9,000 combinations, which a script could walk through — so the
throttle is the real lock: eight wrong guesses from one address buys a
15-minute timeout. That is plenty for a wedding guest list, where the worst case
is a stranger seeing the invite page and RSVPing as someone else. If you want
something stronger, `npm run codes -- --all --length 6` widens every password;
the links carry it either way.
