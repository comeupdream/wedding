// A very small .xlsx reader — just enough to pull one sheet out of a workbook.
//
// An .xlsx is a ZIP of XML. Rather than take a dependency to read one guest
// list, this walks the archive itself: central directory -> local headers ->
// raw inflate, then reads the shared-string table and the sheet's cells.
// It handles what Excel, Numbers and Sheets actually emit for a plain grid;
// it is not a general-purpose spreadsheet library.
import zlib from "node:zlib";

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);

// --- ZIP ---------------------------------------------------------------------
const entries = (buf) => {
  // The end-of-central-directory record lives in the last 64KB, after a
  // variable-length comment, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error("bad central directory");
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    out.set(buf.toString("utf8", p + 46, p + 46 + nameLen), u32(buf, p + 42));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
};

const read = (buf, offset) => {
  if (u32(buf, offset) !== 0x04034b50) throw new Error("bad local header");
  const method = u16(buf, offset + 8);
  const compressed = u32(buf, offset + 18);
  const uncompressed = u32(buf, offset + 22);
  const start = offset + 30 + u16(buf, offset + 26) + u16(buf, offset + 28);
  const body = buf.subarray(start, start + compressed);
  if (method === 0) return body;
  if (method !== 8) throw new Error(`unsupported compression (${method})`);
  // Data descriptors leave the header sizes at zero; inflate to the end instead.
  return zlib.inflateRawSync(compressed ? body : buf.subarray(start), {
    maxOutputLength: Math.max(uncompressed, 64 * 1024 * 1024),
  });
};

// --- XML ---------------------------------------------------------------------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(n) ? String.fromCodePoint(n) : m;
});

// Shared strings: one <si> per string, but a styled string splits into runs of
// <t>, so take every <t> inside the <si> and join them.
const sharedStrings = (xml) => {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1])).join(""));
};

// "BC12" -> column 54 (zero-based)
const colOf = (ref) => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

const sheetRows = (xml, strings) => {
  const rows = [];
  // A blank row is simply absent from the XML, so trust each row's own r="N"
  // and pad the gaps — otherwise everything below a blank line shifts up.
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const at = Number(/\br="(\d+)"/.exec(rm[1])?.[1] ?? 0) - 1;
    const cells = [];
    // The attribute run must be lazy. Greedy, it eats the "/" of a self-closing
    // empty cell, the "/>" branch then fails, and the ">" branch runs on to the
    // *next* cell's </c> — silently swallowing it and shifting every value left.
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] || "";
      const ref = /r="([A-Z]+)/.exec(attrs);
      const type = /t="([^"]+)"/.exec(attrs);
      const at = ref ? colOf(ref[1]) : cells.length;
      let value = "";
      if (type && type[1] === "inlineStr") {
        value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1])).join("");
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        if (v) {
          value = unescape(v[1]);
          if (type && type[1] === "s") value = strings[Number(value)] ?? "";
        }
      }
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    if (at >= 0) { while (rows.length < at) rows.push([]); rows[at] = cells; }
    else rows.push(cells);
  }
  return rows;
};

// --- public ------------------------------------------------------------------
/** Sheet names, in workbook order. */
export const sheetNames = (buf) => {
  const dir = entries(buf);
  const wb = read(buf, dir.get("xl/workbook.xml")).toString("utf8");
  return [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescape(m[1]));
};

/**
 * Read one sheet as an array of rows of strings.
 * Pass a sheet name, or omit it for the first sheet.
 */
export const readSheet = (buf, wanted) => {
  const dir = entries(buf);
  const wb = read(buf, dir.get("xl/workbook.xml")).toString("utf8");
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: unescape(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? ""),
    rid: /\br:id="([^"]*)"/.exec(m[1])?.[1] ?? "",
  }));
  const sheet = wanted ? sheets.find((s) => s.name === wanted) : sheets[0];
  if (!sheet) throw new Error(`no sheet named "${wanted}"`);

  // r:id -> the part that actually holds the cells
  const rels = read(buf, dir.get("xl/_rels/workbook.xml.rels")).toString("utf8");
  const rel = [...rels.matchAll(/<Relationship\b([^>]*)>/g)]
    .map((m) => ({
      id: /\bId="([^"]*)"/.exec(m[1])?.[1],
      target: /\bTarget="([^"]*)"/.exec(m[1])?.[1],
    }))
    .find((r) => r.id === sheet.rid);
  const target = (rel?.target || "worksheets/sheet1.xml").replace(/^\/?xl\//, "").replace(/^\//, "");
  const path = dir.has("xl/" + target) ? "xl/" + target : target;
  if (!dir.has(path)) throw new Error(`sheet part not found (${path})`);

  const strings = dir.has("xl/sharedStrings.xml")
    ? sharedStrings(read(buf, dir.get("xl/sharedStrings.xml")).toString("utf8"))
    : [];
  return sheetRows(read(buf, dir.get(path)).toString("utf8"), strings);
};
