/**
 * An in-memory Google Drive + Sheets API for tests and local demos. The web
 * server sends every Google call here when started with
 *   FORGE_GOOGLE_TOKEN_URL=http://127.0.0.1:4799/token FORGE_GOOGLE_API=http://127.0.0.1:4799
 * It covers what the Sheets editor uses: Drive files (list, get, create,
 * copy, rename, star, trash, viewedByMeTime), spreadsheets.get (layout, and
 * includeGridData for a range), values get / update / append / batchUpdate
 * (USER_ENTERED, with a small formula engine: + - * / ^, SUM, AVERAGE, COUNT,
 * MIN, MAX, and cell and range references), and the spreadsheets.batchUpdate
 * requests the editor sends. Field masks on reads are ignored (it returns more).
 * Google Docs and Slides (google-docs-mock.ts, google-slides-mock.ts) are
 * served by the same mock: documents and presentations get/batchUpdate,
 * pages.getThumbnail, Drive export, image upload, permissions and comments.
 */
import http from "node:http";
import { DocsError, MockDoc, mockSvg } from "./google-docs-mock";
import { MockDeck, SlidesError } from "./google-slides-mock";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type MCell = { userEnteredValue?: Json; userEnteredFormat?: Json; note?: string };
export type MSheet = {
  properties: { sheetId: number; title: string; index: number; hidden?: boolean; tabColorStyle?: Json; tabColor?: Json; gridProperties: { rowCount: number; columnCount: number; frozenRowCount?: number; frozenColumnCount?: number; hideGridlines?: boolean } };
  cells: (MCell | undefined)[][];
  rowPx: Map<number, number>;
  colPx: Map<number, number>;
  merges: Json[];
  basicFilter?: Json;
};
export type MBook = { id: string; title: string; locale: string; sheets: MSheet[] };
export type MFile = { id: string; name: string; mimeType: string; trashed?: boolean; starred?: boolean; viewedByMeTime?: string; modifiedTime: string; ownedByMe?: boolean; owner?: string; canEdit?: boolean; comments?: Json[] };
export const DOC_MIME = "application/vnd.google-apps.document";
export const SLIDES_MIME = "application/vnd.google-apps.presentation";

export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const colIndex = (l: string) => l.toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function newSheet(sheetId: number, title: string, index: number, rows = 1000, cols = 26): MSheet {
  return { properties: { sheetId, title, index, gridProperties: { rowCount: rows, columnCount: cols } }, cells: [], rowPx: new Map(), colPx: new Map(), merges: [] };
}

// ── Values as typed (USER_ENTERED) ──
export function parseTyped(s: string): { uv?: Json; nf?: Json } {
  const t = s.trim();
  if (s === "") return {};
  if (t.startsWith("=")) return { uv: { formulaValue: t } };
  if (/^(true|false)$/i.test(t)) return { uv: { boolValue: /^true$/i.test(t) } };
  const n = t.replace(/,/g, "");
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(n)) return { uv: { numberValue: Number(n) } };
  if (/^[-+]?(\d+\.?\d*|\.\d+)%$/.test(n)) return { uv: { numberValue: Number(n.slice(0, -1)) / 100 }, nf: { type: "PERCENT", pattern: "0.00%" } };
  if (/^-?\$(\d+\.?\d*|\.\d+)$/.test(n)) return { uv: { numberValue: Number(n.replace("$", "")) }, nf: { type: "CURRENCY", pattern: '"$"#,##0.00' } };
  return { uv: { stringValue: s } };
}

// ── Formulas ──
type V = number | string | boolean | V[] | { err: string };
const isErr = (v: unknown): v is { err: string } => !!v && typeof v === "object" && !Array.isArray(v) && "err" in (v as object);

export function shiftFormula(f: string, dr: number, dc: number) {
  return f
    .split(/("[^"]*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(^|[^A-Za-z0-9_.'])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z])/g, (_m, pre, d1, col, d2, row) => {
            const c = d1 ? colIndex(col) : colIndex(col) + dc;
            const r = d2 ? Number(row) : Number(row) + dr;
            return c < 0 || r < 1 ? `${pre}#REF!` : `${pre}${d1}${colName(c)}${d2}${r}`;
          }),
    )
    .join("");
}

export class MockBook {
  constructor(public book: MBook) {}
  sheet(idOrTitle: number | string) {
    return this.book.sheets.find((s) => (typeof idOrTitle === "number" ? s.properties.sheetId === idOrTitle : s.properties.title.toLowerCase() === idOrTitle.toLowerCase()));
  }
  get(sh: MSheet, r: number, c: number) {
    return sh.cells[r]?.[c];
  }
  put(sh: MSheet, r: number, c: number, cell: MCell | undefined) {
    (sh.cells[r] ??= [])[c] = cell && (cell.userEnteredValue || cell.userEnteredFormat || cell.note) ? cell : undefined;
  }
  /** The computed value of a cell. */
  value(sh: MSheet, r: number, c: number, depth = 0): V {
    const uv = this.get(sh, r, c)?.userEnteredValue;
    if (!uv) return "";
    if (uv.formulaValue !== undefined) return depth > 50 ? { err: "#REF!" } : this.evaluate(sh, uv.formulaValue.slice(1), depth + 1);
    if (uv.numberValue !== undefined) return uv.numberValue;
    if (uv.boolValue !== undefined) return uv.boolValue;
    return uv.stringValue ?? "";
  }
  evaluate(sh: MSheet, src: string, depth: number): V {
    const toks = src.match(/"[^"]*"|'[^']+'![A-Z$]+\d+(?::[A-Z$]+\d+)?|[A-Za-z_][A-Za-z0-9_]*![A-Z$]+\d+(?::[A-Z$]+\d+)?|\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\d+\.?\d*(?:e[-+]?\d+)?|[A-Za-z_][A-Za-z0-9_.]*|<=|>=|<>|[-+*/^(),:&=<>]/gi) ?? [];
    let i = 0;
    const peek = () => toks[i];
    const num = (v: V): number | { err: string } => (isErr(v) ? v : typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : v === "" ? 0 : Number.isFinite(Number(v)) ? Number(v) : { err: "#VALUE!" });
    const ref = (t: string): V => {
      const bang = t.lastIndexOf("!");
      const target = bang > 0 ? this.sheet(t.slice(0, bang).replace(/^'|'$/g, "")) : sh;
      if (!target) return { err: "#REF!" };
      const [a, b] = t.slice(bang + 1).replace(/\$/g, "").split(":");
      const pa = a.match(/([A-Z]+)(\d+)/i)!;
      if (!b) return this.value(target, Number(pa[2]) - 1, colIndex(pa[1]), depth);
      const pb = b.match(/([A-Z]+)(\d+)/i)!;
      const out: V[] = [];
      for (let r = Math.min(+pa[2], +pb[2]) - 1; r < Math.max(+pa[2], +pb[2]); r++)
        for (let c = Math.min(colIndex(pa[1]), colIndex(pb[1])); c <= Math.max(colIndex(pa[1]), colIndex(pb[1])); c++) out.push(this.value(target, r, c, depth));
      return out;
    };
    const flat = (vs: V[]): V[] => vs.flatMap((v) => (Array.isArray(v) ? flat(v) : [v]));
    const fns: Record<string, (args: V[]) => V> = {
      SUM: (a) => flat(a).filter((v) => typeof v === "number").reduce((s: number, v) => s + (v as number), 0),
      AVERAGE: (a) => {
        const n = flat(a).filter((v) => typeof v === "number") as number[];
        return n.length ? n.reduce((s, v) => s + v, 0) / n.length : { err: "#DIV/0!" };
      },
      COUNT: (a) => flat(a).filter((v) => typeof v === "number").length,
      COUNTA: (a) => flat(a).filter((v) => v !== "").length,
      MIN: (a) => Math.min(...(flat(a).filter((v) => typeof v === "number") as number[]).concat(flat(a).some((v) => typeof v === "number") ? [] : [0])),
      MAX: (a) => Math.max(...(flat(a).filter((v) => typeof v === "number") as number[]).concat(flat(a).some((v) => typeof v === "number") ? [] : [0])),
      CONCATENATE: (a) => flat(a).join(""),
      UPPER: (a) => String(a[0]).toUpperCase(),
      IF: (a) => (a[0] && a[0] !== "FALSE" ? a[1] : (a[2] ?? false)),
    };
    const primary = (): V => {
      const t = toks[i++];
      if (t === undefined) return { err: "#ERROR!" };
      if (t === "(") {
        const v = expr();
        i++;
        return v;
      }
      if (t === "-") {
        const v = num(primary());
        return isErr(v) ? v : -v;
      }
      if (t === "+") return primary();
      if (t.startsWith('"')) return t.slice(1, -1);
      if (/^\d/.test(t)) return Number(t);
      if (/^(TRUE|FALSE)$/i.test(t)) return /^TRUE$/i.test(t);
      if (peek() === "(") {
        i++;
        const args: V[] = [];
        while (peek() !== ")" && peek() !== undefined) {
          args.push(expr());
          if (peek() === ",") i++;
        }
        i++;
        const f = fns[t.toUpperCase()];
        if (!f) return { err: "#NAME?" };
        const bad = flat(args).find(isErr);
        return bad ?? f(args);
      }
      if (/[A-Z]+\$?\d+/i.test(t)) return ref(t);
      return { err: "#NAME?" };
    };
    const pow = (): V => {
      let v = primary();
      while (peek() === "^") {
        i++;
        const a = num(v);
        const b = num(primary());
        v = isErr(a) ? a : isErr(b) ? b : a ** b;
      }
      return v;
    };
    const term = (): V => {
      let v = pow();
      while (peek() === "*" || peek() === "/") {
        const op = toks[i++];
        const a = num(v);
        const b = num(pow());
        v = isErr(a) ? a : isErr(b) ? b : op === "*" ? a * b : b === 0 ? { err: "#DIV/0!" } : a / b;
      }
      return v;
    };
    const sum = (): V => {
      let v = term();
      while (peek() === "+" || peek() === "-") {
        const op = toks[i++];
        const a = num(v);
        const b = num(term());
        v = isErr(a) ? a : isErr(b) ? b : op === "+" ? a + b : a - b;
      }
      return v;
    };
    const concat = (): V => {
      let v = sum();
      while (peek() === "&") {
        i++;
        v = `${v}${sum()}`;
      }
      return v;
    };
    const expr = (): V => {
      const v = concat();
      const op = peek();
      if (op && ["=", "<", ">", "<=", ">=", "<>"].includes(op)) {
        i++;
        const b = concat();
        const [x, y] = [v, b].map((z) => (typeof z === "number" ? z : String(z))) as [number | string, number | string];
        return op === "=" ? x === y : op === "<>" ? x !== y : op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
      }
      return v;
    };
    try {
      const v = expr();
      return Array.isArray(v) ? (v[0] ?? "") : v;
    } catch {
      return { err: "#ERROR!" };
    }
  }
  /** What Google shows in the cell. */
  formatted(sh: MSheet, r: number, c: number): { text: string; v: V } {
    const v = this.value(sh, r, c);
    if (isErr(v)) return { text: v.err, v };
    if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE", v };
    if (typeof v !== "number") return { text: String(v), v };
    const nf = this.get(sh, r, c)?.userEnteredFormat?.numberFormat;
    const pat: string = nf?.pattern ?? "";
    const decimals = pat.match(/\.(0+)/)?.[1].length ?? 0;
    const grouped = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: pat.includes(",") });
    if (nf?.type === "PERCENT") return { text: `${(v * 100).toFixed(decimals)}%`, v };
    if (nf?.type === "CURRENCY") return { text: `${v < 0 ? "-" : ""}${pat.match(/"([^"]+)"/)?.[1] ?? "$"}${grouped(Math.abs(v))}`, v };
    if (pat && /[0#]/.test(pat) && nf?.type !== "DATE") return { text: grouped(v), v };
    return { text: String(+v.toPrecision(15)), v };
  }

  // ── Writes ──
  writeTyped(sh: MSheet, r: number, c: number, s: string) {
    const { uv, nf } = parseTyped(s);
    const cur = { ...(this.get(sh, r, c) ?? {}) };
    if (uv) cur.userEnteredValue = uv;
    else delete cur.userEnteredValue;
    if (nf && !cur.userEnteredFormat?.numberFormat) cur.userEnteredFormat = { ...cur.userEnteredFormat, numberFormat: nf };
    this.grow(sh, r + 1, c + 1);
    this.put(sh, r, c, cur);
  }
  grow(sh: MSheet, rows: number, cols: number) {
    const g = sh.properties.gridProperties;
    if (rows > g.rowCount) g.rowCount = rows;
    if (cols > g.columnCount) g.columnCount = cols;
  }
  /** "'Tab'!B2:C4" → sheet and box (end inclusive; open ends run to the grid edge). */
  range(a1: string) {
    const bang = a1.lastIndexOf("!");
    const whole = bang < 0 ? this.sheet(a1.replace(/^'|'$/g, "").replace(/''/g, "'")) : undefined;
    const sh = bang > 0 ? this.sheet(a1.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'")) : (whole ?? this.book.sheets[0]);
    if (!sh) throw new Error(`Unable to parse range: ${a1}`);
    const ref = (bang > 0 ? a1.slice(bang + 1) : whole ? "" : a1).replace(/\$/g, "");
    const g = sh.properties.gridProperties;
    if (!ref) return { sh, r0: 0, c0: 0, r1: g.rowCount - 1, c1: g.columnCount - 1 };
    const [a, b] = ref.split(":");
    const pa = a.match(/^([A-Z]*)(\d*)$/i)!;
    const pb = (b ?? a).match(/^([A-Z]*)(\d*)$/i)!;
    return {
      sh,
      r0: pa[2] ? +pa[2] - 1 : 0,
      c0: pa[1] ? colIndex(pa[1]) : 0,
      r1: pb[2] ? +pb[2] - 1 : g.rowCount - 1,
      c1: pb[1] ? colIndex(pb[1]) : g.columnCount - 1,
    };
  }
  box(gr: Json) {
    const sh = this.sheet(gr.sheetId ?? 0)!;
    if (!sh) throw new Error(`No sheet with id ${gr.sheetId}`);
    const g = sh.properties.gridProperties;
    return { sh, r0: gr.startRowIndex ?? 0, r1: (gr.endRowIndex ?? g.rowCount) - 1, c0: gr.startColumnIndex ?? 0, c1: (gr.endColumnIndex ?? g.columnCount) - 1 };
  }

  /** One spreadsheets.batchUpdate request. Returns its reply. */
  apply(req: Json): Json {
    const [kind, b] = Object.entries(req)[0] as [string, Json];
    const mask = (target: Json, source: Json, fields: string) => {
      for (const path of fields.split(",").map((f) => f.trim()).filter(Boolean)) {
        const keys = path.split(".");
        let s = source;
        for (const k of keys) s = s?.[k];
        let t = target;
        for (const k of keys.slice(0, -1)) t = t[k] = t[k] && typeof t[k] === "object" ? { ...t[k] } : {};
        if (s === undefined) delete t[keys[keys.length - 1]];
        else t[keys[keys.length - 1]] = structuredClone(s);
      }
      // Drop empty objects left behind.
      const prune = (o: Json) => {
        for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) {
          prune(o[k]);
          if (!Object.keys(o[k]).length) delete o[k];
        }
      };
      prune(target);
    };
    switch (kind) {
      case "repeatCell": {
        const { sh, r0, r1, c0, c1 } = this.box(b.range);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const cell = structuredClone(this.get(sh, r, c) ?? {});
          mask(cell, b.cell ?? {}, b.fields);
          this.put(sh, r, c, cell);
        }
        return {};
      }
      case "updateCells": {
        const { sh, r0, r1, c0, c1 } = b.range ? this.box(b.range) : { sh: this.sheet(b.start.sheetId)!, r0: b.start.rowIndex ?? 0, c0: b.start.columnIndex ?? 0, r1: (b.start.rowIndex ?? 0) + (b.rows?.length ?? 1) - 1, c1: (b.start.columnIndex ?? 0) + Math.max(1, ...(b.rows ?? []).map((x: Json) => x.values?.length ?? 0)) - 1 };
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const cell = structuredClone(this.get(sh, r, c) ?? {});
          mask(cell, b.rows?.[r - r0]?.values?.[c - c0] ?? {}, b.fields);
          this.put(sh, r, c, cell);
        }
        return {};
      }
      case "updateBorders": {
        const { sh, r0, r1, c0, c1 } = this.box(b.range);
        const set = (r: number, c: number, side: string, v: Json) => {
          const cell = structuredClone(this.get(sh, r, c) ?? {});
          const f = (cell.userEnteredFormat ??= {});
          f.borders ??= {};
          if (v.style === "NONE") delete f.borders[side];
          else f.borders[side] = v;
          if (!Object.keys(f.borders).length) delete f.borders;
          if (!Object.keys(f).length) delete cell.userEnteredFormat;
          this.put(sh, r, c, cell);
        };
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          if (b.top && r === r0) set(r, c, "top", b.top);
          if (b.bottom && r === r1) set(r, c, "bottom", b.bottom);
          if (b.left && c === c0) set(r, c, "left", b.left);
          if (b.right && c === c1) set(r, c, "right", b.right);
          if (b.innerHorizontal && r < r1) set(r, c, "bottom", b.innerHorizontal);
          if (b.innerVertical && c < c1) set(r, c, "right", b.innerVertical);
        }
        return {};
      }
      case "mergeCells": {
        const { sh, r0, r1, c0, c1 } = this.box(b.range);
        const parts = b.mergeType === "MERGE_COLUMNS" ? Array.from({ length: c1 - c0 + 1 }, (_, i) => [r0, r1, c0 + i, c0 + i]) : b.mergeType === "MERGE_ROWS" ? Array.from({ length: r1 - r0 + 1 }, (_, i) => [r0 + i, r0 + i, c0, c1]) : [[r0, r1, c0, c1]];
        for (const [a, z, x, y] of parts) {
          if (sh.merges.some((m) => m.startRowIndex <= z && m.endRowIndex > a && m.startColumnIndex <= y && m.endColumnIndex > x)) throw new Error("You can't merge cells that overlap an existing merge.");
          sh.merges.push({ sheetId: sh.properties.sheetId, startRowIndex: a, endRowIndex: z + 1, startColumnIndex: x, endColumnIndex: y + 1 });
          for (let r = a; r <= z; r++) for (let c = x; c <= y; c++) if (r !== a || c !== x) {
            const cell = this.get(sh, r, c);
            if (cell) this.put(sh, r, c, { ...cell, userEnteredValue: undefined });
          }
        }
        return {};
      }
      case "unmergeCells": {
        const { sh, r0, r1, c0, c1 } = this.box(b.range);
        sh.merges = sh.merges.filter((m) => !(m.startRowIndex <= r1 && m.endRowIndex > r0 && m.startColumnIndex <= c1 && m.endColumnIndex > c0));
        return {};
      }
      case "insertDimension":
      case "deleteDimension": {
        const { sheetId, dimension, startIndex: s, endIndex: e } = b.range;
        const sh = this.sheet(sheetId)!;
        const n = e - s;
        const g = sh.properties.gridProperties;
        const ins = kind === "insertDimension";
        const shiftMap = (m: Map<number, number>) => {
          const out = new Map<number, number>();
          for (const [k, v] of m) {
            if (k < s) out.set(k, v);
            else if (ins) out.set(k + n, v);
            else if (k >= e) out.set(k - n, v);
          }
          return out;
        };
        const fix = (m: Json, a: string, z: string) => {
          if (ins) {
            if (m[a] >= s) {
              m[a] += n;
              m[z] += n;
            }
            else if (m[z] > s) m[z] += n;
          } else {
            if (m[a] >= e) {
              m[a] -= n;
              m[z] -= n;
            }
            else if (m[z] > s) m[z] = Math.max(m[a], m[z] - Math.min(n, m[z] - s));
          }
          return m[z] > m[a];
        };
        if (dimension === "ROWS") {
          if (ins) sh.cells.splice(s, 0, ...Array.from({ length: n }, () => [] as (MCell | undefined)[]));
          else sh.cells.splice(s, n);
          g.rowCount += ins ? n : -n;
          sh.rowPx = shiftMap(sh.rowPx);
          sh.merges = sh.merges.filter((m) => fix(m, "startRowIndex", "endRowIndex"));
        } else {
          for (const row of sh.cells) if (row) {
            if (ins) row.splice(s, 0, ...Array.from({ length: n }, () => undefined));
            else row.splice(s, n);
          }
          g.columnCount += ins ? n : -n;
          sh.colPx = shiftMap(sh.colPx);
          sh.merges = sh.merges.filter((m) => fix(m, "startColumnIndex", "endColumnIndex"));
        }
        if (g.rowCount < 1 || g.columnCount < 1) throw new Error("You can't delete all the rows or columns on a sheet.");
        return {};
      }
      case "appendDimension": {
        const sh = this.sheet(b.sheetId)!;
        if (b.dimension === "ROWS") sh.properties.gridProperties.rowCount += b.length;
        else sh.properties.gridProperties.columnCount += b.length;
        return {};
      }
      case "updateDimensionProperties": {
        const { sheetId, dimension, startIndex: s, endIndex: e } = b.range;
        const sh = this.sheet(sheetId)!;
        for (let i = s; i < e; i++) (dimension === "ROWS" ? sh.rowPx : sh.colPx).set(i, b.properties.pixelSize);
        return {};
      }
      case "autoResizeDimensions": {
        const { sheetId, dimension, startIndex: s, endIndex: e } = b.dimensions;
        const sh = this.sheet(sheetId)!;
        for (let i = s; i < e; i++) {
          if (dimension === "ROWS") sh.rowPx.delete(i);
          else {
            let w = 0;
            for (let r = 0; r < sh.cells.length; r++) w = Math.max(w, this.formatted(sh, r, i).text.length);
            sh.colPx.set(i, Math.max(30, w * 7 + 12));
          }
        }
        return {};
      }
      case "updateSheetProperties": {
        const sh = this.sheet(b.properties.sheetId)!;
        const fields = String(b.fields);
        if (/\bindex\b/.test(fields)) {
          // Google counts the new index before the move.
          const list = [...this.book.sheets].sort((x, y) => x.properties.index - y.properties.index);
          const from = list.indexOf(sh);
          let to = b.properties.index;
          if (to > from) to -= 1;
          list.splice(from, 1);
          list.splice(Math.max(0, Math.min(list.length, to)), 0, sh);
          list.forEach((s, i) => (s.properties.index = i));
        }
        const rest = fields.split(",").filter((f) => f.trim() !== "index").join(",");
        if (rest.includes("title") && this.book.sheets.some((s) => s !== sh && s.properties.title.toLowerCase() === String(b.properties.title).toLowerCase())) throw new Error(`A sheet with the name "${b.properties.title}" already exists.`);
        if (rest) mask(sh.properties, b.properties, rest);
        sh.properties.gridProperties ??= { rowCount: 1000, columnCount: 26 };
        return {};
      }
      case "addSheet": {
        const p = b.properties ?? {};
        const id = p.sheetId ?? Math.floor(Math.random() * 1e9);
        let title = p.title;
        for (let n = this.book.sheets.length + 1; !title || this.sheet(title); n++) title = `Sheet${n}`;
        if (p.title && this.book.sheets.some((s) => s.properties.title.toLowerCase() === p.title.toLowerCase())) throw new Error(`A sheet with the name "${p.title}" already exists.`);
        const sh = newSheet(id, title, p.index ?? this.book.sheets.length);
        for (const s of this.book.sheets) if (s.properties.index >= sh.properties.index) s.properties.index++;
        this.book.sheets.push(sh);
        return { addSheet: { properties: sh.properties } };
      }
      case "deleteSheet": {
        const sh = this.sheet(b.sheetId);
        if (!sh) throw new Error(`No grid with id: ${b.sheetId}`);
        if (this.book.sheets.length === 1) throw new Error("You can't remove all the sheets in a document.");
        this.book.sheets = this.book.sheets.filter((s) => s !== sh);
        this.book.sheets.sort((x, y) => x.properties.index - y.properties.index).forEach((s, i) => (s.properties.index = i));
        return {};
      }
      case "duplicateSheet": {
        const src = this.sheet(b.sourceSheetId)!;
        const sh: MSheet = { ...structuredClone({ ...src, rowPx: undefined, colPx: undefined }), rowPx: new Map(src.rowPx), colPx: new Map(src.colPx) } as MSheet;
        sh.properties.sheetId = b.newSheetId ?? Math.floor(Math.random() * 1e9);
        sh.properties.title = b.newSheetName ?? `Copy of ${src.properties.title}`;
        sh.properties.index = b.insertSheetIndex ?? this.book.sheets.length;
        sh.merges = sh.merges.map((m) => ({ ...m, sheetId: sh.properties.sheetId }));
        for (const s of this.book.sheets) if (s.properties.index >= sh.properties.index) s.properties.index++;
        this.book.sheets.push(sh);
        return { duplicateSheet: { properties: sh.properties } };
      }
      case "sortRange": {
        const { sh, r0, r1, c0, c1 } = this.box(b.range);
        const rows = [];
        for (let r = r0; r <= r1; r++) rows.push({ from: r, cells: Array.from({ length: c1 - c0 + 1 }, (_, i) => this.get(sh, r, c0 + i)), key: b.sortSpecs.map((s: Json) => this.value(sh, r, s.dimensionIndex)) });
        rows.sort((x, y) => {
          for (let k = 0; k < b.sortSpecs.length; k++) {
            const a = x.key[k];
            const z = y.key[k];
            if (a === "" && z === "") continue;
            if (a === "") return 1;
            if (z === "") return -1;
            const d = typeof a === "number" && typeof z === "number" ? a - z : typeof a === "number" ? -1 : typeof z === "number" ? 1 : String(a).localeCompare(String(z));
            if (d) return b.sortSpecs[k].sortOrder === "DESCENDING" ? -d : d;
          }
          return 0;
        });
        // Like Google, relative references move with their row.
        rows.forEach((row, i) =>
          row.cells.forEach((cell, j) => {
            const f = cell?.userEnteredValue?.formulaValue;
            this.put(sh, r0 + i, c0 + j, f ? { ...cell, userEnteredValue: { formulaValue: shiftFormula(f, r0 + i - row.from, 0) } } : cell);
          }),
        );
        return {};
      }
      case "setBasicFilter": {
        const sh = this.sheet(b.filter.range.sheetId ?? 0)!;
        sh.basicFilter = structuredClone(b.filter);
        return {};
      }
      case "clearBasicFilter": {
        delete this.sheet(b.sheetId)!.basicFilter;
        return {};
      }
      case "autoFill": {
        const sd = b.sourceAndDestination;
        const { sh, r0, r1, c0, c1 } = this.box(sd.source);
        const rowsDim = sd.dimension === "ROWS";
        const len = sd.fillLength;
        const lanes = rowsDim ? c1 - c0 + 1 : r1 - r0 + 1;
        const size = rowsDim ? r1 - r0 + 1 : c1 - c0 + 1;
        for (let lane = 0; lane < lanes; lane++) {
          const at = (k: number) => (rowsDim ? [r0 + k, c0 + lane] : [r0 + lane, c0 + k]) as [number, number];
          const src = Array.from({ length: size }, (_, k) => this.get(sh, ...at(k)));
          const nums = src.map((x) => x?.userEnteredValue?.numberValue);
          const series = size >= 2 && nums.every((n) => typeof n === "number");
          const step = series ? (nums[size - 1]! - nums[0]!) / (size - 1) : 0;
          for (let k = 1; k <= Math.abs(len); k++) {
            const idx = len > 0 ? size - 1 + k : -k;
            const from = len > 0 ? (k - 1) % size : (size - (k % size)) % size;
            const base = src[from];
            const [r, c] = at(idx);
            const cell: MCell = structuredClone(base ?? {});
            if (series) cell.userEnteredValue = { numberValue: len > 0 ? nums[size - 1]! + step * k : nums[0]! - step * k };
            else if (base?.userEnteredValue?.formulaValue) {
              const [fr, fc] = at(from);
              cell.userEnteredValue = { formulaValue: shiftFormula(base.userEnteredValue.formulaValue, r - fr, c - fc) };
            }
            this.put(sh, r, c, cell);
          }
        }
        return {};
      }
      case "copyPaste":
      case "cutPaste": {
        const s = this.box(b.source);
        const h = s.r1 - s.r0 + 1;
        const w = s.c1 - s.c0 + 1;
        const src = Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => structuredClone(this.get(s.sh, s.r0 + i, s.c0 + j))));
        const d =
          kind === "cutPaste"
            ? { sh: this.sheet(b.destination.sheetId)!, r0: b.destination.rowIndex ?? 0, c0: b.destination.columnIndex ?? 0, r1: (b.destination.rowIndex ?? 0) + h - 1, c1: (b.destination.columnIndex ?? 0) + w - 1 }
            : this.box(b.destination);
        if (kind === "cutPaste") for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) this.put(s.sh, s.r0 + i, s.c0 + j, undefined);
        for (let r = d.r0; r <= Math.max(d.r1, d.r0 + h - 1); r++)
          for (let c = d.c0; c <= Math.max(d.c1, d.c0 + w - 1); c++) {
            const i = (r - d.r0) % h;
            const j = (c - d.c0) % w;
            const cell = structuredClone(src[i][j]);
            if (kind === "copyPaste" && cell?.userEnteredValue?.formulaValue) cell.userEnteredValue = { formulaValue: shiftFormula(cell.userEnteredValue.formulaValue, r - (s.r0 + i), c - (s.c0 + j)) };
            this.put(d.sh, r, c, cell);
          }
        return {};
      }
      case "findReplace": {
        let n = 0;
        const sheets = b.allSheets ? this.book.sheets : [this.sheet(b.sheetId ?? 0)!];
        for (const sh of sheets)
          sh.cells.forEach((row, r) =>
            row?.forEach((cell, c) => {
              const sv = cell?.userEnteredValue?.stringValue;
              if (typeof sv !== "string") return;
              const re = new RegExp(String(b.find).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), b.matchCase ? "g" : "gi");
              const out = sv.replace(re, () => (n++, b.replacement ?? ""));
              if (out !== sv) this.put(sh, r, c, { ...cell, userEnteredValue: { stringValue: out } });
            }),
          );
        return { findReplace: { occurrencesChanged: n, valuesChanged: n } };
      }
      default:
        throw new Error(`Invalid request: ${kind} isn't mocked`);
    }
  }

  /** spreadsheets.get */
  get_(ranges: string[], grid: boolean) {
    const props = (sh: MSheet) => ({ ...structuredClone(sh.properties) });
    const sheets = [...this.book.sheets].sort((a, b) => a.properties.index - b.properties.index);
    if (!grid || !ranges.length) {
      return { spreadsheetId: this.book.id, properties: { title: this.book.title, locale: this.book.locale, timeZone: "Asia/Kolkata" }, sheets: sheets.map((sh) => ({ properties: props(sh), merges: sh.merges.length ? sh.merges : undefined, basicFilter: sh.basicFilter })) };
    }
    const out = ranges.map((a1) => {
      const { sh, r0, r1, c0, c1 } = this.range(a1);
      const g = sh.properties.gridProperties;
      const rEnd = Math.min(r1, g.rowCount - 1);
      const cEnd = Math.min(c1, g.columnCount - 1);
      const hidden = this.filterHidden(sh);
      const rowData = [];
      for (let r = r0; r <= rEnd; r++) {
        const values = [];
        for (let c = c0; c <= cEnd; c++) {
          const cell = this.get(sh, r, c);
          if (!cell) {
            values.push({});
            continue;
          }
          const f = this.formatted(sh, r, c);
          const ev = isErr(f.v) ? { errorValue: { type: "ERROR", message: f.v.err } } : typeof f.v === "number" ? { numberValue: f.v } : typeof f.v === "boolean" ? { boolValue: f.v } : f.v === "" ? undefined : { stringValue: f.v };
          values.push({ formattedValue: f.text || undefined, userEnteredValue: cell.userEnteredValue, effectiveValue: cell.userEnteredValue ? ev : undefined, userEnteredFormat: cell.userEnteredFormat, note: cell.note, hyperlink: cell.userEnteredFormat?.textFormat?.link?.uri });
        }
        rowData.push({ values });
      }
      return {
        properties: props(sh),
        merges: sh.merges,
        data: [
          {
            startRow: r0,
            startColumn: c0,
            rowData,
            rowMetadata: Array.from({ length: rEnd - r0 + 1 }, (_, i) => ({ pixelSize: sh.rowPx.get(r0 + i) ?? 21, ...(hidden.has(r0 + i) ? { hiddenByFilter: true } : {}) })),
            columnMetadata: Array.from({ length: cEnd - c0 + 1 }, (_, i) => ({ pixelSize: sh.colPx.get(c0 + i) ?? 100 })),
          },
        ],
      };
    });
    return { spreadsheetId: this.book.id, properties: { title: this.book.title, locale: this.book.locale }, sheets: out };
  }
  filterHidden(sh: MSheet) {
    const out = new Set<number>();
    const f = sh.basicFilter;
    if (!f?.filterSpecs?.length) return out;
    const g = sh.properties.gridProperties;
    const r0 = (f.range.startRowIndex ?? 0) + 1;
    const r1 = f.range.endRowIndex ?? g.rowCount;
    for (let r = r0; r < r1; r++) for (const s of f.filterSpecs) if (s.filterCriteria?.hiddenValues?.includes(this.formatted(sh, r, s.columnIndex).text)) out.add(r);
    return out;
  }
}

export type Mock = {
  server: http.Server;
  files: Record<string, MFile>;
  books: Record<string, MockBook>;
  docs: Record<string, MockDoc>;
  decks: Record<string, MockDeck>;
  /** Link-sharing permissions made for image uploads (removed again after inserting). */
  perms: Record<string, { fileId: string; type: string; role: string }>;
  calls: { method: string; path: string; body: Json }[];
  close: () => Promise<void>;
};

/** Start the mock on 127.0.0.1:<port>. Access token "at-dev" (from POST /token). */
export async function startGoogleMock(port = 4799, seed: { files?: MFile[]; books?: MBook[]; docs?: MockDoc[]; decks?: MockDeck[] } = {}): Promise<Mock> {
  const files: Record<string, MFile> = {};
  const books: Record<string, MockBook> = {};
  const docs: Record<string, MockDoc> = {};
  const decks: Record<string, MockDeck> = {};
  const perms: Mock["perms"] = {};
  const base = `http://127.0.0.1:${port}`;
  for (const f of seed.files ?? []) files[f.id] = f;
  for (const b of seed.books ?? []) books[b.id] = new MockBook(b);
  for (const d of seed.docs ?? []) docs[d.id] = d;
  for (const d of seed.decks ?? []) decks[d.id] = d;
  const calls: Mock["calls"] = [];
  let n = 0;
  const now = () => new Date().toISOString();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    let raw = "";
    for await (const ch of req) raw += ch;
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : null;
    const json = (v: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const fail = (message: string, status = 400) => json({ error: { code: status, message, status: "INVALID_ARGUMENT" } }, status);
    if (u.pathname === "/token") return json({ access_token: "at-dev", expires_in: 3600 });
    // Pictures (inline images, slide thumbnails): public, like Google's short-lived content URLs.
    const svg = (body: string) => {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      res.end(body);
    };
    let pic = u.pathname.match(/^\/img\/(.+)\.svg$/);
    if (pic) return svg(mockSvg(decodeURIComponent(pic[1]).replace(/^kix\./, "")));
    pic = u.pathname.match(/^\/thumb\/([^/]+)\/([^/]+)\.svg$/);
    if (pic && decks[pic[1]]) return svg(decks[pic[1]].thumbSvg(pic[2], Number(u.searchParams.get("w")) || 800));
    if (req.headers.authorization !== "Bearer at-dev") return fail("Invalid Credentials", 401);
    calls.push({ method: req.method!, path: decodeURIComponent(u.pathname + u.search), body });
    const file = (id: string) => {
      const f = files[id];
      const kind = f.mimeType === DOC_MIME ? "document" : f.mimeType === SLIDES_MIME ? "presentation" : "spreadsheets";
      return { id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, viewedByMeTime: f.viewedByMeTime, starred: !!f.starred, ownedByMe: f.ownedByMe !== false, webViewLink: `https://docs.google.com/${kind}/d/${id}/edit`, owners: [{ displayName: f.owner ?? "Dev" }], capabilities: { canEdit: f.canEdit !== false, canShare: true } };
    };
    try {
      // ── Drive ──
      if (u.pathname === "/drive/v3/files" && req.method === "GET") {
        const q = u.searchParams.get("q") ?? "";
        const name = q.match(/name contains '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, "$1");
        let list = Object.keys(files).filter((id) => !files[id].trashed && q.includes(files[id].mimeType) && (!name || files[id].name.toLowerCase().includes(name.toLowerCase())));
        if (/not 'me' in owners/.test(q)) list = list.filter((id) => files[id].ownedByMe === false);
        else if (/'me' in owners/.test(q)) list = list.filter((id) => files[id].ownedByMe !== false);
        const order = u.searchParams.get("orderBy") ?? "";
        list.sort((a, b) => (order.startsWith("name") ? files[a].name.localeCompare(files[b].name) : order.startsWith("viewedByMeTime") ? (files[b].viewedByMeTime ?? "").localeCompare(files[a].viewedByMeTime ?? "") : files[b].modifiedTime.localeCompare(files[a].modifiedTime)));
        return json({ files: list.map(file) });
      }
      if (u.pathname === "/drive/v3/files" && req.method === "POST") {
        const id = `new${++n}`;
        files[id] = { id, name: body.name, mimeType: body.mimeType, modifiedTime: now(), viewedByMeTime: now() };
        if (body.mimeType === SHEET_MIME) books[id] = new MockBook({ id, title: body.name, locale: "en_US", sheets: [newSheet(0, "Sheet1", 0)] });
        if (body.mimeType === DOC_MIME) docs[id] = new MockDoc(id, body.name, undefined, base);
        if (body.mimeType === SLIDES_MIME) {
          decks[id] = new MockDeck(id, body.name, base);
          decks[id].batch([{ createSlide: { objectId: `${id}_s1`, slideLayoutReference: { predefinedLayout: "TITLE" } } }]);
        }
        return json(file(id));
      }
      // Image uploads (multipart): the metadata part names the file.
      if (u.pathname === "/upload/drive/v3/files" && req.method === "POST") {
        if (u.searchParams.get("uploadType") !== "multipart") return fail("uploadType must be multipart in this mock");
        const meta = typeof body === "string" ? body.match(/\{[^{}]*"name"[^{}]*\}/)?.[0] : null;
        const m0 = meta ? JSON.parse(meta) : {};
        const id = `img${++n}`;
        files[id] = { id, name: m0.name ?? "Image", mimeType: m0.mimeType ?? "image/png", modifiedTime: now() };
        return json({ id, name: files[id].name, mimeType: files[id].mimeType });
      }
      const dm = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/(export|permissions|comments)(?:\/([^/]+))?$/);
      if (dm) {
        const [, fid, what, sub] = dm;
        if (!files[fid]) return fail("File not found", 404);
        if (what === "export") {
          const mime = u.searchParams.get("mimeType") ?? "";
          const text = docs[fid] ? docs[fid].text() : decks[fid] ? decks[fid].p.slides.map((s: Json) => s.objectId).join("\n") : files[fid].name;
          const head = mime === "application/pdf" ? "%PDF-1.4\n% mock export\n" : /openxml|opendocument|epub/.test(mime) ? "PK\u0003\u0004 mock export\n" : "";
          if (!/pdf|openxml|opendocument|epub|text\/plain|text\/markdown|rtf/.test(mime)) return fail(`Export to ${mime} isn't supported for this file.`, 400);
          res.writeHead(200, { "content-type": mime });
          return res.end(head + text);
        }
        if (what === "comments") return json({ comments: files[fid].comments ?? [] });
        if (what === "permissions" && req.method === "POST") {
          const pid = `perm${++n}`;
          perms[pid] = { fileId: fid, type: body?.type, role: body?.role };
          return json({ id: pid, type: body?.type, role: body?.role });
        }
        if (what === "permissions" && req.method === "DELETE" && sub) {
          if (!perms[sub]) return fail("Permission not found", 404);
          delete perms[sub];
          res.writeHead(204);
          return res.end();
        }
        return fail("not mocked", 404);
      }
      let m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/copy)?$/);
      if (m) {
        const id = m[1];
        if (!files[id]) return fail("File not found", 404);
        if (m[2]) {
          const nid = `copy${++n}`;
          files[nid] = { ...files[id], id: nid, name: body?.name || `Copy of ${files[id].name}`, modifiedTime: now() };
          if (docs[id]) docs[nid] = docs[id].clone(nid, files[nid].name);
          if (decks[id]) decks[nid] = decks[id].clone(nid, files[nid].name);
          if (books[id]) books[nid] = new MockBook({ ...(structuredClone({ ...books[id].book, sheets: [] }) as MBook), id: nid, title: files[nid].name, sheets: books[id].book.sheets.map((s) => ({ ...structuredClone({ ...s, rowPx: undefined, colPx: undefined }), rowPx: new Map(s.rowPx), colPx: new Map(s.colPx) }) as MSheet) });
          return json(file(nid));
        }
        if (req.method === "PATCH") {
          Object.assign(files[id], body);
          if (body.name && books[id]) books[id].book.title = body.name;
          if (body.name && docs[id]) docs[id].title = body.name;
          if (body.name && decks[id]) decks[id].p.title = body.name;
          if (body.name) files[id].modifiedTime = now();
        }
        return json(file(id));
      }
      // ── Docs ──
      m = u.pathname.match(/^\/v1\/documents\/([^/:]+)(:batchUpdate)?$/);
      if (m) {
        const d = docs[m[1]];
        if (!d || files[m[1]]?.trashed) return fail("Requested entity was not found.", 404);
        if (!m[2]) return json(d.get());
        if (files[m[1]]?.canEdit === false) return fail("The caller does not have permission", 403);
        try {
          const out = d.batch(body.requests ?? [], body.writeControl);
          files[m[1]].modifiedTime = now();
          return json(out);
        } catch (e) {
          return json({ error: { code: 400, message: (e as Error).message, status: e instanceof DocsError ? e.status : "INVALID_ARGUMENT" } }, 400);
        }
      }
      // ── Slides ──
      m = u.pathname.match(/^\/v1\/presentations\/([^/:]+)(:batchUpdate|\/pages\/([^/]+)\/thumbnail)?$/);
      if (m) {
        const d = decks[m[1]];
        if (!d || files[m[1]]?.trashed) return fail("Requested entity was not found.", 404);
        if (!m[2]) return json(d.get());
        if (m[3]) {
          if (!d.slide(m[3])) return fail("The page could not be found.", 404);
          d.thumbCalls++;
          const size = u.searchParams.get("thumbnailProperties.thumbnailSize") ?? "MEDIUM";
          const w = size === "LARGE" ? 1600 : size === "SMALL" ? 200 : 800;
          return json({ width: w, height: Math.round((w * 9) / 16), contentUrl: `${base}/thumb/${m[1]}/${m[3]}.svg?w=${w}&r=${d.rev}` });
        }
        if (files[m[1]]?.canEdit === false) return fail("The caller does not have permission", 403);
        try {
          const out = d.batch(body.requests ?? [], body.writeControl);
          files[m[1]].modifiedTime = now();
          return json(out);
        } catch (e) {
          return json({ error: { code: 400, message: (e as Error).message, status: e instanceof SlidesError ? e.status : "INVALID_ARGUMENT" } }, 400);
        }
      }
      // ── Sheets ──
      m = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/);
      if (m) {
        const bk = books[m[1]];
        if (!bk || files[m[1]]?.trashed) return fail("Requested entity was not found.", 404);
        const rest = decodeURIComponent(m[2]);
        const touched = () => (files[m![1]].modifiedTime = now());
        if (rest === "" && req.method === "GET") return json(bk.get_(u.searchParams.getAll("ranges"), u.searchParams.get("includeGridData") === "true"));
        if (rest === ":batchUpdate") {
          if (files[m[1]].canEdit === false) return fail("The caller does not have permission", 403);
          // All or nothing, like Google.
          const backup = structuredClone({ ...bk.book, sheets: bk.book.sheets.map((s) => ({ ...s, rowPx: [...s.rowPx], colPx: [...s.colPx] })) });
          try {
            const replies = (body.requests as Json[]).map((r) => bk.apply(r));
            touched();
            return json({ spreadsheetId: m[1], replies });
          } catch (e) {
            bk.book = { ...backup, sheets: backup.sheets.map((s: Json) => ({ ...s, rowPx: new Map(s.rowPx), colPx: new Map(s.colPx) })) } as MBook;
            return fail(`Invalid requests: ${(e as Error).message}`);
          }
        }
        if (rest === "/values:batchUpdate") {
          if (body.valueInputOption !== "USER_ENTERED") return fail("valueInputOption must be USER_ENTERED in this mock");
          let cells = 0;
          for (const d of body.data) {
            const { sh, r0, c0 } = bk.range(d.range);
            (d.values as string[][]).forEach((row, i) => row.forEach((v, j) => (bk.writeTyped(sh, r0 + i, c0 + j, String(v)), cells++)));
          }
          touched();
          return json({ spreadsheetId: m[1], totalUpdatedCells: cells });
        }
        const vm = rest.match(/^\/values\/(.+?)(:append)?$/);
        if (vm) {
          const { sh, r0, c0, r1, c1 } = bk.range(vm[1]);
          if (vm[2]) {
            const r = Math.max(0, ...sh.cells.map((row, i) => (row?.some(Boolean) ? i + 1 : 0)));
            (body.values as string[][]).forEach((row, i) => row.forEach((v, j) => bk.writeTyped(sh, r + i, j, String(v))));
            touched();
            return json({});
          }
          if (req.method === "PUT") {
            (body.values as string[][]).forEach((row, i) => row.forEach((v, j) => bk.writeTyped(sh, r0 + i, c0 + j, String(v))));
            touched();
            return json({});
          }
          const values: string[][] = [];
          const last = Math.min(r1, sh.cells.length - 1);
          for (let r = r0; r <= last; r++) {
            const row: string[] = [];
            for (let c = c0; c <= Math.min(c1, (sh.cells[r]?.length ?? 0) - 1); c++) row.push(bk.formatted(sh, r, c).text);
            while (row.length && row[row.length - 1] === "") row.pop();
            values.push(row);
          }
          while (values.length && !values[values.length - 1].length) values.pop();
          return json({ range: `${sh.properties.title}!${colName(c0)}${r0 + 1}:${colName(c1)}${r1 + 1}`, values });
        }
      }
      fail(`not mocked: ${req.method} ${u.pathname}`, 404);
    } catch (e) {
      fail((e as Error).message);
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  return { server, files, books, docs, decks, perms, calls, close: () => new Promise((r) => server.close(() => r())) };
}

/** A demo spreadsheet: formats, formulas, a merged title, a frozen header and 12,000 rows on a second tab. */
export function demoBook(id = "sheetdemo"): { file: MFile; book: MBook } {
  const summary = newSheet(0, "Summary", 0, 1000, 26);
  const orders = newSheet(7001, "Orders", 1, 12_001, 8);
  const bk = new MockBook({ id, title: "Q3 Sales (demo)", locale: "en_US", sheets: [summary, orders] });
  const bold = { textFormat: { bold: true } };
  const put = (sh: MSheet, a1: string, v: string, uf?: Json) => {
    const { r0, c0 } = bk.range(`'${sh.properties.title}'!${a1}`);
    bk.writeTyped(sh, r0, c0, v);
    if (uf) bk.put(sh, r0, c0, { ...bk.get(sh, r0, c0), userEnteredFormat: { ...bk.get(sh, r0, c0)?.userEnteredFormat, ...uf } });
  };
  put(summary, "A1", "Q3 sales by region", { textFormat: { bold: true, fontSize: 14 }, horizontalAlignment: "CENTER", backgroundColorStyle: { rgbColor: { red: 0.851, green: 0.918, blue: 0.827 } } });
  summary.merges.push({ sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 });
  summary.rowPx.set(0, 32);
  ["Region", "July", "August", "September", "Total"].forEach((h, i) => put(summary, `${colName(i)}3`, h, { ...bold, backgroundColorStyle: { rgbColor: { red: 0.953, green: 0.953, blue: 0.953 } }, borders: { bottom: { style: "SOLID", colorStyle: { rgbColor: {} } } } }));
  const data = [
    ["North", 18400, 21250, 19870],
    ["South", 15320, 14980, 17460],
    ["East", 22110, 23540, 25010],
    ["West", 12890, 13760, 14420],
  ];
  data.forEach((row, i) => {
    const r = i + 4;
    put(summary, `A${r}`, String(row[0]));
    [1, 2, 3].forEach((c) => put(summary, `${colName(c)}${r}`, String(row[c]), { numberFormat: { type: "CURRENCY", pattern: '"$"#,##0' } }));
    put(summary, `E${r}`, `=SUM(B${r}:D${r})`, { numberFormat: { type: "CURRENCY", pattern: '"$"#,##0' }, textFormat: { bold: true } });
  });
  put(summary, "A8", "Total", bold);
  ["B", "C", "D", "E"].forEach((c) => put(summary, `${c}8`, `=SUM(${c}4:${c}7)`, { numberFormat: { type: "CURRENCY", pattern: '"$"#,##0' }, textFormat: { bold: true }, borders: { top: { style: "SOLID_MEDIUM", colorStyle: { rgbColor: {} } } } }));
  put(summary, "A10", "Growth Jul→Sep");
  put(summary, "B10", "=(D8-B8)/B8", { numberFormat: { type: "PERCENT", pattern: "0.0%" }, textFormat: { foregroundColorStyle: { rgbColor: { red: 0.094, green: 0.502, blue: 0.22 } } } });
  put(summary, "A12", "This is a long note that overflows into the empty cells to its right, as in Google Sheets.");
  bk.put(summary, 3, 0, { ...bk.get(summary, 3, 0), note: "Includes the new Chandigarh branch." });
  summary.colPx.set(0, 140);
  summary.properties.gridProperties.frozenRowCount = 0;

  const regions = ["North", "South", "East", "West"];
  const items = ["HR coil", "CR sheet", "MS plate", "GI coil", "Wire rod"];
  ["Order", "Date", "Region", "Item", "Qty", "Rate", "Amount", "Status"].forEach((h, i) => put(orders, `${colName(i)}1`, h, { ...bold, backgroundColorStyle: { rgbColor: { red: 0.788, green: 0.855, blue: 0.973 } } }));
  orders.properties.gridProperties.frozenRowCount = 1;
  orders.properties.gridProperties.frozenColumnCount = 1;
  for (let i = 0; i < 12_000; i++) {
    const r = i + 1;
    orders.cells[r] = [
      { userEnteredValue: { stringValue: `SO-${String(10001 + i)}` } },
      { userEnteredValue: { stringValue: `2026-${String(7 + (i % 3)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}` } },
      { userEnteredValue: { stringValue: regions[i % 4] } },
      { userEnteredValue: { stringValue: items[i % 5] } },
      { userEnteredValue: { numberValue: 5 + ((i * 7) % 60) } },
      { userEnteredValue: { numberValue: 52 + ((i * 13) % 20) }, userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } },
      { userEnteredValue: { formulaValue: `=E${r + 1}*F${r + 1}` }, userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } },
      { userEnteredValue: { stringValue: i % 9 === 0 ? "Pending" : "Shipped" }, userEnteredFormat: i % 9 === 0 ? { textFormat: { foregroundColorStyle: { rgbColor: { red: 0.851, green: 0.188, blue: 0.145 } } } } : undefined },
    ];
  }
  return { file: { id, name: "Q3 Sales (demo)", mimeType: SHEET_MIME, modifiedTime: new Date().toISOString(), viewedByMeTime: new Date().toISOString() }, book: bk.book };
}
