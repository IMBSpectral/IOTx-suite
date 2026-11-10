/**
 * Excel workbooks (.xlsx / .xlsm) read for the AI.
 *
 * - Cells come out as people see them: shared and inline strings, numbers, TRUE/FALSE,
 *   and dates as dates. Excel stores a date as a day number (45962 = 2025-10-01), so a
 *   cell whose style is a date format is converted, including the 1904 date system.
 * - Big workbooks don't fit in one message. The AI gets an overview of every sheet (size,
 *   column headings, first rows) and reads the rows it needs with read_spreadsheet.
 */
import JSZip from "jszip";

export type Sheet = { name: string; hidden: boolean; rows: string[][] };
export type Workbook = { sheets: Sheet[] };

const xmlText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Built-in number formats that are dates or times (ECMA-376 18.8.30, plus common locale ids).
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** A custom format code that shows a date or time (ignoring quoted text, [colours] and escapes). */
function isDateCode(code: string) {
  const c = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "").toLowerCase();
  if (/^(general|@|[#0.,%e+\-\s]*)$/.test(c)) return false;
  return /[dy]/.test(c) || /h.*[ms]|[ms].*h/.test(c);
}

function serialToText(v: number, date1904: boolean) {
  // Excel's dates run from day 0 to 2958465 (31 Dec 9999); anything else in a date-styled
  // cell is just a number (or an error), so show it as one.
  if (!Number.isFinite(v) || v < 0 || v > 2958465) return String(v);
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(v * 86400000);
  const d = new Date(base + ms);
  const day = d.toISOString().slice(0, 10);
  const frac = v - Math.floor(v);
  const time = d.toISOString().slice(11, 16);
  if (Math.floor(v) === 0 && frac > 0) return time;
  return frac > 1e-6 ? `${day} ${time}` : day;
}

const colIndex = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** Every sheet's rows (as strings), in workbook order. maxRows caps rows per sheet. */
export async function readWorkbook(bytes: Buffer, maxRows = Infinity): Promise<Workbook> {
  const zip = await JSZip.loadAsync(bytes);
  const shared = [...((await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    xmlText([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const book = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const date1904 = /date1904="(1|true)"/.test(book);
  const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const target = (rid: string) => new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);

  // Which cell styles are dates: styles.xml cellXfs in order -> numFmtId -> date or not.
  const styles = (await zip.file("xl/styles.xml")?.async("string")) ?? "";
  const custom = new Map([...styles.matchAll(/<numFmt [^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), xmlText(m[2])]));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const dateStyle = [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].map((m) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
    return BUILTIN_DATE.has(id) || (custom.has(id) && isDateCode(custom.get(id)!));
  });

  const sheets: Sheet[] = [];
  for (const m of book.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const name = xmlText(/name="([^"]*)"/.exec(attrs)?.[1] ?? "Sheet");
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const hidden = /state="(hidden|veryHidden)"/.test(attrs);
    const t = target(rid);
    const file = (t?.[1] ?? t?.[2] ?? "").replace(/^\/?(xl\/)?/, "xl/");
    const xml = await zip.file(file)?.async("string");
    if (!xml) continue;
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const kind = /\bt="(\w+)"/.exec(c[2])?.[1];
        const style = Number(/\bs="(\d+)"/.exec(c[2])?.[1] ?? -1);
        const v = /<v>([^<]*)<\/v>/.exec(c[3] ?? "")?.[1] ?? "";
        let val: string;
        if (kind === "s") val = shared[Number(v)] ?? "";
        else if (kind === "inlineStr") val = xmlText([...(c[3] ?? "").matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(""));
        else if (kind === "b") val = v === "1" ? "TRUE" : v === "0" ? "FALSE" : v;
        else if (kind === "str" || kind === "e") val = xmlText(v);
        else if (v !== "" && style >= 0 && dateStyle[style]) val = serialToText(Number(v), date1904);
        else val = xmlText(v);
        cells[colIndex(c[1])] = val.replace(/\s+/g, " ").trim();
      }
      if (cells.some(Boolean)) rows.push(Array.from(cells, (x) => x ?? ""));
      if (rows.length >= maxRows) break;
    }
    sheets.push({ name, hidden, rows });
  }
  return { sheets };
}

/** Every sheet as tab-separated rows (the old plain form, for search and the knowledge base). */
export function workbookText(wb: Workbook) {
  return wb.sheets
    .filter((s) => s.rows.length)
    .map((s) => `## Sheet: ${s.name}\n${s.rows.map((r) => r.join("\t")).join("\n")}`)
    .join("\n\n");
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The row most likely to be the column headings: among the first rows, the one with the most text cells. */
export function headerRow(rows: string[][]) {
  let best = 0;
  let score = -1;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const s = rows[i].filter((c) => c && Number.isNaN(Number(c))).length;
    if (s > score + 1) {
      best = i;
      score = s;
    }
  }
  return best;
}

/**
 * What the AI gets for a workbook too big to send whole: each sheet's size, its column
 * headings and its first rows, within `budget` characters.
 */
export function workbookOverview(wb: Workbook, budget = 20000) {
  const visible = wb.sheets.filter((s) => s.rows.length);
  const per = Math.max(400, Math.floor(budget / Math.max(1, visible.length)));
  const parts: string[] = [];
  for (const [i, s] of wb.sheets.entries()) {
    const cols = Math.max(0, ...s.rows.map((r) => r.length));
    const head = `### Sheet ${i + 1}: ${s.name}${s.hidden ? " (hidden)" : ""}: ${s.rows.length} rows × ${cols} columns`;
    if (!s.rows.length) {
      parts.push(`${head} (empty)`);
      continue;
    }
    const h = headerRow(s.rows);
    const lines = [head];
    if (h > 0) lines.push(`Title rows: ${s.rows.slice(0, h).map((r) => clip(r.filter(Boolean).join(" | "), 120)).join(" / ")}`);
    lines.push(`Row ${h + 1} (headings): ${s.rows[h].map((c, j) => `${j + 1}=${clip(c || "-", 30)}`).join("\t")}`);
    let used = lines.join("\n").length;
    for (let r = h + 1; r < s.rows.length && r <= h + 5; r++) {
      const line = `Row ${r + 1}: ${s.rows[r].map((c) => clip(c, 30)).join("\t")}`;
      if (used + line.length > per) break;
      lines.push(line);
      used += line.length;
    }
    if (s.rows.length > h + 6) lines.push(`… ${s.rows.length - h - 6} more rows`);
    parts.push(clip(lines.join("\n"), per));
  }
  return parts.join("\n\n");
}

/** The sheet named (or numbered from 1) by `which`, case and space insensitive. */
export function findSheet(wb: Workbook, which: string | number) {
  const n = typeof which === "number" ? which : /^\d+$/.test(which.trim()) ? Number(which) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= wb.sheets.length && !wb.sheets.some((s) => s.name === String(which))) return wb.sheets[n - 1];
  const key = String(which).replace(/\s+/g, " ").trim().toLowerCase();
  return wb.sheets.find((s) => s.name.replace(/\s+/g, " ").trim().toLowerCase() === key) ?? null;
}

/**
 * Rows of one sheet for the AI: numbered like Excel, with the heading row first, from
 * `from` to `to` (1-based, inclusive) or only rows containing `contains`, within limits.
 */
export function sheetRows(sheet: Sheet, o: { from?: number; to?: number; contains?: string; maxRows?: number; maxChars?: number } = {}) {
  const maxRows = Math.min(o.maxRows ?? 300, 500);
  const maxChars = o.maxChars ?? 40000;
  const h = headerRow(sheet.rows);
  const want = o.contains?.toLowerCase().trim();
  const start = Math.max(1, o.from ?? 1);
  const end = Math.min(sheet.rows.length, o.to ?? sheet.rows.length);
  const out = [`Sheet "${sheet.name}": ${sheet.rows.length} rows. Headings (row ${h + 1}): ${sheet.rows[h]?.join("\t") ?? ""}`];
  let chars = out[0].length;
  let n = 0;
  let last = start - 1;
  for (let r = start; r <= end; r++) {
    const row = sheet.rows[r - 1];
    if (!row || r - 1 === h) continue;
    if (want && !row.some((c) => c.toLowerCase().includes(want))) continue;
    const line = `Row ${r}: ${row.join("\t")}`;
    if (n >= maxRows || chars + line.length > maxChars) {
      out.push(`… stopped at row ${last} to stay within one reply. Call again with from_row=${last + 1} for more.`);
      return out.join("\n");
    }
    out.push(line);
    chars += line.length;
    n++;
    last = r;
  }
  if (!n) out.push(want ? `No rows in ${start}–${end} contain "${o.contains}".` : `No rows in ${start}–${end}.`);
  return out.join("\n");
}
