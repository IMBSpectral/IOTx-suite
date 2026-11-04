/**
 * A Google Doc as the editor holds it: one token per Google index (UTF-16
 * code unit), so a change made here lands at exactly the index Google
 * expects. Characters carry their text style; the newline that ends a
 * paragraph carries the paragraph style and bullet. Tables, rows and cells
 * take one index each where Google puts their start markers.
 *
 * The same requests are applied here (to show them at once) and sent to
 * documents.batchUpdate; after each batch the document is read again, so
 * anything simulated slightly differently is corrected from Google's copy.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;
export type TS = Record<string, Json>;
export type PS = Record<string, Json>;
export type Bullet = { listId: string; nestingLevel?: number; textStyle?: TS };
/** ro: inside a table of contents; sug: part of a suggestion (shown, not editable). */
type Flags = { ro?: 1; sug?: "i" | "d" };
export type Tok =
  | ({ k: "c"; ch: string; ts: TS } & Flags)
  | ({ k: "n"; ts: TS; ps: PS; bullet?: Bullet } & Flags)
  | ({ k: "io"; id: string; ts: TS } & Flags)
  | ({ k: "pb"; ts: TS } & Flags)
  | ({ k: "x"; what: string; label: string; first: boolean; len: number } & Flags)
  | { k: "sb" }
  | { k: "ts"; style?: Json; cols: number }
  | { k: "rs" }
  | { k: "cs"; style?: Json }
  | { k: "te" }
  | { k: "op" };
export type Req = Record<string, Json>;

export type Flat = {
  toks: Tok[];
  revisionId: string | null;
  title: string;
  lists: Record<string, Json>;
  inline: Record<string, Json>;
  named: Record<string, { ts: TS; ps: PS }>;
  docStyle: Json;
  headers: Record<string, Tok[]>;
  footers: Record<string, Tok[]>;
  positioned: number;
  /** Set when the document has content whose indexes couldn't be followed; the editor then stays view only. */
  unsafe: string | null;
};

const EMPTY: TS = {};

// ── Reading Google's JSON ──
function walk(content: Json[] | undefined, out: Tok[], ro: boolean, problems: string[]) {
  for (const el of content ?? []) {
    const s = el.startIndex ?? out.length;
    if (out.length > s) problems.push(`overlap at ${s}`);
    while (out.length < s) out.push({ k: "op" });
    if (el.sectionBreak) out.push({ k: "sb" });
    else if (el.paragraph) para(el.paragraph, out, ro, problems);
    else if (el.table) {
      const t = el.table;
      out.push({ k: "ts", style: t.tableStyle, cols: t.columns ?? t.tableRows?.[0]?.tableCells?.length ?? 1 });
      for (const row of t.tableRows ?? []) {
        while (out.length < (row.startIndex ?? out.length)) out.push({ k: "op" });
        out.push({ k: "rs" });
        for (const cell of row.tableCells ?? []) {
          while (out.length < (cell.startIndex ?? out.length)) out.push({ k: "op" });
          out.push({ k: "cs", style: cell.tableCellStyle });
          walk(cell.content, out, ro, problems);
        }
      }
      while (out.length < (el.endIndex ?? out.length + 1) - 1) out.push({ k: "op" });
      out.push({ k: "te" });
    } else if (el.tableOfContents) {
      out.push({ k: "op" });
      walk(el.tableOfContents.content, out, true, problems);
    }
    const e = el.endIndex ?? out.length;
    if (out.length > e) problems.push(`element ${s}-${e} is longer than Google says`);
    while (out.length < e) out.push({ k: "op" });
  }
}

function para(p: Json, out: Tok[], ro: boolean, problems: string[]) {
  const f = (e: Json): Flags => ({
    ...(ro ? { ro: 1 as const } : {}),
    ...(e?.suggestedInsertionIds?.length ? { sug: "i" as const } : e?.suggestedDeletionIds?.length ? { sug: "d" as const } : {}),
  });
  let sawEnd = false;
  for (const e of p.elements ?? []) {
    const s = e.startIndex ?? out.length;
    while (out.length < s) out.push({ k: "op" });
    const len = (e.endIndex ?? s + 1) - s;
    if (e.textRun) {
      const ts: TS = e.textRun.textStyle ?? EMPTY;
      const text: string = e.textRun.content ?? "";
      const fl = f(e.textRun);
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n" && i === text.length - 1 && e === p.elements[p.elements.length - 1]) {
          out.push({ k: "n", ts, ps: p.paragraphStyle ?? {}, ...(p.bullet ? { bullet: p.bullet } : {}), ...fl });
          sawEnd = true;
        } else out.push({ k: "c", ch: text[i], ts, ...fl });
      }
    } else if (e.inlineObjectElement) out.push({ k: "io", id: e.inlineObjectElement.inlineObjectId, ts: e.inlineObjectElement.textStyle ?? EMPTY, ...f(e.inlineObjectElement) });
    else if (e.pageBreak) out.push({ k: "pb", ts: e.pageBreak.textStyle ?? EMPTY, ...f(e.pageBreak) });
    else {
      const what = Object.keys(e).find((k) => !["startIndex", "endIndex"].includes(k)) ?? "unknown";
      const v = e[what] ?? {};
      const label =
        what === "footnoteReference" ? String(v.footnoteNumber ?? "*") : what === "person" ? (v.personProperties?.name ?? v.personProperties?.email ?? "Person") : what === "richLink" ? (v.richLinkProperties?.title ?? "Link") : what === "equation" ? "Equation" : what === "horizontalRule" ? "" : what === "autoText" ? "#" : what === "columnBreak" ? "" : what;
      for (let i = 0; i < len; i++) out.push({ k: "x", what, label, first: i === 0, len, ro: 1 });
    }
    const end = e.endIndex ?? out.length;
    if (out.length > end) problems.push(`text at ${s} is longer than Google says`);
    while (out.length < end) out.push({ k: "op" });
  }
  if (!sawEnd) problems.push("a paragraph without its newline");
}

export function fromGoogle(doc: Json): Flat {
  const problems: string[] = [];
  const toks: Tok[] = [];
  walk(doc.body?.content, toks, false, problems);
  const named: Flat["named"] = {};
  for (const s of doc.namedStyles?.styles ?? []) named[s.namedStyleType] = { ts: s.textStyle ?? {}, ps: s.paragraphStyle ?? {} };
  const seg = (m: Json) => {
    const o: Record<string, Tok[]> = {};
    for (const [id, h] of Object.entries(m ?? {}) as [string, Json][]) {
      const t: Tok[] = [];
      walk(h.content, t, true, []);
      o[id] = t;
    }
    return o;
  };
  const last = toks[toks.length - 1];
  if (!last || last.k !== "n") problems.push("the body doesn't end with a paragraph");
  return {
    toks,
    revisionId: doc.revisionId ?? null,
    title: doc.title ?? "",
    lists: doc.lists ?? {},
    inline: doc.inlineObjects ?? {},
    named,
    docStyle: doc.documentStyle ?? {},
    headers: seg(doc.headers),
    footers: seg(doc.footers),
    positioned: Object.keys(doc.positionedObjects ?? {}).length,
    unsafe: problems.length ? problems.slice(0, 3).join("; ") : null,
  };
}

// ── Looking things up ──
export const isText = (t: Tok | undefined): t is Extract<Tok, { k: "c" | "n" | "io" | "pb" | "x" }> => !!t && (t.k === "c" || t.k === "n" || t.k === "io" || t.k === "pb" || t.k === "x");
const STRUCT = new Set(["sb", "ts", "rs", "cs", "te", "op"]);

/** The paragraph around index i: [start, end) with end just after its newline. */
export function paraAt(toks: Tok[], i: number): [number, number] {
  let s = Math.min(i, toks.length - 1);
  while (s > 0 && toks[s - 1].k !== "n" && !STRUCT.has(toks[s - 1].k)) s--;
  let e = Math.max(i, s);
  while (e < toks.length && toks[e].k !== "n") {
    if (STRUCT.has(toks[e].k)) return [s, e];
    e++;
  }
  return [s, Math.min(toks.length, e + 1)];
}
export function newlineOf(toks: Tok[], i: number) {
  const [, e] = paraAt(toks, i);
  const t = toks[e - 1];
  return t?.k === "n" ? t : null;
}
/** Every paragraph overlapping [s, e) (or containing s when the range is empty). */
export function parasIn(toks: Tok[], s: number, e: number): [number, number][] {
  const out: [number, number][] = [];
  let i = s;
  for (;;) {
    while (i < toks.length && STRUCT.has(toks[i].k)) i++;
    if (i >= toks.length) break;
    const p = paraAt(toks, i);
    if (p[0] >= Math.max(e, s + 1)) break;
    out.push(p);
    i = p[1];
    if (i >= e) break;
  }
  return out;
}
export function textOf(toks: Tok[], s: number, e: number) {
  let out = "";
  for (let i = s; i < e; i++) {
    const t = toks[i];
    if (t.k === "c") out += t.ch === "\u000b" ? "\n" : t.ch;
    else if (t.k === "n") out += "\n";
    else if (t.k === "ts" || t.k === "rs") out += i > s && t.k === "rs" ? "\n" : "";
    else if (t.k === "cs") out += toks[i - 1]?.k === "rs" ? "" : "\t";
  }
  return out;
}
/** The style the caret is "in": the character before it, as Google does when typing. */
export function styleAt(toks: Tok[], i: number): TS {
  const prev = toks[i - 1];
  if (prev && (prev.k === "c" || prev.k === "io" || prev.k === "pb")) return prev.ts;
  const t = toks[i];
  return t && (t.k === "c" || t.k === "n" || t.k === "io" || t.k === "pb") ? t.ts : EMPTY;
}
export function wordCount(toks: Tok[]) {
  let words = 0;
  let chars = 0;
  let inWord = false;
  for (const t of toks) {
    const ch = t.k === "c" && t.sug !== "d" ? t.ch : t.k === "n" ? "\n" : "";
    if (ch && ch !== "\n") chars++;
    const w = !!ch && !/\s/.test(ch);
    if (w && !inWord) words++;
    inWord = w;
  }
  return { words, chars };
}

/** Where the table that starts at index i ends (the index of its end marker). */
export function tableEnd(toks: Tok[], i: number) {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].k === "ts") depth++;
    else if (toks[j].k === "te" && --depth === 0) return j;
  }
  return toks.length - 1;
}
/** The table cell around index i: { table start, row, column, first and last content index }. */
export function cellAt(toks: Tok[], i: number) {
  // Walk back to the nearest cell start that isn't inside a nested table.
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const k = toks[j].k;
    if (k === "te") depth++;
    else if (k === "ts") {
      if (depth === 0) return null;
      depth--;
    } else if (k === "cs" && depth === 0) {
      // Find the table start and count rows and columns.
      let d = 0;
      let ts = -1;
      for (let x = j - 1; x >= 0; x--) {
        if (toks[x].k === "te") d++;
        else if (toks[x].k === "ts") {
          if (d === 0) {
            ts = x;
            break;
          }
          d--;
        }
      }
      if (ts < 0) return null;
      let row = -1;
      let col = -1;
      let dd = 0;
      for (let x = ts + 1; x <= j; x++) {
        const kk = toks[x].k;
        if (kk === "ts") dd++;
        else if (kk === "te") dd--;
        else if (dd === 0 && kk === "rs") (row++, (col = -1));
        else if (dd === 0 && kk === "cs") col++;
      }
      let end = j + 1;
      let de = 0;
      while (end < toks.length) {
        const kk = toks[end].k;
        if (kk === "ts") de++;
        else if (kk === "te") {
          if (de === 0) break;
          de--;
        } else if (de === 0 && (kk === "cs" || kk === "rs")) break;
        end++;
      }
      return { table: ts, row, col, first: j + 1, last: end - 1, cols: (toks[ts] as Extract<Tok, { k: "ts" }>).cols };
    }
  }
  return null;
}

// ── Checking edits before making them ──
const RO_MSG = "That part is read only here (a suggestion, table of contents, equation or smart chip). Open it in Google Docs to change it.";
export function canInsert(toks: Tok[], i: number): string | null {
  const t = toks[i];
  if (i < 1 || !t || !isText(t)) return "You can't type there.";
  if (t.k === "x" && !t.first) return RO_MSG;
  if (t.ro || (t.sug && toks[i - 1] && "sug" in toks[i - 1] && (toks[i - 1] as Flags).sug)) return RO_MSG;
  return null;
}
/** A deletion Google will accept: [s, e) widened over whole chips, or the reason it can't be done. */
export function checkDelete(toks: Tok[], s: number, e: number): { s: number; e: number } | string {
  if (s >= e) return { s, e };
  while (s > 1 && toks[s].k === "x" && !(toks[s] as { first: boolean }).first) s--;
  while (e < toks.length && toks[e]?.k === "x" && !(toks[e] as { first: boolean }).first) e++;
  if (s < 1) s = 1;
  if (e >= toks.length) e = toks.length - 1; // never the document's last newline
  if (s >= e) return "Nothing to delete there.";
  for (let i = s; i < e; i++) {
    const t = toks[i];
    if ((t as Flags).ro || (t as Flags).sug) return RO_MSG;
    if (t.k === "sb" || t.k === "op") return "That part of the document can't be deleted here.";
    if (t.k === "ts") {
      const te = tableEnd(toks, i);
      if (te >= e) return "Select the whole table to delete it, or use Format > Table > Delete table.";
      i = te;
      continue;
    }
    if (t.k === "rs" || t.k === "cs" || t.k === "te") return "You can delete text inside a cell, not the cell itself. Use Format > Table to delete rows or columns.";
    // A cell's last newline belongs to the cell.
    if (t.k === "n" && i + 1 < toks.length && ["cs", "rs", "te"].includes(toks[i + 1].k)) return "That's the end of the cell; it can't be deleted.";
  }
  // Google keeps the newline before a table unless the table goes too.
  if (toks[e - 1].k === "n" && toks[e]?.k === "ts") {
    if (e - 1 <= s) return "That's the line before a table; it can't be deleted on its own.";
    e--;
  }
  return { s, e };
}

// ── Applying requests locally (the same ones go to Google) ──
export const LOCAL = new Set(["insertText", "deleteContentRange", "updateTextStyle", "updateParagraphStyle", "createParagraphBullets", "deleteParagraphBullets"]);
const PS_FIELDS = ["namedStyleType", "alignment", "lineSpacing", "direction", "spacingMode", "spaceAbove", "spaceBelow", "indentFirstLine", "indentStart", "indentEnd", "keepLinesTogether", "keepWithNext", "avoidWidowAndOrphan"];
export const PS_ALL = PS_FIELDS.join(",");

function patch(obj: Record<string, Json>, style: Record<string, Json>, fields: string) {
  if (fields.trim() === "*") return { ...style };
  const out = { ...obj };
  for (const f of fields.split(",").map((x) => x.trim().split(".")[0]).filter(Boolean)) {
    if (style[f] !== undefined) out[f] = style[f];
    else delete out[f];
  }
  return out;
}
export const pick = (obj: Record<string, Json>, fields: string) => {
  if (fields.trim() === "*") return { ...obj };
  const out: Record<string, Json> = {};
  for (const f of fields.split(",").map((x) => x.trim().split(".")[0])) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
};

let localList = 0;
const DISC = ["●", "○", "■"];
export function presetLevels(preset: string) {
  const levels = Array.from({ length: 9 }, (_, i) => {
    const base = { indentFirstLine: { magnitude: 18 + 36 * i, unit: "PT" }, indentStart: { magnitude: 36 + 36 * i, unit: "PT" }, startNumber: 1 };
    if (preset.startsWith("NUMBERED")) return { ...base, glyphType: ["DECIMAL", "ALPHA", "ROMAN"][i % 3], glyphFormat: `%${i}.` };
    if (preset === "BULLET_CHECKBOX") return { ...base, glyphType: "GLYPH_TYPE_UNSPECIFIED" };
    return { ...base, glyphSymbol: DISC[i % 3] };
  });
  return { listProperties: { nestingLevels: levels } };
}
/** The bullet preset closest to an existing list, to put a list back (undo) or re-nest it. */
export function presetOf(list: Json) {
  const l0 = list?.listProperties?.nestingLevels?.[0] ?? {};
  if (isCheckList(list)) return "BULLET_CHECKBOX";
  if (l0.glyphType && l0.glyphType !== "GLYPH_TYPE_UNSPECIFIED" && l0.glyphType !== "NONE") return l0.glyphType === "UPPER_ALPHA" ? "NUMBERED_UPPERALPHA_ALPHA_ROMAN" : l0.glyphType === "UPPER_ROMAN" ? "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL" : "NUMBERED_DECIMAL_ALPHA_ROMAN";
  return "BULLET_DISC_CIRCLE_SQUARE";
}
export const isCheckList = (list: Json) => {
  const l0 = list?.listProperties?.nestingLevels?.[0];
  return !!l0 && !l0.glyphSymbol && (!l0.glyphType || l0.glyphType === "GLYPH_TYPE_UNSPECIFIED");
};

const rangeOf = (r: Json) => [r.range?.startIndex ?? 0, r.range?.endIndex ?? 0] as [number, number];

/** Apply one request to the local copy. Only the LOCAL kinds; anything else waits for Google. */
export function applyReq(f: Flat, req: Req) {
  const kind = Object.keys(req)[0];
  const r = req[kind];
  const toks = f.toks;
  switch (kind) {
    case "insertText": {
      const i: number = r.location.index;
      const text: string = r.text;
      if (!text) return;
      const ts = styleAt(toks, i);
      const nl = newlineOf(toks, i);
      const add: Tok[] = [];
      for (const ch of text.split("")) {
        if (ch === "\n") add.push({ k: "n", ts, ps: nl?.ps ?? {}, ...(nl?.bullet ? { bullet: nl.bullet } : {}) });
        else add.push({ k: "c", ch, ts });
      }
      toks.splice(i, 0, ...add);
      return;
    }
    case "deleteContentRange": {
      const [s, e] = rangeOf(r);
      toks.splice(s, e - s);
      return;
    }
    case "updateTextStyle": {
      const [s, e] = rangeOf(r);
      const memo = new Map<TS, TS>();
      for (let i = s; i < e && i < toks.length; i++) {
        const t = toks[i];
        if (t.k === "c" || t.k === "n" || t.k === "io" || t.k === "pb") {
          let n = memo.get(t.ts);
          if (!n) memo.set(t.ts, (n = patch(t.ts, r.textStyle ?? {}, r.fields ?? "")));
          t.ts = n;
        }
      }
      return;
    }
    case "updateParagraphStyle": {
      const [s, e] = rangeOf(r);
      for (const [, pe] of parasIn(toks, s, e)) {
        const t = toks[pe - 1];
        if (t?.k === "n") t.ps = patch(t.ps, r.paragraphStyle ?? {}, r.fields ?? "");
      }
      return;
    }
    case "createParagraphBullets": {
      const [s, e] = rangeOf(r);
      const listId = `local.${++localList}`;
      f.lists = { ...f.lists, [listId]: presetLevels(r.bulletPreset ?? "") };
      const ps = parasIn(toks, s, e).reverse();
      for (const [a, b] of ps) {
        let tabs = 0;
        while (toks[a + tabs]?.k === "c" && (toks[a + tabs] as { ch: string }).ch === "\t") tabs++;
        const nl = toks[b - 1];
        if (nl?.k === "n") nl.bullet = { listId, nestingLevel: tabs };
        if (tabs) toks.splice(a, tabs);
      }
      return;
    }
    case "deleteParagraphBullets": {
      const [s, e] = rangeOf(r);
      for (const [, b] of parasIn(toks, s, e)) {
        const nl = toks[b - 1];
        if (nl?.k === "n" && nl.bullet) {
          delete nl.bullet;
        }
      }
      return;
    }
    default:
      throw new Error(`${kind} isn't applied locally`);
  }
}

const seg = (s: number, e: number) => ({ startIndex: s, endIndex: e });

/** The requests that undo `req`, worked out before it's applied; null when it can't be undone exactly. */
export function invert(f: Flat, req: Req): Req[] | null {
  const kind = Object.keys(req)[0];
  const r = req[kind];
  const toks = f.toks;
  switch (kind) {
    case "insertText":
      return [{ deleteContentRange: { range: seg(r.location.index, r.location.index + r.text.length) } }];
    case "deleteContentRange": {
      const [s, e] = rangeOf(r);
      const gone = toks.slice(s, e);
      if (gone.some((t) => t.k !== "c" && t.k !== "n")) return null;
      const out: Req[] = [{ insertText: { location: { index: s }, text: gone.map((t) => (t.k === "c" ? t.ch : "\n")).join("") } }];
      // Character styles, run by run.
      for (let a = 0; a < gone.length; ) {
        const ts = (gone[a] as { ts: TS }).ts;
        let b = a + 1;
        while (b < gone.length && (gone[b] as { ts: TS }).ts === ts) b++;
        out.push({ updateTextStyle: { range: seg(s + a, s + b), textStyle: ts, fields: "*" } });
        a = b;
      }
      // Paragraph styles and bullets of every paragraph the deletion touched.
      const after = newlineOf(toks, e);
      const nls: [number, Extract<Tok, { k: "n" }>][] = gone.flatMap((t, k) => (t.k === "n" ? [[s + k, t] as [number, Extract<Tok, { k: "n" }>]] : []));
      const [, pe] = paraAt(toks, e);
      if (after) nls.push([pe - 1, after]);
      for (const [at, nl] of nls) {
        out.push({ updateParagraphStyle: { range: seg(at, at + 1), paragraphStyle: pick(nl.ps, PS_ALL), fields: PS_ALL } });
        if (nl.bullet) out.push({ createParagraphBullets: { range: seg(at, at + 1), bulletPreset: presetOf(f.lists[nl.bullet.listId]) } });
      }
      // A merged paragraph that had no bullet must not keep one.
      if (nls.length > 1 && after?.bullet && nls.some(([, n]) => !n.bullet)) for (const [at, nl] of nls) if (!nl.bullet) out.push({ deleteParagraphBullets: { range: seg(at, at + 1) } });
      return out;
    }
    case "updateTextStyle": {
      const [s, e] = rangeOf(r);
      const out: Req[] = [];
      for (let a = s; a < e; ) {
        const t = toks[a] as { ts?: TS };
        let b = a + 1;
        while (b < e && (toks[b] as { ts?: TS }).ts === t.ts) b++;
        if (t.ts) out.push({ updateTextStyle: { range: seg(a, b), textStyle: pick(t.ts, r.fields), fields: r.fields } });
        a = b;
      }
      return out;
    }
    case "updateParagraphStyle": {
      const [s, e] = rangeOf(r);
      return parasIn(toks, s, e).map(([a, b]) => {
        const nl = toks[b - 1] as Extract<Tok, { k: "n" }>;
        return { updateParagraphStyle: { range: seg(a, b), paragraphStyle: pick(nl.ps ?? {}, r.fields), fields: r.fields } };
      });
    }
    case "createParagraphBullets": {
      const [s, e] = rangeOf(r);
      const ps = parasIn(toks, s, e);
      if (ps.some(([a]) => toks[a]?.k === "c" && (toks[a] as { ch: string }).ch === "\t")) return null;
      const out: Req[] = [{ deleteParagraphBullets: { range: r.range } }];
      for (const [a, b] of ps) {
        const nl = toks[b - 1] as Extract<Tok, { k: "n" }>;
        out.push({ updateParagraphStyle: { range: seg(a, b), paragraphStyle: pick(nl.ps, "indentStart,indentFirstLine"), fields: "indentStart,indentFirstLine" } });
        if (nl.bullet) out.push({ createParagraphBullets: { range: seg(a, b), bulletPreset: presetOf(f.lists[nl.bullet.listId]) } });
      }
      return out;
    }
    case "deleteParagraphBullets": {
      const [s, e] = rangeOf(r);
      const out: Req[] = [];
      for (const [a, b] of parasIn(toks, s, e)) {
        const nl = toks[b - 1] as Extract<Tok, { k: "n" }>;
        if (!nl.bullet) continue;
        out.push({ createParagraphBullets: { range: seg(a, b), bulletPreset: presetOf(f.lists[nl.bullet.listId]) } });
        out.push({ updateParagraphStyle: { range: seg(a, b), paragraphStyle: pick(nl.ps, "indentStart,indentFirstLine"), fields: "indentStart,indentFirstLine" } });
      }
      return out;
    }
  }
  return null;
}

// ── Others' changes: what changed between two copies, and moving our changes past it ──
const sigOf = (t: Tok) => (t.k === "c" ? t.ch : t.k === "n" ? "\n" : `\u0000${t.k}`);
/** The one region that differs between a and b: a[p, aEnd) became b[p, bEnd). Null when they're the same text. */
export function diffRegion(a: Tok[], b: Tok[]) {
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && sigOf(a[p]) === sigOf(b[p])) p++;
  if (p === a.length && p === b.length) return null;
  let sa = a.length;
  let sb = b.length;
  while (sa > p && sb > p && sigOf(a[sa - 1]) === sigOf(b[sb - 1])) (sa--, sb--);
  return { p, aEnd: sa, bEnd: sb };
}
export type Region = { p: number; aEnd: number; bEnd: number };
/** An index in a's terms, in b's terms; null if it was inside the changed region. */
export function mapIndex(i: number, g: Region | null, clamp = false) {
  if (!g) return i;
  if (i <= g.p) return i;
  if (i >= g.aEnd) return i + (g.bEnd - g.aEnd);
  return clamp ? g.p : null;
}

function reqRange(req: Req): [number, number] | null {
  const kind = Object.keys(req)[0];
  const r = req[kind];
  if (kind === "insertText") return [r.location.index, r.location.index];
  if (r?.range) return [r.range.startIndex, r.range.endIndex];
  return null;
}
function shift(req: Req, d: number): Req {
  const kind = Object.keys(req)[0];
  const r = req[kind];
  if (kind === "insertText") return { [kind]: { ...r, location: { ...r.location, index: r.location.index + d } } };
  return { [kind]: { ...r, range: { ...r.range, startIndex: r.range.startIndex + d, endIndex: r.range.endIndex + d } } };
}
/** How a request changes the length of the text before an index (for following the region). */
function growth(req: Req) {
  const kind = Object.keys(req)[0];
  const r = req[kind];
  if (kind === "insertText") return { at: r.location.index, by: r.text.length };
  if (kind === "deleteContentRange") return { at: r.range.startIndex, by: r.range.startIndex - r.range.endIndex };
  return null;
}

/**
 * Our requests (made against copy a) moved onto copy b, where someone else
 * changed one region. Requests wholly before or after it are kept (shifted);
 * the first one that touches it, and everything after, is dropped.
 */
export function rebase(reqs: Req[], g: Region | null): { reqs: Req[]; dropped: number } {
  if (!g) return { reqs, dropped: 0 };
  let { p, aEnd } = g;
  const delta = g.bEnd - g.aEnd;
  const out: Req[] = [];
  for (let k = 0; k < reqs.length; k++) {
    const req = reqs[k];
    const rr = reqRange(req);
    const kind = Object.keys(req)[0];
    if (!rr || !LOCAL.has(kind)) return { reqs: out, dropped: reqs.length - k };
    const [s, e] = rr;
    const before = e < p || (e === p && kind !== "insertText") || (kind === "insertText" && s <= p);
    const after = s >= aEnd;
    if (kind === "createParagraphBullets") return { reqs: out, dropped: reqs.length - k };
    if (before) {
      out.push(req);
      const gr = growth(req);
      if (gr && gr.at <= p) (p += gr.by, (aEnd += gr.by));
    } else if (after) out.push(shift(req, delta));
    else return { reqs: out, dropped: reqs.length - k };
  }
  return { reqs: out, dropped: 0 };
}

/** Number labels for list items, in document order: "1.", "a.", "●", or "check". */
export function listLabels(f: Flat, paras: { nl: Extract<Tok, { k: "n" }> }[]) {
  const counters = new Map<string, number[]>();
  const out: string[] = [];
  const roman = (n: number) => {
    const m: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let s = "";
    for (const [v, r] of m) while (n >= v) (s += r, (n -= v));
    return s;
  };
  const alpha = (n: number) => {
    let s = "";
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
    return s;
  };
  const fmt = (type: string, n: number) =>
    type === "ALPHA" ? alpha(n) : type === "UPPER_ALPHA" ? alpha(n).toUpperCase() : type === "ROMAN" ? roman(n) : type === "UPPER_ROMAN" ? roman(n).toUpperCase() : type === "ZERO_DECIMAL" ? String(n).padStart(2, "0") : String(n);
  for (const { nl } of paras) {
    const b = nl.bullet;
    if (!b) {
      out.push("");
      continue;
    }
    const list = f.lists[b.listId];
    const level = Math.min(8, b.nestingLevel ?? 0);
    const levels = list?.listProperties?.nestingLevels ?? [];
    const L = levels[level] ?? {};
    const c = counters.get(b.listId) ?? [];
    c[level] = (c[level] ?? (L.startNumber ?? 1) - 1) + 1;
    c.length = level + 1;
    counters.set(b.listId, c);
    if (isCheckList(list)) out.push("check");
    else if (L.glyphSymbol) out.push(L.glyphSymbol);
    else if (L.glyphType && L.glyphType !== "NONE" && L.glyphType !== "GLYPH_TYPE_UNSPECIFIED") {
      const format: string = L.glyphFormat ?? `%${level}.`;
      out.push(format.replace(/%(\d)/g, (_m: string, d: string) => fmt(levels[Number(d)]?.glyphType ?? "DECIMAL", c[Number(d)] ?? 1)));
    } else out.push(DISC[level % 3]);
  }
  return out;
}

// ── Colours and sizes ──
export function rgbOf(c: Json): string | undefined {
  const rgb = c?.color?.rgbColor ?? c?.rgbColor;
  if (!c?.color && !c?.rgbColor) return undefined;
  const h = (v?: number) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${h(rgb?.red)}${h(rgb?.green)}${h(rgb?.blue)}`;
}
export const pt = (d: Json) => (d && typeof d.magnitude === "number" ? d.magnitude : undefined);
export const PT_PX = 96 / 72;

export const HEADINGS = ["TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"];
export const STYLE_NAMES: Record<string, string> = {
  NORMAL_TEXT: "Normal text",
  TITLE: "Title",
  SUBTITLE: "Subtitle",
  HEADING_1: "Heading 1",
  HEADING_2: "Heading 2",
  HEADING_3: "Heading 3",
  HEADING_4: "Heading 4",
  HEADING_5: "Heading 5",
  HEADING_6: "Heading 6",
};
/** Google Docs' built-in look for each paragraph style, used when the document doesn't say. */
export const DEFAULT_NAMED: Record<string, { size: number; color?: string; bold?: boolean; italic?: boolean; above: number; below: number }> = {
  NORMAL_TEXT: { size: 11, above: 0, below: 0 },
  TITLE: { size: 26, above: 0, below: 3 },
  SUBTITLE: { size: 15, color: "#666666", above: 0, below: 16 },
  HEADING_1: { size: 20, above: 20, below: 6 },
  HEADING_2: { size: 16, above: 18, below: 6 },
  HEADING_3: { size: 14, color: "#434343", above: 16, below: 4 },
  HEADING_4: { size: 12, color: "#666666", above: 14, below: 4 },
  HEADING_5: { size: 11, color: "#666666", above: 12, below: 4 },
  HEADING_6: { size: 11, color: "#666666", italic: true, above: 12, below: 4 },
};
