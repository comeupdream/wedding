# Sharon & Zachary — Wedding

Planning files and the invite website for the wedding at Lydia Mountain, Virginia.

## Contents

- `WEDDING_GUEST_LIST.xlsx` — the planning workbook:
  - **Guest List** — every guest with counts by column (Richmond / Other Cities / India / Sharon's side), formula totals (87 guests)
  - **Guest Codes** — 61 unique invitation codes, one per guest or household, matching the website's RSVP gate
  - **Budget** — 14 line items, $36,250 total
  - **Indian Food** — itemized caterer quote, $5,100
  - **American Dinner** — $115/person menu and cost calculator
  - **Original (backup)** — the untouched original tally sheet
- `site/index.html` — the invite website, fully self-contained (fonts and images embedded):
  - Fall-themed hero over Blue Ridge silhouettes with falling leaves
  - Engagement photo gallery, ceremony & reception details
  - "Discover the Venue" tab with lodge photos
  - Code-gated RSVP (ceremony / reception / both) — submissions currently save
    in the guest's browser only; a backend is the next step
- `site/img/` — original photos (engagement + venue) before web optimization

## Deploying the site

`site/index.html` is a single static file — it can be hosted anywhere
(GitHub Pages, Cloudflare Pages, Netlify). Point the domain at it when ready.
