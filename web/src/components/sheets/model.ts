/**
 * Shared pieces of the Sheets editor: cells as the API returns them
 * (lib/google.ts sheetGrid), A1 references, colours, Google's number format
 * patterns, clipboard TSV, and the batchUpdate requests the editor sends.
 */

export type GColor = { red?: number; green?: number; blue?: number };
export type UF = {
  backgroundColor?: GColor;
  backgroundColorStyle?: { rgbColor?: GColor; themeColor?: string };
  horizontalAlignment?: "LEFT" | "CENTER" | "RIGHT";
  verticalAlignment?: "TOP" | "MIDDLE" | "BOTTOM";
  wrapStrategy?: "OVERFLOW_CELL" | "LEGACY_WRAP" | "CLIP" | "WRAP";
  numberFormat?: { type?: string; pattern?: string };
  textFormat?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    fontFamily?: string;
    fontSize?: number;
    foregroundColor?: GColor;
    foregroundColorStyle?: { rgbColor?: GColor; themeColor?: string };
    link?: { uri?: string };
  };
  borders?: Partial<Record<"top" | "bottom" | "left" | "right", Border>>;
};
export type Border = { style?: string; width?: number; color?: GColor; colorStyle?: { rgbColor?: GColor } };
export type UV = { stringValue?: string; numberValue?: number; boolValue?: boolean; formulaValue?: string; errorValue?: unknown };
export type Cell = { v?: string; uv?: UV; num?: number; bool?: 1; err?: string; uf?: UF; link?: string; note?: string };
export type GridRange = { sheetId: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number };
export type Tab = {
  sheetId: number;
  title: string;
  index: number;
  hidden: boolean;
  color: GColor | null;
  rowCount: number;
  colCount: number;
  frozenRows: number;
  frozenCols: number;
  hideGridlines: boolean;
  merges: GridRange[];
  filter: { range: GridRange; filterSpecs?: unknown[] } | null;
};
/** Inclusive cell range, 0-based. */
export type Range = { r0: number; c0: number; r1: number; c1: number };
export type Op = { t: "values"; data: { range: string; values: string[][] }[] } | { t: "batch"; requests: Record<string, unknown>[] };

export const DEFAULT_ROW = 21;
export const DEFAULT_COL = 100;
export const DEFAULT_FONT = "Arial";
export const DEFAULT_SIZE = 10;

// ── A1 references ──
export function colName(i: number) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export const colIndex = (letters: string) => letters.toUpperCase().split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
export const quoteTab = (tab: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tab) && !/^[A-Za-z]{1,3}\d+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`);
export const a1 = (r: number, c: number) => `${colName(c)}${r + 1}`;
export const norm = (a: { r: number; c: number }, b: { r: number; c: number }): Range => ({ r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) });
export function rangeA1(g: Range, tab?: Tab) {
  const full = tab && g.r0 === 0 && g.r1 >= tab.rowCount - 1;
  const fullCols = tab && g.c0 === 0 && g.c1 >= tab.colCount - 1;
  if (full && !fullCols) return g.c0 === g.c1 ? `${colName(g.c0)}:${colName(g.c0)}` : `${colName(g.c0)}:${colName(g.c1)}`;
  if (fullCols && !full) return `${g.r0 + 1}:${g.r1 + 1}`;
  return g.r0 === g.r1 && g.c0 === g.c1 ? a1(g.r0, g.c0) : `${a1(g.r0, g.c0)}:${a1(g.r1, g.c1)}`;
}
/** "B4", "A1:C9", "C:C", "3:5", optionally "'My tab'!A1". */
export function parseRef(text: string): { tab?: string; range: Range } | null {
  const t = text.trim();
  const bang = t.lastIndexOf("!");
  const tab = bang > 0 ? t.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'") : undefined;
  const ref = (bang > 0 ? t.slice(bang + 1) : t).replace(/\$/g, "").toUpperCase();
  const BIG = 10_000_000;
  let m = ref.match(/^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/);
  if (m) {
    const a = { r: Number(m[2]) - 1, c: colIndex(m[1]) };
    const b = m[3] ? { r: Number(m[4]) - 1, c: colIndex(m[3]) } : a;
    if (a.r < 0 || b.r < 0) return null;
    return { tab, range: norm(a, b) };
  }
  m = ref.match(/^([A-Z]{1,3}):([A-Z]{1,3})$/);
  if (m) return { tab, range: { r0: 0, r1: BIG, c0: Math.min(colIndex(m[1]), colIndex(m[2])), c1: Math.max(colIndex(m[1]), colIndex(m[2])) } };
  m = ref.match(/^(\d+):(\d+)$/);
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return { tab, range: { c0: 0, c1: BIG, r0: Math.min(+m[1], +m[2]) - 1, r1: Math.max(+m[1], +m[2]) - 1 } };
  return null;
}
export const gridRange = (sheetId: number, g: Range): GridRange => ({ sheetId, startRowIndex: g.r0, endRowIndex: g.r1 + 1, startColumnIndex: g.c0, endColumnIndex: g.c1 + 1 });
export const inRange = (g: Range, r: number, c: number) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
export const cellsIn = (g: Range) => (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1);

// ── Colours ──
const hex2 = (n: number | undefined) => Math.round((n ?? 0) * 255).toString(16).padStart(2, "0");
export const toHex = (c: GColor) => `#${hex2(c.red)}${hex2(c.green)}${hex2(c.blue)}`;
export function fromHex(h: string): GColor {
  const m = h.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return {};
  return { red: parseInt(m[1], 16) / 255, green: parseInt(m[2], 16) / 255, blue: parseInt(m[3], 16) / 255 };
}
const THEME: Record<string, string> = { TEXT: "#000000", BACKGROUND: "#ffffff", ACCENT1: "#4285f4", ACCENT2: "#ea4335", ACCENT3: "#fbbc04", ACCENT4: "#34a853", ACCENT5: "#ff6d01", ACCENT6: "#46bdc6", LINK: "#1155cc" };
const pick = (style?: { rgbColor?: GColor; themeColor?: string }, plain?: GColor) => (style?.rgbColor ? toHex(style.rgbColor) : style?.themeColor ? THEME[style.themeColor] : plain ? toHex(plain) : undefined);
export const fillOf = (uf?: UF) => pick(uf?.backgroundColorStyle, uf?.backgroundColor);
export const inkOf = (uf?: UF) => pick(uf?.textFormat?.foregroundColorStyle, uf?.textFormat?.foregroundColor);
export const borderColor = (b: Border) => pick(b.colorStyle, b.color) ?? "#000000";

/** Google Sheets' colour palette (toolbar text and fill colour). */
export const PALETTE = [
  ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff"],
  ["#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff"],
  ["#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc"],
  ["#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4", "#9fc5e8", "#b4a7d6", "#d5a6bd"],
  ["#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0"],
  ["#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#3d85c6", "#674ea7", "#a64d79"],
  ["#85200c", "#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#1155cc", "#0b5394", "#351c75", "#741b47"],
  ["#5b0f00", "#660000", "#783f04", "#7f6000", "#274e13", "#0c343d", "#1c4587", "#073763", "#20124d", "#4c1130"],
];

export const FONTS = ["Arial", "Calibri", "Cambria", "Comic Sans MS", "Courier New", "Georgia", "Impact", "Lato", "Montserrat", "Roboto", "Roboto Mono", "Times New Roman", "Trebuchet MS", "Verdana"];
export const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];

// ── What the formula bar shows: the formula, or the value as it was typed ──
export function inputOf(cell: Cell | null | undefined) {
  const uv = cell?.uv;
  if (!uv) return cell?.v ?? "";
  if (uv.formulaValue !== undefined) return uv.formulaValue;
  if (uv.stringValue !== undefined) return uv.stringValue;
  if (uv.boolValue !== undefined) return uv.boolValue ? "TRUE" : "FALSE";
  if (uv.numberValue !== undefined) {
    const t = cell?.uf?.numberFormat?.type;
    if (t === "DATE" || t === "TIME" || t === "DATE_TIME") return cell?.v ?? String(uv.numberValue);
    if (t === "PERCENT") return `${+(uv.numberValue * 100).toPrecision(15)}%`;
    return String(+uv.numberValue.toPrecision(15));
  }
  return cell?.v ?? "";
}

/** Number format patterns: one more or one fewer decimal place, like Google's toolbar. */
export function changeDecimals(cell: Cell | null | undefined, delta: 1 | -1): { type: string; pattern: string } {
  const nf = cell?.uf?.numberFormat;
  let pattern = nf?.pattern ?? "";
  const type = nf?.type && nf.type !== "TEXT" ? nf.type : "NUMBER";
  if (!pattern) {
    const shown = cell?.v ?? "";
    const dec = shown.match(/\.(\d+)/)?.[1].length ?? 0;
    pattern = `#,##0${dec ? "." + "0".repeat(dec) : ""}`;
    if (type === "PERCENT") pattern += "%";
  }
  // Change every section (positive;negative;zero) the same way.
  const next = pattern
    .split(";")
    .map((sec) => {
      const e = sec.search(/E[+-]/i);
      const head = e >= 0 ? sec.slice(0, e) : sec;
      const tail = e >= 0 ? sec.slice(e) : "";
      // The last digit placeholder and its decimals.
      const m = head.match(/([0#])(\.0*)?(?=[^0#]*$)/);
      if (!m || m.index === undefined) return sec;
      const dec = m[2] ? m[2].length - 1 : 0;
      const n = Math.max(0, Math.min(30, dec + delta));
      return head.slice(0, m.index) + m[1] + (n ? "." + "0".repeat(n) : "") + head.slice(m.index + m[0].length) + tail;
    })
    .join(";");
  return { type, pattern: next };
}

/** "More formats" (Format → Number), as in Google Sheets. */
export const NUMBER_FORMATS: { label: string; sample: string; nf: { type: string; pattern?: string } | null }[] = [
  { label: "Automatic", sample: "", nf: null },
  { label: "Plain text", sample: "", nf: { type: "TEXT", pattern: "@" } },
  { label: "Number", sample: "1,000.12", nf: { type: "NUMBER", pattern: "#,##0.00" } },
  { label: "Percent", sample: "10.12%", nf: { type: "PERCENT", pattern: "0.00%" } },
  { label: "Scientific", sample: "1.01E+03", nf: { type: "SCIENTIFIC", pattern: "0.00E+00" } },
  { label: "Accounting", sample: "$ (1,000.12)", nf: { type: "NUMBER", pattern: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)' } },
  { label: "Financial", sample: "(1,000.12)", nf: { type: "NUMBER", pattern: "#,##0.00;(#,##0.00)" } },
  { label: "Currency", sample: "$1,000.12", nf: { type: "CURRENCY", pattern: '"$"#,##0.00' } },
  { label: "Currency rounded", sample: "$1,000", nf: { type: "CURRENCY", pattern: '"$"#,##0' } },
  { label: "Date", sample: "9/26/2008", nf: { type: "DATE", pattern: "M/d/yyyy" } },
  { label: "Time", sample: "3:59:00 PM", nf: { type: "TIME", pattern: "h:mm:ss am/pm" } },
  { label: "Date time", sample: "9/26/2008 15:59:00", nf: { type: "DATE_TIME", pattern: "M/d/yyyy H:mm:ss" } },
  { label: "Duration", sample: "24:01:00", nf: { type: "TIME", pattern: "[h]:mm:ss" } },
];

/** The locale's currency pattern, for the toolbar's "Format as currency". */
export function currencyPattern(locale: string) {
  const sym: Record<string, string> = { en_IN: "₹", hi_IN: "₹", en_GB: "£", de_DE: "€", fr_FR: "€", es_ES: "€", it_IT: "€", nl_NL: "€", ja_JP: "¥", en_AU: "$", en_CA: "$", en_US: "$" };
  const s = sym[locale] ?? "$";
  return locale === "ja_JP" ? `"${s}"#,##0` : `"${s}"#,##0.00`;
}

// ── Clipboard: tab-separated values, quoted like Google and Excel do ──
export function toTSV(rows: string[][]) {
  return rows.map((r) => r.map((v) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t")).join("\n");
}
export function parseTSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  const s = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"' && cur === "") q = true;
    else if (ch === "\t") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  row.push(cur);
  rows.push(row);
  return rows;
}

/** A request that puts cells back as they were (values, formats and notes), for undo. */
export function restoreCells(sheetId: number, g: Range, get: (r: number, c: number) => Cell | null | undefined) {
  const rows = [];
  for (let r = g.r0; r <= g.r1; r++) {
    const values = [];
    for (let c = g.c0; c <= g.c1; c++) {
      const cell = get(r, c);
      const v: Record<string, unknown> = {};
      if (cell?.uv) v.userEnteredValue = cell.uv;
      if (cell?.uf) v.userEnteredFormat = cell.uf;
      if (cell?.note) v.note = cell.note;
      values.push(v);
    }
    rows.push({ values });
  }
  return { updateCells: { range: gridRange(sheetId, g), rows, fields: "userEnteredValue,userEnteredFormat,note" } };
}

/** Deep-set a dotted path ("textFormat.bold") on a format, for showing a change before Google confirms it. */
export function patchUF(uf: UF | undefined, path: string, value: unknown): UF | undefined {
  const out = structuredClone(uf ?? {}) as Record<string, unknown>;
  const keys = path.split(".");
  let o = out;
  for (const k of keys.slice(0, -1)) o = (o[k] = typeof o[k] === "object" && o[k] ? o[k] : {}) as Record<string, unknown>;
  const last = keys[keys.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return Object.keys(out).length ? (out as UF) : undefined;
}

/** Read a dotted path from a format (for the toolbar's pressed state). */
export function getUF(uf: UF | undefined, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), uf);
}

/** Pixel offsets from sizes: the start of each row or column, plus the total at the end. */
export function offsets(sizes: ArrayLike<number>) {
  const out = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i];
  return out;
}
/** The index whose span contains pixel y (binary search on offsets). */
export function indexAt(off: Float64Array, y: number) {
  let lo = 0;
  let hi = off.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (off[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Numbers in a selection, for the "Sum: …" chip. */
export function stats(nums: number[], filled: number) {
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    Sum: sum,
    Average: nums.length ? sum / nums.length : 0,
    Min: nums.length ? Math.min(...nums) : 0,
    Max: nums.length ? Math.max(...nums) : 0,
    Count: nums.length,
    "Count numbers": nums.length,
    "Count (filled)": filled,
  };
}
export const fmtNum = (n: number) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "");
