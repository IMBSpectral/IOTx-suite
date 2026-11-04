/**
 * An in-memory Google Slides API presentation for the mock in
 * google-sheets-mock.ts: presentations.get (slides, layouts, masters, notes
 * pages, revisionId), presentations.batchUpdate with the requests the Slides
 * editor sends (all or nothing, writeControl.requiredRevisionId), and
 * pages.getThumbnail (a picture of the slide drawn from its elements, counted
 * so tests can check the quota-saving cache). Sizes are in EMU.
 */
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class SlidesError extends Error {
  constructor(
    message: string,
    readonly status = "INVALID_ARGUMENT",
  ) {
    super(message);
  }
}

export const W = 9144000;
export const H = 5143500;
const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const solid = (hex: string) => ({ solidFill: { color: { rgbColor: rgb(hex) }, alpha: 1 } });
const tf = (x: number, y: number, sx = 1, sy = 1) => ({ scaleX: sx, scaleY: sy, translateX: x, translateY: y, unit: "EMU" });
const sz = (w: number, h: number) => ({ width: { magnitude: w, unit: "EMU" }, height: { magnitude: h, unit: "EMU" } });

// ── Text: Google's textElements <-> one character per index ──
type Ch = { ch: string; st: Json };
type Flat = { chars: Ch[]; paras: { style: Json; bullet?: Json }[] };
export function toFlat(text: Json): Flat {
  const out: Flat = { chars: [], paras: [] };
  for (const te of text?.textElements ?? []) {
    if (te.paragraphMarker) out.paras.push({ style: te.paragraphMarker.style ?? {}, ...(te.paragraphMarker.bullet ? { bullet: te.paragraphMarker.bullet } : {}) });
    const run = te.textRun ?? te.autoText;
    if (run) for (const ch of String(run.content ?? "").split("")) out.chars.push({ ch, st: run.style ?? {} });
  }
  return out;
}
export function fromFlat(f: Flat): Json {
  if (!f.chars.length) return undefined;
  const els: Json[] = [];
  let a = 0;
  let k = 0;
  while (a < f.chars.length) {
    let b = a;
    while (b < f.chars.length && f.chars[b].ch !== "\n") b++;
    b = Math.min(f.chars.length, b + 1);
    const p = f.paras[k] ?? { style: {} };
    els.push({ ...(a ? { startIndex: a } : {}), endIndex: b, paragraphMarker: { style: p.style ?? {}, ...(p.bullet ? { bullet: p.bullet } : {}) } });
    for (let x = a; x < b; ) {
      let y = x + 1;
      while (y < b && JSON.stringify(f.chars[y].st) === JSON.stringify(f.chars[x].st)) y++;
      els.push({ ...(x ? { startIndex: x } : {}), endIndex: y, textRun: { content: f.chars.slice(x, y).map((c) => c.ch).join(""), style: f.chars[x].st } });
      x = y;
    }
    a = b;
    k++;
  }
  return { textElements: els };
}
export const plain = (text: Json) => toFlat(text).chars.map((c) => c.ch).join("");
/** Text for a seed: paragraphs (split on \n), each one run with a style. */
export function seedText(s: string, st: Json = {}, pstyle: Json = {}) {
  const lines = s.split("\n");
  return fromFlat({ chars: (s + "\n").split("").map((ch) => ({ ch, st })), paras: lines.map(() => ({ style: { ...pstyle } })) });
}

function patch(obj: Json, style: Json, fields: string) {
  if (!fields) throw new SlidesError("fields is required");
  if (fields.trim() === "*") return structuredClone(style ?? {});
  const out = structuredClone(obj ?? {});
  for (const path of fields.split(",").map((x) => x.trim())) {
    const parts = path.split(".");
    let src = style;
    for (const p of parts) src = src?.[p];
    let dst = out;
    for (const p of parts.slice(0, -1)) dst = dst[p] ??= {};
    if (src === undefined) delete dst[parts[parts.length - 1]];
    else dst[parts[parts.length - 1]] = structuredClone(src);
  }
  return out;
}

export class MockDeck {
  rev = 1;
  thumbCalls = 0;
  p: Json;
  private n = 0;
  constructor(
    readonly id: string,
    title: string,
    readonly base = "http://127.0.0.1:4799",
  ) {
    const master = {
      objectId: "m1",
      pageType: "MASTER",
      pageElements: [],
      pageProperties: {
        pageBackgroundFill: solid("#ffffff"),
        colorScheme: {
          colors: [
            ["DARK1", "#000000"],
            ["LIGHT1", "#ffffff"],
            ["DARK2", "#1c4587"],
            ["LIGHT2", "#eeeeee"],
            ["ACCENT1", "#4285f4"],
            ["ACCENT2", "#ea4335"],
            ["ACCENT3", "#fbbc04"],
            ["ACCENT4", "#34a853"],
            ["ACCENT5", "#ff6d01"],
            ["ACCENT6", "#46bdc6"],
            ["HYPERLINK", "#1155cc"],
          ].map(([type, hex]) => ({ type, color: rgb(hex) })),
        },
      },
      masterProperties: { displayName: "Simple Light" },
    };
    const ph = (lid: string, type: string, x: number, y: number, w: number, h: number, size: number, extra: Json = {}) => ({
      objectId: `${lid}_${type.toLowerCase()}`,
      size: sz(w, h),
      transform: tf(x, y),
      shape: { shapeType: "TEXT_BOX", placeholder: { type, index: 0 }, shapeProperties: { contentAlignment: type.includes("TITLE") ? "MIDDLE" : "TOP" }, text: seedText(" ", { fontSize: { magnitude: size, unit: "PT" }, fontFamily: "Arial", ...extra }) },
    });
    const layouts = [
      { objectId: "l_title", pageType: "LAYOUT", layoutProperties: { name: "TITLE", displayName: "Title slide", masterObjectId: "m1" }, pageElements: [ph("l_title", "CENTERED_TITLE", 311700, 744575, 8520600, 2052600, 44), ph("l_title", "SUBTITLE", 311700, 2834125, 8520600, 792600, 22)] },
      { objectId: "l_tb", pageType: "LAYOUT", layoutProperties: { name: "TITLE_AND_BODY", displayName: "Title and body", masterObjectId: "m1" }, pageElements: [ph("l_tb", "TITLE", 311700, 445025, 8520600, 572700, 30), ph("l_tb", "BODY", 311700, 1152475, 8520600, 3416400, 18)] },
      { objectId: "l_section", pageType: "LAYOUT", layoutProperties: { name: "SECTION_HEADER", displayName: "Section header", masterObjectId: "m1" }, pageElements: [ph("l_section", "TITLE", 311700, 2150850, 8520600, 841800, 36)] },
      { objectId: "l_blank", pageType: "LAYOUT", layoutProperties: { name: "BLANK", displayName: "Blank", masterObjectId: "m1" }, pageElements: [] },
    ];
    // Placeholders on layouts carry the look; their text is only there to give styles.
    for (const l of layouts) for (const e of l.pageElements) (e.shape.placeholder as Json).parentObjectId = undefined;
    this.p = { presentationId: id, title, locale: "en", pageSize: sz(W, H), slides: [], layouts, masters: [master] };
  }
  get revisionId() {
    return `srev-${this.id}-${this.rev}`;
  }
  clone(id: string, title: string) {
    const d = new MockDeck(id, title, this.base);
    d.p = { ...structuredClone(this.p), presentationId: id, title };
    return d;
  }
  get() {
    return { ...structuredClone(this.p), revisionId: this.revisionId };
  }
  gen(prefix = "g") {
    return `${prefix}_mock${++this.n}`;
  }

  // ── Finding things ──
  slide(id: string) {
    return this.p.slides.find((s: Json) => s.objectId === id);
  }
  /** An element anywhere: slides, notes pages and inside groups. */
  find(id: string): { el: Json; list: Json[]; page: Json } | null {
    const pages = [...this.p.slides, ...this.p.slides.map((s: Json) => s.slideProperties?.notesPage).filter(Boolean)];
    const look = (list: Json[], page: Json): { el: Json; list: Json[]; page: Json } | null => {
      for (const el of list ?? []) {
        if (el.objectId === id) return { el, list, page };
        if (el.elementGroup) {
          const r = look(el.elementGroup.children, page);
          if (r) return r;
        }
      }
      return null;
    };
    for (const pg of pages) {
      const r = look(pg.pageElements, pg);
      if (r) return r;
    }
    return null;
  }
  private textHolder(r: Json) {
    const f = this.find(r.objectId);
    if (!f) throw new SlidesError(`The object (${r.objectId}) could not be found.`);
    if (r.cellLocation) {
      const cell = f.el.table?.tableRows?.[r.cellLocation.rowIndex ?? 0]?.tableCells?.[r.cellLocation.columnIndex ?? 0];
      if (!cell) throw new SlidesError("The table cell could not be found.");
      return cell;
    }
    if (!f.el.shape) throw new SlidesError(`The object (${r.objectId}) doesn't hold text.`);
    return f.el.shape;
  }
  private span(r: Json, len: number): [number, number] {
    const t = r.textRange ?? { type: "ALL" };
    if (t.type === "ALL") return [0, len];
    const s = t.startIndex ?? 0;
    const e = t.type === "FROM_START_INDEX" ? len : t.endIndex;
    if (s < 0 || e > len || s > e) throw new SlidesError(`The text range ${s}-${e} is out of bounds (length ${len}).`);
    return [s, e];
  }

  // ── presentations.batchUpdate ──
  batch(requests: Json[], writeControl?: Json) {
    if (writeControl?.requiredRevisionId && writeControl.requiredRevisionId !== this.revisionId) throw new SlidesError("The required revision ID does not match the latest revision of the presentation.", "FAILED_PRECONDITION");
    const backup = structuredClone({ p: this.p, n: this.n });
    try {
      const replies = requests.map((r) => this.apply(r));
      this.rev++;
      return { presentationId: this.id, replies, writeControl: { requiredRevisionId: this.revisionId } };
    } catch (e) {
      Object.assign(this, backup);
      throw e;
    }
  }

  private notesFor(slideId: string) {
    const nid = `${slideId}_notes`;
    return { objectId: `${slideId}_np`, pageType: "NOTES", pageElements: [{ objectId: nid, size: sz(6858000, 4114800), transform: tf(685800, 4343400), shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY", index: 1 } } }], notesProperties: { speakerNotesObjectId: nid } };
  }
  private checkId(id: string | undefined) {
    if (id === undefined) return;
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_\-:]{4,49}$/.test(id)) throw new SlidesError(`Invalid object ID ${id}.`);
    if (this.find(id) || this.slide(id)) throw new SlidesError(`The object ID (${id}) should be unique among all pages and page elements.`);
  }
  private newEl(r: Json, body: Json) {
    const ep = r.elementProperties ?? {};
    const page = this.slide(ep.pageObjectId);
    if (!page) throw new SlidesError(`The page (${ep.pageObjectId}) could not be found.`);
    this.checkId(r.objectId);
    const el = { objectId: r.objectId ?? this.gen(), size: ep.size ?? sz(3000000, 3000000), transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "EMU", ...(ep.transform ?? {}) }, ...body };
    page.pageElements.push(el);
    return el;
  }

  private apply(req: Json): Json {
    const kind = Object.keys(req)[0];
    const r = req[kind];
    const p = this.p;
    switch (kind) {
      case "createSlide": {
        this.checkId(r.objectId);
        const ref = r.slideLayoutReference ?? { predefinedLayout: "BLANK" };
        const layout = p.layouts.find((l: Json) => (ref.layoutId ? l.objectId === ref.layoutId : l.layoutProperties.name === ref.predefinedLayout));
        if (!layout) throw new SlidesError("The layout could not be found.");
        const sid = r.objectId ?? this.gen("s");
        const slide = {
          objectId: sid,
          pageType: "SLIDE",
          pageElements: layout.pageElements.map((le: Json) => ({ objectId: `${sid}_${le.shape.placeholder.type.toLowerCase()}`, size: le.size, transform: le.transform, shape: { shapeType: "TEXT_BOX", placeholder: { type: le.shape.placeholder.type, index: 0, parentObjectId: le.objectId }, shapeProperties: { shapeBackgroundFill: { propertyState: "INHERIT" } } } })),
          slideProperties: { layoutObjectId: layout.objectId, masterObjectId: "m1", notesPage: this.notesFor(sid) },
          pageProperties: { pageBackgroundFill: { propertyState: "INHERIT" } },
        };
        p.slides.splice(Math.min(r.insertionIndex ?? p.slides.length, p.slides.length), 0, slide);
        return { createSlide: { objectId: sid } };
      }
      case "duplicateObject": {
        const s = this.slide(r.objectId);
        const map: Record<string, string> = r.objectIds ?? {};
        if (s) {
          const nid = map[s.objectId] ?? this.gen("s");
          this.checkId(map[s.objectId]);
          const copy = structuredClone(s);
          copy.objectId = nid;
          const reid = (list: Json[]) => list.forEach((el) => ((el.objectId = map[el.objectId] ?? this.gen()), el.elementGroup && reid(el.elementGroup.children)));
          reid(copy.pageElements);
          copy.slideProperties.notesPage = this.notesFor(nid);
          const noteText = s.slideProperties.notesPage.pageElements[0]?.shape?.text;
          if (noteText) copy.slideProperties.notesPage.pageElements[0].shape.text = structuredClone(noteText);
          p.slides.splice(p.slides.indexOf(s) + 1, 0, copy);
          return { duplicateObject: { objectId: nid } };
        }
        const f = this.find(r.objectId);
        if (!f) throw new SlidesError(`The object (${r.objectId}) could not be found.`);
        const copy = structuredClone(f.el);
        copy.objectId = map[f.el.objectId] ?? this.gen();
        f.list.splice(f.list.indexOf(f.el) + 1, 0, copy);
        return { duplicateObject: { objectId: copy.objectId } };
      }
      case "deleteObject": {
        const s = this.slide(r.objectId);
        if (s) {
          if (p.slides.length === 1) throw new SlidesError("A presentation must keep at least one slide.");
          p.slides.splice(p.slides.indexOf(s), 1);
          return {};
        }
        const f = this.find(r.objectId);
        if (!f) throw new SlidesError(`The object (${r.objectId}) could not be found.`);
        f.list.splice(f.list.indexOf(f.el), 1);
        return {};
      }
      case "updateSlidesPosition": {
        const ids: string[] = r.slideObjectIds ?? [];
        const moving = ids.map((id) => this.slide(id));
        if (moving.some((s) => !s)) throw new SlidesError("A slide could not be found.");
        const at = r.insertionIndex ?? 0;
        if (at < 0 || at > p.slides.length) throw new SlidesError("insertionIndex is out of bounds.");
        const before = p.slides.slice(0, at).filter((s: Json) => ids.includes(s.objectId)).length;
        p.slides = p.slides.filter((s: Json) => !ids.includes(s.objectId));
        p.slides.splice(at - before, 0, ...moving);
        return {};
      }
      case "createShape": {
        const textbox = r.shapeType === "TEXT_BOX";
        const el = this.newEl(r, {
          shape: {
            shapeType: r.shapeType,
            shapeProperties: textbox
              ? { shapeBackgroundFill: { propertyState: "NOT_RENDERED" }, outline: { propertyState: "NOT_RENDERED" }, contentAlignment: "TOP" }
              : { shapeBackgroundFill: { solidFill: { color: { themeColor: "ACCENT1" }, alpha: 1 } }, outline: { outlineFill: { solidFill: { color: { themeColor: "DARK2" }, alpha: 1 } }, weight: { magnitude: 9525, unit: "EMU" }, dashStyle: "SOLID" }, contentAlignment: "MIDDLE" },
          },
        });
        return { createShape: { objectId: el.objectId } };
      }
      case "createImage": {
        if (!/^https:\/\//.test(r.url ?? "")) throw new SlidesError("The provided image is in an unsupported format or the URL is not publicly reachable.");
        const el = this.newEl(r, { image: { contentUrl: "", sourceUrl: r.url, imageProperties: {} } });
        el.image.contentUrl = `${this.base}/img/${el.objectId}.svg`;
        return { createImage: { objectId: el.objectId } };
      }
      case "createLine": {
        const el = this.newEl(r, { line: { lineType: "STRAIGHT_CONNECTOR_1", lineCategory: r.lineCategory ?? r.category ?? "STRAIGHT", lineProperties: { lineFill: { solidFill: { color: { themeColor: "DARK1" }, alpha: 1 } }, weight: { magnitude: 19050, unit: "EMU" }, dashStyle: "SOLID" } } });
        return { createLine: { objectId: el.objectId } };
      }
      case "createTable": {
        const rows = Number(r.rows);
        const cols = Number(r.columns);
        if (!(rows >= 1 && cols >= 1 && rows <= 20 && cols <= 20)) throw new SlidesError("Tables need 1 to 20 rows and columns.");
        const size = r.elementProperties?.size ?? sz(6000000, rows * 370840);
        const w = size.width.magnitude / cols;
        const h = size.height.magnitude / rows;
        const el = this.newEl(r, {
          table: {
            rows,
            columns: cols,
            tableColumns: Array.from({ length: cols }, () => ({ columnWidth: { magnitude: w, unit: "EMU" } })),
            tableRows: Array.from({ length: rows }, (_, ri) => ({ rowHeight: { magnitude: h, unit: "EMU" }, tableCells: Array.from({ length: cols }, (_, ci) => ({ location: { rowIndex: ri, columnIndex: ci }, rowSpan: 1, columnSpan: 1, tableCellProperties: { tableCellBackgroundFill: { propertyState: "NOT_RENDERED" } } })) })),
          },
        });
        el.size = size;
        return { createTable: { objectId: el.objectId } };
      }
      case "insertText": {
        const holder = this.textHolder(r);
        const f = toFlat(holder.text);
        const i = r.insertionIndex ?? 0;
        if (i < 0 || i > Math.max(0, f.chars.length - 1)) throw new SlidesError(`The insertion index (${i}) should be within [0, ${Math.max(0, f.chars.length - 1)}].`);
        const st = f.chars[i - 1]?.ch !== "\n" && f.chars[i - 1] ? f.chars[i - 1].st : (f.chars[i]?.st ?? {});
        const text = String(r.text ?? "");
        if (!f.chars.length) {
          f.chars = (text + (text.endsWith("\n") ? "" : "\n")).split("").map((ch) => ({ ch, st: {} }));
          f.paras = f.chars.filter((c) => c.ch === "\n").map(() => ({ style: {} }));
        } else {
          const k = f.chars.slice(0, i).filter((c) => c.ch === "\n").length;
          const add = text.split("").map((ch) => ({ ch, st }));
          f.chars.splice(i, 0, ...add);
          const nl = add.filter((c) => c.ch === "\n").length;
          for (let x = 0; x < nl; x++) f.paras.splice(k + 1, 0, structuredClone(f.paras[k] ?? { style: {} }));
        }
        holder.text = fromFlat(f);
        return {};
      }
      case "deleteText": {
        const holder = this.textHolder(r);
        const f = toFlat(holder.text);
        const s = this.span(r, f.chars.length)[0];
        let e = this.span(r, f.chars.length)[1];
        if (s === 0 && e === f.chars.length) {
          delete holder.text;
          return {};
        }
        if (e === f.chars.length) e--; // the last newline stays
        const k = f.chars.slice(0, s).filter((c) => c.ch === "\n").length;
        const gone = f.chars.slice(s, e).filter((c) => c.ch === "\n").length;
        f.chars.splice(s, e - s);
        f.paras.splice(k + 1, gone);
        holder.text = fromFlat(f);
        return {};
      }
      case "updateTextStyle": {
        const holder = this.textHolder(r);
        const f = toFlat(holder.text);
        const [s, e] = this.span(r, f.chars.length);
        for (let i = s; i < e; i++) f.chars[i].st = patch(f.chars[i].st, r.style ?? {}, r.fields);
        holder.text = fromFlat(f);
        return {};
      }
      case "updateParagraphStyle": {
        const holder = this.textHolder(r);
        const f = toFlat(holder.text);
        const [s, e] = this.span(r, f.chars.length);
        let k = 0;
        let a = 0;
        for (let i = 0; i <= f.chars.length; i++) {
          if (i === f.chars.length || f.chars[i].ch === "\n") {
            if (a <= Math.max(s, e - 1) && i >= s && f.paras[k]) f.paras[k].style = patch(f.paras[k].style, r.style ?? {}, r.fields);
            k++;
            a = i + 1;
          }
        }
        holder.text = fromFlat(f);
        return {};
      }
      case "updatePageElementTransform": {
        const f = this.find(r.objectId);
        if (!f) throw new SlidesError(`The object (${r.objectId}) could not be found.`);
        const t = r.transform;
        if (r.applyMode === "RELATIVE") {
          const o = f.el.transform;
          f.el.transform = { ...o, translateX: (o.translateX ?? 0) + (t.translateX ?? 0), translateY: (o.translateY ?? 0) + (t.translateY ?? 0) };
        } else f.el.transform = { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: 0, translateY: 0, unit: "EMU", ...t };
        return {};
      }
      case "updateShapeProperties": {
        const f = this.find(r.objectId);
        if (!f?.el.shape) throw new SlidesError(`The shape (${r.objectId}) could not be found.`);
        f.el.shape.shapeProperties = patch(f.el.shape.shapeProperties ?? {}, r.shapeProperties ?? {}, r.fields);
        return {};
      }
      case "insertTableRows":
      case "insertTableColumns":
      case "deleteTableRow":
      case "deleteTableColumn": {
        const f = this.find(r.tableObjectId);
        const t = f?.el.table;
        if (!t) throw new SlidesError("The table could not be found.");
        const ri = r.cellLocation?.rowIndex ?? 0;
        const ci = r.cellLocation?.columnIndex ?? 0;
        const n = r.number ?? 1;
        const cell = () => ({ rowSpan: 1, columnSpan: 1, tableCellProperties: {} });
        if (kind === "insertTableRows") for (let x = 0; x < n; x++) t.tableRows.splice(r.insertBelow ? ri + 1 : ri, 0, { rowHeight: t.tableRows[ri].rowHeight, tableCells: t.tableRows[ri].tableCells.map(cell) });
        if (kind === "insertTableColumns") {
          for (let x = 0; x < n; x++) {
            t.tableColumns.splice(r.insertRight ? ci + 1 : ci, 0, structuredClone(t.tableColumns[ci]));
            for (const row of t.tableRows) row.tableCells.splice(r.insertRight ? ci + 1 : ci, 0, cell());
          }
        }
        if (kind === "deleteTableRow") t.tableRows.splice(ri, 1);
        if (kind === "deleteTableColumn") {
          t.tableColumns.splice(ci, 1);
          for (const row of t.tableRows) row.tableCells.splice(ci, 1);
        }
        t.rows = t.tableRows.length;
        t.columns = t.tableColumns.length;
        t.tableRows.forEach((row: Json, a: number) => row.tableCells.forEach((c: Json, b: number) => (c.location = { rowIndex: a, columnIndex: b })));
        return {};
      }
      case "replaceAllText": {
        const find = r.containsText?.text ?? "";
        const mc = !!r.containsText?.matchCase;
        let count = 0;
        const fix = (holder: Json) => {
          if (!holder?.text) return;
          const f = toFlat(holder.text);
          const s = f.chars.map((c) => c.ch).join("");
          const hay = mc ? s : s.toLowerCase();
          const needle = mc ? find : find.toLowerCase();
          const hits: number[] = [];
          for (let i = hay.indexOf(needle); i >= 0 && needle; i = hay.indexOf(needle, i + needle.length)) hits.push(i);
          for (const at of hits.reverse()) {
            const st = f.chars[at].st;
            f.chars.splice(at, find.length, ...String(r.replaceText ?? "").split("").map((ch) => ({ ch, st })));
            count++;
          }
          if (hits.length) holder.text = fromFlat(f);
        };
        const walk = (list: Json[]) => list.forEach((el) => (el.shape ? fix(el.shape) : el.table ? el.table.tableRows.forEach((row: Json) => row.tableCells.forEach(fix)) : el.elementGroup ? walk(el.elementGroup.children) : 0));
        for (const s of p.slides) if (!r.pageObjectIds || r.pageObjectIds.includes(s.objectId)) walk(s.pageElements);
        return { replaceAllText: { occurrencesChanged: count } };
      }
      default:
        throw new SlidesError(`Invalid requests: unknown request ${kind}`);
    }
  }

  /** A picture of a slide drawn from its elements (what the mock's thumbnails show). */
  thumbSvg(pageId: string, width = 800) {
    const s = this.slide(pageId);
    const k = width / W;
    const esc = (x: string) => x.replace(/[<>&]/g, "");
    const parts: string[] = [`<rect width="100%" height="100%" fill="${s?.pageProperties?.pageBackgroundFill?.solidFill ? "#e8f0fe" : "#ffffff"}"/>`];
    for (const el of s?.pageElements ?? []) {
      const t = el.transform ?? {};
      const x = (t.translateX ?? 0) * k;
      const y = (t.translateY ?? 0) * k;
      const w = (el.size?.width?.magnitude ?? 0) * (t.scaleX ?? 1) * k;
      const h = (el.size?.height?.magnitude ?? 0) * (t.scaleY ?? 1) * k;
      if (el.shape && el.shape.shapeType !== "TEXT_BOX") parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#c9daf8" stroke="#4285f4"/>`);
      if (el.image) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#d9ead3"/>`);
      const text = el.shape?.text ? plain(el.shape.text).trim() : "";
      if (text) parts.push(`<text x="${x + 6}" y="${y + Math.min(h, 40) * 0.7}" font-family="Arial" font-size="${Math.max(10, Math.min(36, h * 0.35))}" fill="#202124">${esc(text.split("\n")[0].slice(0, 60))}</text>`);
    }
    parts.push(`<text x="${width - 10}" y="${(H * k) - 10}" font-family="Arial" font-size="12" fill="#9aa0a6" text-anchor="end">thumbnail rev ${this.rev}</text>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(H * k)}" viewBox="0 0 ${width} ${Math.round(H * k)}">${parts.join("")}</svg>`;
  }
}

/** A demo presentation: title slide, bullets, shapes and an image, a table, and speaker notes. */
export function demoDeck(id = "slidedemo", base = "http://127.0.0.1:4799") {
  const d = new MockDeck(id, "Q3 business review (demo)", base);
  const add = (layout: string, sid: string) => d.batch([{ createSlide: { objectId: sid, slideLayoutReference: { layoutId: layout } } }]);
  add("l_title", "s_title");
  add("l_tb", "s_agenda");
  add("l_tb", "s_shapes");
  add("l_tb", "s_table");
  add("l_section", "s_thanks");
  d.batch([
    { insertText: { objectId: "s_title_centered_title", insertionIndex: 0, text: "Q3 business review" } },
    { insertText: { objectId: "s_title_subtitle", insertionIndex: 0, text: "Ludhiana plant · October 2026" } },
    { insertText: { objectId: "s_agenda_title", insertionIndex: 0, text: "Agenda" } },
    { insertText: { objectId: "s_agenda_body", insertionIndex: 0, text: "Sales by region\nProduction and quality\nDispatch times\nNext quarter" } },
    { insertText: { objectId: "s_shapes_title", insertionIndex: 0, text: "How an order flows" } },
    { createShape: { objectId: "g_box_order", shapeType: "ROUND_RECTANGLE", elementProperties: { pageObjectId: "s_shapes", size: sz(2000000, 900000), transform: tf(500000, 1800000) } } },
    { insertText: { objectId: "g_box_order", insertionIndex: 0, text: "Order" } },
    { createShape: { objectId: "g_arrow_1", shapeType: "RIGHT_ARROW", elementProperties: { pageObjectId: "s_shapes", size: sz(900000, 500000), transform: tf(2650000, 2000000) } } },
    { createShape: { objectId: "g_box_make", shapeType: "ELLIPSE", elementProperties: { pageObjectId: "s_shapes", size: sz(2000000, 900000), transform: tf(3700000, 1800000) } } },
    { insertText: { objectId: "g_box_make", insertionIndex: 0, text: "Make" } },
    { updateShapeProperties: { objectId: "g_box_make", shapeProperties: { shapeBackgroundFill: { solidFill: { color: { themeColor: "ACCENT4" }, alpha: 1 } } }, fields: "shapeBackgroundFill.solidFill.color" } },
    { createImage: { objectId: "g_img_plant", url: "https://example.com/plant.png", elementProperties: { pageObjectId: "s_shapes", size: sz(2200000, 1400000), transform: tf(6400000, 1550000) } } },
    { createShape: { objectId: "g_note_box", shapeType: "TEXT_BOX", elementProperties: { pageObjectId: "s_shapes", size: sz(5000000, 500000), transform: tf(500000, 3600000) } } },
    { insertText: { objectId: "g_note_box", insertionIndex: 0, text: "Average order to dispatch: 4.2 days" } },
    { updateTextStyle: { objectId: "g_note_box", textRange: { type: "ALL" }, style: { italic: true, fontSize: { magnitude: 16, unit: "PT" }, foregroundColor: { opaqueColor: { rgbColor: rgb("#666666") } } }, fields: "italic,fontSize,foregroundColor" } },
    { insertText: { objectId: "s_table_title", insertionIndex: 0, text: "Sales by region" } },
    { deleteObject: { objectId: "s_table_body" } },
    { createTable: { objectId: "g_tbl_sales", rows: 3, columns: 3, elementProperties: { pageObjectId: "s_table", size: sz(6000000, 1200000), transform: tf(1500000, 1500000) } } },
    ...[
      ["Region", "Q2", "Q3"],
      ["North", "₹1.8 Cr", "₹2.1 Cr"],
    ].flatMap((row, ri) => row.map((text, ci) => ({ insertText: { objectId: "g_tbl_sales", cellLocation: { rowIndex: ri, columnIndex: ci }, insertionIndex: 0, text } }))),
    { createLine: { objectId: "g_line_1", lineCategory: "STRAIGHT", elementProperties: { pageObjectId: "s_table", size: sz(6000000, 0), transform: tf(1500000, 3000000) } } },
    { insertText: { objectId: "s_thanks_title", insertionIndex: 0, text: "Thank you" } },
    { insertText: { objectId: "s_title_notes", insertionIndex: 0, text: "Welcome everyone. Keep this under ten minutes." } },
    { insertText: { objectId: "s_agenda_notes", insertionIndex: 0, text: "Four topics; questions at the end." } },
  ]);
  // Title slide background from the theme colour; bold title.
  d.batch([{ updateTextStyle: { objectId: "s_title_centered_title", textRange: { type: "ALL" }, style: { bold: true }, fields: "bold" } }]);
  d.slide("s_title").pageProperties = { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb("#e8f0fe") }, alpha: 1 } } };
  d.rev = 1;
  return d;
}
