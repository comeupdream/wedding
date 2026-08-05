#!/usr/bin/env node
// Render a share card per invitation — the sealed envelope, addressed to that
// household, sized for a link preview (1200×630).
//
//   node tools/share-cards.mjs                # every invitation with a role
//   node tools/share-cards.mjs --all          # everybody
//   node tools/share-cards.mjs --who "Lynda"
//
// Link previews want a raster image; SVG is ignored by most of them. So these
// are rendered once, here, and committed — the running service just serves the
// file. Needs Playwright, which is a tool-time dependency, not a server one:
//   npm i -D playwright   (or run it wherever Playwright is already installed)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site", "assets", "share");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

// Same wax as the card itself.
// `shine` is the sheen and mica: every standing has it, ordinary red does not.
const WAX = {
  "":              { a: "#A83525", b: "#7E2517", c: "#5C1409", ring: "#5B1409" },
  "best-man":      { a: "#FBE9A8", b: "#C79A2A", c: "#5F430A", ring: "#5A3E09", shine: true },
  "maid-of-honor": { a: "#FBE9A8", b: "#C79A2A", c: "#5F430A", ring: "#5A3E09", shine: true },
  "groom-mother":  { a: "#8FB6DF", b: "#33608F", c: "#1A3654", ring: "#12283E", shine: true },
  "bride-parents": { a: "#8FB6DF", b: "#33608F", c: "#1A3654", ring: "#12283E", shine: true },
  "groom-sister":  { a: "#A8DCBE", b: "#2A6A4A", c: "#1B4A33", ring: "#123524", shine: true },
  "groomsman":     { a: "#E6EAEE", b: "#8C9298", c: "#5A6067", ring: "#464C52", shine: true },
  "bridesmaid":    { a: "#EBA3B7", b: "#A34568", c: "#742640", ring: "#5E1B30", shine: true },
};

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const page = (guest, fontCss) => {
  const wax = WAX[guest.role] || WAX[""];
  // The envelope is addressed to the household; a trailing parenthetical would
  // run into the seal, so it's dropped here exactly as it is on the card.
  const to = String(guest.name).replace(/\s*\([^)]*\)\s*$/, "");
  const long = to.length > 22;
  return `<!doctype html><meta charset="utf-8"><style>
${fontCss}
  html,body{margin:0;width:1200px;height:630px;overflow:hidden}
  body{display:grid;place-items:center;
    background:radial-gradient(120% 95% at 50% 0%, #4A2038 0%, #2E1A2E 55%, #241522 100%)}
  .env{position:relative;width:760px;height:470px;
    background:linear-gradient(160deg,#FBF1DC 0%,#F6EAD2 45%,#EFE0C2 100%);
    border:1px solid #E4D2AE;box-shadow:0 26px 60px rgba(0,0,0,.5)}
  .env::before,.env::after{content:"";position:absolute;bottom:0;width:52%;height:100%;
    background:linear-gradient(120deg,rgba(0,0,0,.05),rgba(0,0,0,0))}
  .env::before{left:0;clip-path:polygon(0 0,100% 100%,0 100%)}
  .env::after{right:0;clip-path:polygon(100% 0,100% 100%,0 100%)}
  .flap{position:absolute;inset:0 0 auto 0;height:62%;
    background:linear-gradient(180deg,#FBF1DC 0%,#F1E2C4 100%);
    border:1px solid #E4D2AE;border-bottom:0;clip-path:polygon(0 0,100% 0,50% 100%)}
  .to{position:absolute;left:0;right:0;bottom:14%;padding:0 7%;text-align:center;
    font-family:"Parisienne",cursive;color:#2B1A17;line-height:1.15;
    font-size:${long ? 40 : 54}px}
  .hint{position:absolute;left:0;right:0;bottom:5.5%;text-align:center;
    font-family:"Iowan Old Style",Palatino,Georgia,serif;font-size:15px;
    letter-spacing:.28em;text-transform:uppercase;color:#57403A}
  .seal{position:absolute;left:50%;top:62%;width:132px;height:132px;
    transform:translate(-50%,-50%);filter:drop-shadow(0 5px 8px rgba(0,0,0,.45))}
</style>
<div class="env">
  <div class="flap"></div>
  <div class="to">${esc(to)}</div>
  <div class="hint">You are invited</div>
  <svg class="seal" viewBox="0 0 100 100">
    <defs>
      <radialGradient id="w" cx="36%" cy="28%" r="78%">
        <stop offset="0%" stop-color="${wax.a}"/>
        <stop offset="55%" stop-color="${wax.b}"/>
        <stop offset="100%" stop-color="${wax.c}"/>
      </radialGradient>
      <radialGradient id="s" cx="34%" cy="24%" r="42%">
        <stop offset="0%" stop-color="#FFF6D4" stop-opacity=".7"/>
        <stop offset="60%" stop-color="#FFF6D4" stop-opacity=".14"/>
        <stop offset="100%" stop-color="#FFF6D4" stop-opacity="0"/>
      </radialGradient>
      <filter id="m" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>
        <feColorMatrix in="n" type="matrix" result="q"
          values="0 0 0 0 1  0 0 0 0 0.93  0 0 0 0 0.72  7 -3 -3 0 -3.1"/>
        <feComposite in="q" in2="SourceGraphic" operator="in"/>
      </filter>
      <clipPath id="c"><path d="M50 3c13 0 22 6 31 13s16 16 15 30-9 24-18 32-21 19-33 17-25-11-33-20S1 55 3 42 14 20 24 13 37 3 50 3Z"/></clipPath>
    </defs>
    <path fill="url(#w)" d="M50 3c13 0 22 6 31 13s16 16 15 30-9 24-18 32-21 19-33 17-25-11-33-20S1 55 3 42 14 20 24 13 37 3 50 3Z"/>
    ${wax.shine ? '<g clip-path="url(#c)"><rect width="100" height="100" fill="url(#s)"/>' +
      '<rect width="100" height="100" filter="url(#m)" opacity=".55"/></g>' : ""}
    <circle cx="50" cy="50" r="33" fill="none" stroke="${wax.ring}" stroke-opacity=".45" stroke-width="1.6"/>
    <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
      font-family="Didot, 'Bodoni MT', Georgia, serif" font-size="40" fill="#FBEDDC" fill-opacity=".93">W</text>
  </svg>
</div>`;
};

const guests = JSON.parse(fs.readFileSync(path.join(ROOT, "guest-codes.json"), "utf8"));
const who = opt("who", null);
let list = guests.filter((g) => (flag("all") ? true : Boolean(g.role)));
if (who) {
  const needles = who.split(",").map((s) => s.trim().toLowerCase());
  list = guests.filter((g) => needles.some((n) => g.name.toLowerCase().includes(n)));
}
if (!list.length) {
  console.error("nothing to render — no invitation has a role yet, or --who matched nobody");
  process.exit(1);
}

// A bare import resolves from this file's folder, so also try the folder the
// command was run from — that's usually where Playwright actually lives.
const loadPlaywright = async () => {
  const tries = ["playwright",
    path.join(process.cwd(), "node_modules", "playwright", "index.mjs"),
    path.join(process.cwd(), "node_modules", "playwright", "index.js")];
  for (const t of tries) {
    try { return await import(t.startsWith("playwright") ? t : "file://" + t); } catch { /* next */ }
  }
  return null;
};
const pw = await loadPlaywright();
if (!pw) {
  console.error("Playwright isn't installed here. `npm i -D playwright`, or run this from a\n" +
    "folder that has it. Set CHROMIUM_PATH if the browser lives somewhere unusual.");
  process.exit(1);
}
const { chromium } = pw;
const fontCss = fs.readFileSync(path.join(ROOT, "site", "assets", "fonts.css"), "utf8");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const g of list) {
  await tab.setContent(page(g, fontCss), { waitUntil: "load" });
  await tab.evaluate(() => document.fonts.ready);
  // JPEG, not PNG: these are all gradients, so a PNG lands near 300KB while a
  // high-quality JPEG is a fifth of that. Link previews take either.
  const file = path.join(OUT, `${g.code}.jpg`);
  await tab.screenshot({ path: file, type: "jpeg", quality: 90 });
  console.log(`  ${g.code}  ${(g.role || "guest").padEnd(14)} ${g.name}` +
    `  (${(fs.statSync(file).size / 1024).toFixed(0)}KB)`);
}
await browser.close();
console.log(`\n${list.length} share card(s) in ${path.relative(ROOT, OUT)}`);
