/**
 * An in-memory Google Docs API document for the mock in google-sheets-mock.ts:
 * documents.get (body, headers, footers, lists, inline objects, named styles,
 * revisionId) and documents.batchUpdate with the requests the Docs editor
 * sends, all or nothing, with writeControl.requiredRevisionId. Indexes follow
 * Google's rules: a section break at 0, one index per UTF-16 unit, a newline
 * ending every paragraph, and one index for each table, row and cell start
 * and for the table end. It keeps its own copy as one token per index.
 */
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type DTok =
  | { k: "c"; ch: string; ts: Json; sug?: "i" | "d" }
  | { k: "n"; ts: Json; ps: Json; bullet?: Json }
  | { k: "io"; id: string; ts: Json }
  | { k: "pb"; ts: Json }
  | { k: "fn"; n: number }
  | { k: "sb" }
  | { k: "ts"; cols: number }
  | { k: "rs" }
  | { k: "cs" }
  | { k: "te" };

export class DocsError extends Error {
  constructor(
    message: string,
    readonly status = "INVALID_ARGUMENT",
  ) {
    super(message);
  }
}

const same = (a: Json, b: Json) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
const textual = (t?: DTok) => !!t && (t.k === "c" || t.k === "n" || t.k === "io" || t.k === "pb" || t.k === "fn");
const LEVELS = (preset: string) =>
  Array.from({ length: 9 }, (_, i) => {
    const base = { bulletAlignment: "START", indentFirstLine: { magnitude: 18 + 36 * i, unit: "PT" }, indentStart: { magnitude: 36 + 36 * i, unit: "PT" }, textStyle: { underline: false }, startNumber: 1 };
    if (preset.startsWith("NUMBERED")) return { ...base, glyphType: ["DECIMAL", "ALPHA", "ROMAN"][i % 3], glyphFormat: `%${i}.` };
    if (preset === "BULLET_CHECKBOX") return { ...base, glyphType: "GLYPH_TYPE_UNSPECIFIED" };
    return { ...base, glyphSymbol: ["●", "○", "■"][i % 3], glyphFormat: `%${i}` };
  });

/** Paragraph helpers for seeding documents. */
export function para(text: string, opts: { ts?: Json; ps?: Json; bullet?: Json; runs?: [string, Json][] } = {}): DTok[] {
  const out: DTok[] = [];
  for (const [t, ts] of opts.runs ?? [[text, opts.ts ?? {}]]) for (const ch of t.split("")) out.push({ k: "c", ch, ts: ts ?? {} });
  out.push({ k: "n", ts: opts.ts ?? {}, ps: { namedStyleType: "NORMAL_TEXT", ...(opts.ps ?? {}) }, ...(opts.bullet ? { bullet: opts.bullet } : {}) });
  return out;
}
export function table(rows: string[][]): DTok[] {
  const out: DTok[] = [{ k: "ts", cols: rows[0]?.length ?? 1 }];
  for (const r of rows) {
    out.push({ k: "rs" });
    for (const c of r) out.push({ k: "cs" }, ...para(c));
  }
  out.push({ k: "te" });
  return out;
}

export class MockDoc {
  rev = 1;
  toks: DTok[];
  lists: Record<string, Json> = {};
  inline: Record<string, Json> = {};
  headers: Record<string, DTok[]> = {};
  footers: Record<string, DTok[]> = {};
  docStyle: Json = { pageSize: { width: { magnitude: 612, unit: "PT" }, height: { magnitude: 792, unit: "PT" } }, marginTop: { magnitude: 72, unit: "PT" }, marginBottom: { magnitude: 72, unit: "PT" }, marginLeft: { magnitude: 72, unit: "PT" }, marginRight: { magnitude: 72, unit: "PT" }, marginHeader: { magnitude: 36, unit: "PT" }, marginFooter: { magnitude: 36, unit: "PT" } };
  private n = 0;

  constructor(
    readonly id: string,
    public title: string,
    body: DTok[] = para(""),
    readonly base = "http://127.0.0.1:4799",
  ) {
    this.toks = [{ k: "sb" }, ...body];
  }
  clone(id: string, title: string) {
    const d = new MockDoc(id, title, [], this.base);
    Object.assign(d, structuredClone({ toks: this.toks, lists: this.lists, inline: this.inline, headers: this.headers, footers: this.footers, docStyle: this.docStyle }));
    return d;
  }
  get revisionId() {
    return `rev-${this.id}-${this.rev}`;
  }
  /** The body's plain text (for tests). */
  text(from = 0, to = this.toks.length) {
    return this.toks
      .slice(from, to)
      .map((t) => (t.k === "c" ? t.ch : t.k === "n" ? "\n" : ""))
      .join("");
  }
  indexOf(s: string, from = 0) {
    // Positions of text in the body, as Google indexes.
    const flat = this.toks.map((t) => (t.k === "c" ? t.ch : t.k === "n" ? "\n" : "\u0000")).join("");
    return flat.indexOf(s, from);
  }

  // ── documents.get ──
  get(): Json {
    return {
      documentId: this.id,
      title: this.title,
      revisionId: this.revisionId,
      suggestionsViewMode: "SUGGESTIONS_INLINE",
      body: { content: this.content(this.toks, 0, this.toks.length) },
      headers: Object.fromEntries(Object.entries(this.headers).map(([id, t]) => [id, { headerId: id, content: this.content(t, 0, t.length) }])),
      footers: Object.fromEntries(Object.entries(this.footers).map(([id, t]) => [id, { footerId: id, content: this.content(t, 0, t.length) }])),
      documentStyle: this.docStyle,
      namedStyles: {
        styles: [
          { namedStyleType: "NORMAL_TEXT", textStyle: { fontSize: { magnitude: 11, unit: "PT" }, weightedFontFamily: { fontFamily: "Arial", weight: 400 } }, paragraphStyle: { namedStyleType: "NORMAL_TEXT", lineSpacing: 115, alignment: "START" } },
          { namedStyleType: "TITLE", textStyle: { fontSize: { magnitude: 26, unit: "PT" } }, paragraphStyle: { namedStyleType: "TITLE", spaceBelow: { magnitude: 3, unit: "PT" } } },
          { namedStyleType: "HEADING_1", textStyle: { fontSize: { magnitude: 20, unit: "PT" } }, paragraphStyle: { namedStyleType: "HEADING_1", spaceAbove: { magnitude: 20, unit: "PT" }, spaceBelow: { magnitude: 6, unit: "PT" } } },
          { namedStyleType: "HEADING_2", textStyle: { fontSize: { magnitude: 16, unit: "PT" } }, paragraphStyle: { namedStyleType: "HEADING_2", spaceAbove: { magnitude: 18, unit: "PT" }, spaceBelow: { magnitude: 6, unit: "PT" } } },
        ],
      },
      lists: this.lists,
      inlineObjects: this.inline,
    };
  }

  private content(t: DTok[], from: number, to: number): Json[] {
    const out: Json[] = [];
    let i = from;
    while (i < to) {
      const tk = t[i];
      if (tk.k === "sb") {
        out.push({ endIndex: i + 1, sectionBreak: { sectionStyle: { columnSeparatorStyle: "NONE", contentDirection: "LEFT_TO_RIGHT", sectionType: "CONTINUOUS" } }, ...(i ? { startIndex: i } : {}) });
        i++;
      } else if (tk.k === "ts") {
        const end = this.tableEnd(t, i);
        const rows: Json[] = [];
        for (const r of this.rowsOf(t, i)) {
          rows.push({
            startIndex: r.start,
            endIndex: r.cells[r.cells.length - 1].end,
            tableCells: r.cells.map((c) => ({ startIndex: c.start, endIndex: c.end, content: this.content(t, c.start + 1, c.end), tableCellStyle: { rowSpan: 1, columnSpan: 1, contentAlignment: "TOP" } })),
          });
        }
        out.push({ startIndex: i, endIndex: end + 1, table: { rows: rows.length, columns: tk.cols, tableRows: rows, tableStyle: { tableColumnProperties: Array.from({ length: tk.cols }, () => ({ widthType: "EVENLY_DISTRIBUTED" })) } } });
        i = end + 1;
      } else {
        let j = i;
        while (j < to && t[j].k !== "n") j++;
        const nl = t[j] as Extract<DTok, { k: "n" }>;
        const elements: Json[] = [];
        let a = i;
        while (a <= j) {
          const x = t[a];
          if (x.k === "c" || x.k === "n") {
            let b = a + 1;
            const sg = x.k === "c" ? x.sug : undefined;
            while (b <= j && (t[b].k === "c" || t[b].k === "n") && same((t[b] as Json).ts, x.ts) && (t[b] as Json).sug === sg) b++;
            const content = t
              .slice(a, b)
              .map((y) => (y.k === "c" ? y.ch : "\n"))
              .join("");
            elements.push({ startIndex: a, endIndex: b, textRun: { content, textStyle: x.ts, ...(sg === "i" ? { suggestedInsertionIds: ["suggest.1"] } : sg === "d" ? { suggestedDeletionIds: ["suggest.2"] } : {}) } });
            a = b;
          } else if (x.k === "io") elements.push({ startIndex: a, endIndex: ++a, inlineObjectElement: { inlineObjectId: x.id, textStyle: x.ts } });
          else if (x.k === "pb") elements.push({ startIndex: a, endIndex: ++a, pageBreak: { textStyle: x.ts } });
          else if (x.k === "fn") elements.push({ startIndex: a, endIndex: ++a, footnoteReference: { footnoteId: `fn${x.n}`, footnoteNumber: String(x.n), textStyle: {} } });
          else throw new Error(`bad token ${x.k} in a paragraph at ${a}`);
        }
        out.push({ startIndex: i, endIndex: j + 1, paragraph: { elements, paragraphStyle: { direction: "LEFT_TO_RIGHT", ...nl.ps, namedStyleType: nl.ps?.namedStyleType ?? "NORMAL_TEXT" }, ...(nl.bullet ? { bullet: nl.bullet } : {}) } });
        i = j + 1;
      }
    }
    return out;
  }
  private tableEnd(t: DTok[], i: number) {
    let d = 0;
    for (let j = i; j < t.length; j++) {
      if (t[j].k === "ts") d++;
      else if (t[j].k === "te" && --d === 0) return j;
    }
    throw new DocsError("broken table");
  }
  /** Rows and cells of the table at i: cell start index and end (exclusive, = next marker). */
  private rowsOf(t: DTok[], i: number) {
    const end = this.tableEnd(t, i);
    const rows: { start: number; cells: { start: number; end: number }[] }[] = [];
    let d = 0;
    for (let j = i + 1; j <= end; j++) {
      const k = t[j].k;
      if (d === 0 && (k === "rs" || k === "cs" || j === end)) {
        const r = rows[rows.length - 1];
        const c = r?.cells[r.cells.length - 1];
        if (c && c.end < 0) c.end = j;
        if (k === "rs") rows.push({ start: j, cells: [] });
        if (k === "cs") rows[rows.length - 1].cells.push({ start: j, end: -1 });
      }
      if (j < end && k === "ts") d++;
      if (j < end && k === "te") d--;
    }
    return rows;
  }

  // ── documents.batchUpdate ──
  batch(requests: Json[], writeControl?: Json) {
    if (writeControl?.requiredRevisionId && writeControl.requiredRevisionId !== this.revisionId) throw new DocsError("The required revision ID does not match the latest revision of the document.", "FAILED_PRECONDITION");
    const backup = structuredClone({ toks: this.toks, lists: this.lists, inline: this.inline, n: this.n });
    try {
      const replies = requests.map((r) => this.apply(r));
      this.rev++;
      return { documentId: this.id, replies, writeControl: { requiredRevisionId: this.revisionId } };
    } catch (e) {
      Object.assign(this, backup);
      throw e;
    }
  }

  private paraOf(i: number): [number, number] {
    const t = this.toks;
    let s = i;
    while (s > 0 && textual(t[s - 1]) && t[s - 1].k !== "n") s--;
    let e = i;
    while (e < t.length && t[e].k !== "n") {
      if (!textual(t[e])) throw new DocsError(`Index ${i} isn't inside a paragraph.`);
      e++;
    }
    return [s, e + 1];
  }
  private parasOverlapping(s: number, e: number) {
    const out: [number, number][] = [];
    for (let i = s; i < Math.max(e, s + 1) && i < this.toks.length; ) {
      if (!textual(this.toks[i])) {
        i++;
        continue;
      }
      const p = this.paraOf(i);
      out.push(p);
      i = p[1];
    }
    return out;
  }
  private checkInsertAt(i: number) {
    if (i < 1 || i >= this.toks.length || !textual(this.toks[i])) throw new DocsError(`The insertion index must be inside the bounds of an existing paragraph. You can still create new paragraphs by inserting newlines. (index ${i})`);
  }
  private rangeOf(r: Json): [number, number] {
    const s = r.range?.startIndex;
    const e = r.range?.endIndex;
    if (typeof s !== "number" || typeof e !== "number" || s >= e || s < 0 || e > this.toks.length) throw new DocsError(`Invalid range ${s}-${e}.`);
    if (r.range?.segmentId) throw new DocsError("Only the body is editable in this mock.");
    return [s, e];
  }
  private fields(obj: Json, style: Json, fields: string) {
    if (!fields) throw new DocsError("fields is required");
    if (fields.trim() === "*") return { ...style };
    const out = { ...obj };
    for (const f of fields.split(",").map((x) => x.trim())) {
      const top = f.split(".")[0];
      if (style?.[top] !== undefined) out[top] = style[top];
      else delete out[top];
    }
    return out;
  }

  private apply(req: Json): Json {
    const kind = Object.keys(req)[0];
    const r = req[kind];
    const t = this.toks;
    switch (kind) {
      case "insertText": {
        const i = r.location?.index ?? (r.endOfSegmentLocation ? t.length - 1 : undefined);
        this.checkInsertAt(i);
        const prev = t[i - 1];
        const ts = prev && (prev.k === "c" || prev.k === "io" || prev.k === "pb") ? prev.ts : (t[i] as Json).ts ?? {};
        const [, pe] = this.paraOf(i);
        const nl = t[pe - 1] as Extract<DTok, { k: "n" }>;
        const add: DTok[] = String(r.text)
          .split("")
          .map((ch) => (ch === "\n" ? { k: "n" as const, ts, ps: structuredClone(nl.ps), ...(nl.bullet ? { bullet: structuredClone(nl.bullet) } : {}) } : { k: "c" as const, ch, ts }));
        t.splice(i, 0, ...add);
        return {};
      }
      case "deleteContentRange": {
        const [s, e] = this.rangeOf(r);
        if (s < 1) throw new DocsError("Invalid deletion range. Cannot delete the section break at the start of the document.");
        if (e >= t.length) throw new DocsError("Invalid deletion range. Cannot delete the last newline character of the body.");
        for (let i = s; i < e; i++) {
          const k = t[i].k;
          if (k === "ts") {
            const te = this.tableEnd(t, i);
            if (te >= e) throw new DocsError("Invalid deletion range. Cannot delete part of a table.");
            i = te;
          } else if (k === "rs" || k === "cs" || k === "te" || k === "sb") throw new DocsError("Invalid deletion range. Cannot delete the requested range.");
          else if (k === "n" && ["cs", "rs", "te"].includes(t[i + 1]?.k)) throw new DocsError("Invalid deletion range. Cannot delete the last newline in a table cell.");
          else if ((t[i] as Json).sug) throw new DocsError("Cannot delete text in a suggestion here.");
        }
        if (t[e - 1].k === "n" && t[e]?.k === "ts") throw new DocsError("Invalid deletion range. Cannot delete the newline before a table.");
        t.splice(s, e - s);
        return {};
      }
      case "updateTextStyle": {
        const [s, e] = this.rangeOf(r);
        for (let i = s; i < e; i++) {
          const x = t[i] as Json;
          if (x.ts !== undefined) x.ts = this.fields(x.ts, r.textStyle ?? {}, r.fields);
        }
        return {};
      }
      case "updateParagraphStyle": {
        const [s, e] = this.rangeOf(r);
        for (const [, b] of this.parasOverlapping(s, e)) {
          const nl = t[b - 1] as Extract<DTok, { k: "n" }>;
          nl.ps = this.fields(nl.ps, r.paragraphStyle ?? {}, r.fields);
          if (!nl.ps.namedStyleType) nl.ps.namedStyleType = "NORMAL_TEXT";
        }
        return {};
      }
      case "createParagraphBullets": {
        const [s, e] = this.rangeOf(r);
        if (!r.bulletPreset) throw new DocsError("bulletPreset is required");
        const listId = `kix.list${++this.n}`;
        this.lists[listId] = { listProperties: { nestingLevels: LEVELS(r.bulletPreset) } };
        for (const [a, b] of this.parasOverlapping(s, e).reverse()) {
          let tabs = 0;
          while (t[a + tabs]?.k === "c" && (t[a + tabs] as Json).ch === "\t") tabs++;
          (t[b - 1] as Json).bullet = { listId, nestingLevel: tabs, textStyle: { underline: false } };
          if (tabs) t.splice(a, tabs);
        }
        return {};
      }
      case "deleteParagraphBullets": {
        const [s, e] = this.rangeOf(r);
        for (const [, b] of this.parasOverlapping(s, e)) delete (t[b - 1] as Json).bullet;
        return {};
      }
      case "insertTable": {
        const i = r.location?.index ?? t.length - 1;
        this.checkInsertAt(i);
        const rows = Number(r.rows);
        const cols = Number(r.columns);
        if (!(rows >= 1 && rows <= 20 && cols >= 1 && cols <= 20)) throw new DocsError("Tables need 1 to 20 rows and columns.");
        const [, pe] = this.paraOf(i);
        const nl = t[pe - 1] as Extract<DTok, { k: "n" }>;
        const ts = (t[i - 1] as Json)?.ts ?? (t[i] as Json).ts ?? {};
        const tbl = table(Array.from({ length: rows }, () => Array.from({ length: cols }, () => "")));
        t.splice(i, 0, { k: "n", ts, ps: structuredClone(nl.ps) }, ...tbl);
        return {};
      }
      case "insertTableRow":
      case "insertTableColumn":
      case "deleteTableRow":
      case "deleteTableColumn": {
        const loc = r.tableCellLocation;
        const ti = loc?.tableStartLocation?.index;
        if (t[ti]?.k !== "ts") throw new DocsError(`No table starts at index ${ti}.`);
        const end = this.tableEnd(t, ti);
        const rows = this.rowsOf(t, ti).map((row) => row.cells.map((c) => t.slice(c.start + 1, c.end)));
        const ri = loc.rowIndex ?? 0;
        const ci = loc.columnIndex ?? 0;
        if (!rows[ri] || !rows[ri][ci]) throw new DocsError("That cell doesn't exist.");
        const empty = () => para("");
        if (kind === "insertTableRow") rows.splice(r.insertBelow ? ri + 1 : ri, 0, rows[ri].map(empty));
        if (kind === "insertTableColumn") for (const row of rows) row.splice(r.insertRight ? ci + 1 : ci, 0, empty());
        if (kind === "deleteTableRow") {
          if (rows.length === 1) throw new DocsError("Can't delete the only row; delete the table instead.");
          rows.splice(ri, 1);
        }
        if (kind === "deleteTableColumn") {
          if (rows[0].length === 1) throw new DocsError("Can't delete the only column; delete the table instead.");
          for (const row of rows) row.splice(ci, 1);
        }
        const out: DTok[] = [{ k: "ts", cols: rows[0].length }];
        for (const row of rows) {
          out.push({ k: "rs" });
          for (const c of row) out.push({ k: "cs" }, ...c);
        }
        out.push({ k: "te" });
        t.splice(ti, end - ti + 1, ...out);
        return {};
      }
      case "insertInlineImage": {
        const i = r.location?.index ?? t.length - 1;
        this.checkInsertAt(i);
        if (!/^https:\/\//.test(r.uri ?? "")) throw new DocsError("Invalid requests[0].insertInlineImage: The provided image is in an unsupported format or the URL is not publicly reachable.");
        const id = `kix.img${++this.n}`;
        const w = r.objectSize?.width?.magnitude ?? 240;
        const h = r.objectSize?.height?.magnitude ?? Math.round(w * 0.6);
        this.inline[id] = { objectId: id, inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: `${this.base}/img/${id}.svg`, sourceUri: r.uri }, size: { width: { magnitude: w, unit: "PT" }, height: { magnitude: h, unit: "PT" } } } } };
        const prev = t[i - 1] as Json;
        t.splice(i, 0, { k: "io", id, ts: prev && prev.k !== "n" && prev.ts ? prev.ts : {} });
        return { insertInlineImage: { objectId: id } };
      }
      case "insertPageBreak": {
        const i = r.location?.index ?? t.length - 1;
        this.checkInsertAt(i);
        // Not inside a table.
        let d = 0;
        for (let j = 0; j < i; j++) (t[j].k === "ts" ? d++ : t[j].k === "te" ? d-- : 0);
        if (d > 0) throw new DocsError("Page breaks can't be inserted inside a table.");
        const [, pe] = this.paraOf(i);
        const nl = t[pe - 1] as Extract<DTok, { k: "n" }>;
        t.splice(i, 0, { k: "pb", ts: {} }, { k: "n", ts: {}, ps: structuredClone(nl.ps) });
        return {};
      }
      case "replaceAllText": {
        const find: string = r.containsText?.text ?? "";
        const mc = !!r.containsText?.matchCase;
        if (!find) throw new DocsError("containsText.text is required");
        let count = 0;
        const flat = t.map((x) => (x.k === "c" ? x.ch : "\u0000")).join("");
        const hay = mc ? flat : flat.toLowerCase();
        const needle = mc ? find : find.toLowerCase();
        const hits: number[] = [];
        for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) hits.push(i);
        for (const at of hits.reverse()) {
          const ts = (t[at] as Json).ts;
          t.splice(at, find.length, ...String(r.replaceText ?? "").split("").map((ch) => ({ k: "c" as const, ch, ts })));
          count++;
        }
        return { replaceAllText: { occurrencesChanged: count } };
      }
      default:
        throw new DocsError(`Invalid requests: unknown request ${kind}`);
    }
  }
}

/** A demo document with every kind of content the editor shows. */
export function demoDoc(id = "docdemo", base = "http://127.0.0.1:4799") {
  const b = (text: string) => [text, { bold: true }] as [string, Json];
  const body: DTok[] = [
    ...para("Plant operations handbook", { ps: { namedStyleType: "TITLE" } }),
    ...para("Version 3, October 2026", { ps: { namedStyleType: "SUBTITLE" } }),
    ...para("Purpose", { ps: { namedStyleType: "HEADING_1", headingId: "h.purpose" } }),
    ...para("", {
      runs: [
        ["This handbook explains how the ", {}],
        b("Ludhiana plant"),
        [" runs day to day: shifts, safety, quality checks and dispatch. See the ", {}],
        ["safety portal", { link: { url: "https://example.com/safety" }, underline: true, foregroundColor: { color: { rgbColor: { red: 0.067, green: 0.333, blue: 0.8 } } } }],
        [" for the latest rules.", {}],
      ],
    }),
    ...para("Shifts", { ps: { namedStyleType: "HEADING_2", headingId: "h.shifts" } }),
    ...para("Morning shift: 6:00 to 14:00", { bullet: { listId: "kix.bul", nestingLevel: 0 } }),
    ...para("Evening shift: 14:00 to 22:00", { bullet: { listId: "kix.bul", nestingLevel: 0 } }),
    ...para("Night shift on request", { bullet: { listId: "kix.bul", nestingLevel: 1 } }),
    ...para("Daily checks", { ps: { namedStyleType: "HEADING_2", headingId: "h.checks" } }),
    ...para("Check the furnace temperature log.", { bullet: { listId: "kix.num", nestingLevel: 0 } }),
    ...para("Record coil weights before dispatch.", { bullet: { listId: "kix.num", nestingLevel: 0 } }),
    ...para("Sign the shift register.", { bullet: { listId: "kix.num", nestingLevel: 0 } }),
    ...para("Contacts", { ps: { namedStyleType: "HEADING_1", headingId: "h.contacts" } }),
    ...table([
      ["Role", "Name", "Extension"],
      ["Plant head", "R. Mehta", "101"],
      ["Safety officer", "S. Kaur", "204"],
    ]),
    ...para("", { runs: [["Last reviewed by the safety committee", {}]] }),
    ...para("Text in italic, ", { runs: [["Text in ", {}], ["italic", { italic: true }], [", ", {}], ["highlighted", { backgroundColor: { color: { rgbColor: { red: 1, green: 0.95, blue: 0.4 } } } }], [" and ", {}], ["red", { foregroundColor: { color: { rgbColor: { red: 0.85, green: 0.19, blue: 0.15 } } } }], [".", {}]] }),
  ];
  const d = new MockDoc(id, "Plant operations handbook (demo)", body, base);
  d.lists["kix.bul"] = { listProperties: { nestingLevels: LEVELS("BULLET_DISC_CIRCLE_SQUARE") } };
  d.lists["kix.num"] = { listProperties: { nestingLevels: LEVELS("NUMBERED_DECIMAL_ALPHA_ROMAN") } };
  // A suggestion (shown, not editable) and a footnote, after "the safety committee".
  const at = d.indexOf("committee") + "committee".length;
  d.toks.splice(at, 0, ..." (suggested: and the plant head)".split("").map((ch) => ({ k: "c" as const, ch, ts: {}, sug: "i" as const })), { k: "fn", n: 1 });
  // An image and a page break.
  const p = d.indexOf("Contacts");
  d.toks.splice(p, 0, { k: "io", id: "kix.logo", ts: {} }, { k: "n", ts: {}, ps: { namedStyleType: "NORMAL_TEXT", alignment: "CENTER" } }, { k: "pb", ts: {} }, { k: "n", ts: {}, ps: { namedStyleType: "NORMAL_TEXT" } });
  d.inline["kix.logo"] = { objectId: "kix.logo", inlineObjectProperties: { embeddedObject: { title: "Plant layout", imageProperties: { contentUri: `${base}/img/kix.logo.svg` }, size: { width: { magnitude: 300, unit: "PT" }, height: { magnitude: 140, unit: "PT" } } } } };
  d.headers["kix.hdr"] = para("IOTx demo · Plant operations handbook", { ps: { alignment: "END" }, ts: { foregroundColor: { color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } } }, fontSize: { magnitude: 9, unit: "PT" } } });
  d.footers["kix.ftr"] = para("Internal use only", { ps: { alignment: "CENTER" }, ts: { fontSize: { magnitude: 9, unit: "PT" } } });
  d.docStyle.defaultHeaderId = "kix.hdr";
  d.docStyle.defaultFooterId = "kix.ftr";
  return d;
}

/** A small SVG picture for the mock's image and thumbnail URLs. */
export function mockSvg(label: string, w = 600, h = 280, color = "#c9daf8") {
  const esc = label.replace(/[<>&]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${color}"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="none" stroke="#4a86e8" stroke-width="4" stroke-dasharray="12 8"/><text x="50%" y="52%" font-family="Arial" font-size="${Math.round(h / 9)}" fill="#1c4587" text-anchor="middle">${esc}</text></svg>`;
}
