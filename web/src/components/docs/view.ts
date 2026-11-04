/**
 * Draws the document into the editable page and maps between the page's DOM
 * and Google's indexes. React owns only the page element; its children are
 * built here, paragraph by paragraph, and reused when unchanged, so typing
 * doesn't rebuild the page (and the browser's caret, spell check and IME
 * keep working). Every text span carries its offset in the paragraph
 * (data-o) and every paragraph its start index (data-p).
 */
import { isCheckList, listLabels, pt, rgbOf, type Flat, type Json, type Tok, type TS } from "./model";

type NTok = Extract<Tok, { k: "n" }>;
export type Block =
  | { t: "p"; s: number; e: number; nl: NTok; toks: Tok[] }
  | { t: "tbl"; s: number; e: number; style: Json; rows: { cells: { s: number; style: Json; blocks: Block[] }[] }[] };

/** The paragraphs and tables in toks[from, to). */
export function blocks(toks: Tok[], from: number, to: number): Block[] {
  const out: Block[] = [];
  let i = from;
  while (i < to) {
    const k = toks[i].k;
    if (k === "ts") {
      // Find the matching end, then each row and cell at this depth.
      let depth = 0;
      let end = i;
      for (let j = i; j < to; j++) {
        if (toks[j].k === "ts") depth++;
        else if (toks[j].k === "te" && --depth === 0) {
          end = j;
          break;
        }
      }
      const rows: Extract<Block, { t: "tbl" }>["rows"] = [];
      let d = 0;
      let cellStart = -1;
      let cellStyle: Json = null;
      const close = (j: number) => {
        if (cellStart >= 0 && rows.length) rows[rows.length - 1].cells.push({ s: cellStart, style: cellStyle, blocks: blocks(toks, cellStart + 1, j) });
        cellStart = -1;
      };
      for (let j = i + 1; j <= end; j++) {
        const kk = toks[j].k;
        if (d === 0 && (kk === "rs" || kk === "cs" || j === end)) {
          close(j);
          if (kk === "rs") rows.push({ cells: [] });
          if (kk === "cs") {
            cellStart = j;
            cellStyle = (toks[j] as Extract<Tok, { k: "cs" }>).style;
          }
        }
        if (j < end && kk === "ts") d++;
        if (j < end && kk === "te") d--;
      }
      out.push({ t: "tbl", s: i, e: end + 1, style: (toks[i] as Extract<Tok, { k: "ts" }>).style, rows });
      i = end + 1;
      continue;
    }
    if (k === "c" || k === "n" || k === "io" || k === "pb" || k === "x") {
      let j = i;
      while (j < to && toks[j].k !== "n" && ["c", "io", "pb", "x"].includes(toks[j].k)) j++;
      if (j < to && toks[j].k === "n") {
        out.push({ t: "p", s: i, e: j + 1, nl: toks[j] as NTok, toks: toks.slice(i, j + 1) });
        i = j + 1;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

export function paragraphsOf(bl: Block[], out: Extract<Block, { t: "p" }>[] = []) {
  for (const b of bl) {
    if (b.t === "p") out.push(b);
    else for (const r of b.rows) for (const c of r.cells) paragraphsOf(c.blocks, out);
  }
  return out;
}

const styleKey = new WeakMap<object, string>();
const keyOf = (o: object) => {
  let k = styleKey.get(o);
  if (k === undefined) styleKey.set(o, (k = JSON.stringify(o)));
  return k;
};

/** CSS for a text style. */
export function runCss(ts: TS, base?: { size?: number }): Partial<CSSStyleDeclaration> {
  const s: Partial<CSSStyleDeclaration> = {};
  if (ts.bold) s.fontWeight = "700";
  else if (ts.weightedFontFamily?.weight) s.fontWeight = String(ts.weightedFontFamily.weight);
  if (ts.bold === false) s.fontWeight = "400";
  if (ts.italic) s.fontStyle = "italic";
  else if (ts.italic === false) s.fontStyle = "normal";
  const deco = [ts.underline || ts.link ? "underline" : "", ts.strikethrough ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) s.textDecoration = deco;
  const size = pt(ts.fontSize);
  if (size) s.fontSize = `${size}pt`;
  if (ts.weightedFontFamily?.fontFamily) s.fontFamily = `"${ts.weightedFontFamily.fontFamily}", Arial, sans-serif`;
  const fg = rgbOf(ts.foregroundColor);
  if (fg) s.color = fg;
  else if (ts.link) s.color = "#1155cc";
  const bg = rgbOf(ts.backgroundColor);
  if (bg) s.backgroundColor = bg;
  if (ts.baselineOffset === "SUPERSCRIPT" || ts.baselineOffset === "SUBSCRIPT") {
    s.verticalAlign = ts.baselineOffset === "SUPERSCRIPT" ? "super" : "sub";
    s.fontSize = `${Math.round((size ?? base?.size ?? 11) * 0.66 * 10) / 10}pt`;
  }
  if (ts.smallCaps) s.fontVariant = "small-caps";
  return s;
}

/** CSS for a paragraph style, plus where its bullet sits. */
function paraCss(ps: Json, level: Json | null) {
  const s: Partial<CSSStyleDeclaration> = {};
  const al = ps.alignment;
  if (al) s.textAlign = al === "CENTER" ? "center" : al === "END" ? "right" : al === "JUSTIFIED" ? "justify" : "left";
  if (typeof ps.lineSpacing === "number") s.lineHeight = String(Math.round((ps.lineSpacing / 100) * 1.15 * 1000) / 1000);
  if (pt(ps.spaceAbove) !== undefined) s.marginTop = `${pt(ps.spaceAbove)}pt`;
  if (pt(ps.spaceBelow) !== undefined) s.marginBottom = `${pt(ps.spaceBelow)}pt`;
  const start = pt(ps.indentStart) ?? pt(level?.indentStart);
  const first = pt(ps.indentFirstLine) ?? pt(level?.indentFirstLine);
  if (start !== undefined) s.paddingLeft = `${start}pt`;
  if (pt(ps.indentEnd)) s.paddingRight = `${pt(ps.indentEnd)}pt`;
  if (!level && first !== undefined && start !== undefined && first !== start) s.textIndent = `${first - start}pt`;
  if (ps.direction === "RIGHT_TO_LEFT") s.direction = "rtl";
  if (ps.shading?.backgroundColor) s.backgroundColor = rgbOf(ps.shading.backgroundColor) ?? "";
  return { css: s, marker: level ? (first ?? Math.max(0, (start ?? 18) - 18)) : null };
}

const TAG: Record<string, string> = { HEADING_1: "h1", HEADING_2: "h2", HEADING_3: "h3", HEADING_4: "h4", HEADING_5: "h5", HEADING_6: "h6" };
const set = (el: HTMLElement, css: Partial<CSSStyleDeclaration>) => Object.assign(el.style, css);

export class DocView {
  paras: HTMLElement[] = [];
  starts: number[] = [];
  /** Paragraphs the browser changed itself (typing with an IME): rebuilt on the next render. */
  readonly dirty = new Set<Element>();
  private sigs = new WeakMap<Element, string>();
  private flat: Flat | null = null;

  constructor(readonly root: HTMLElement) {}

  /** Build or reuse the page's children for the document. */
  render(f: Flat, opts: { inert?: boolean; toks?: Tok[]; into?: HTMLElement } = {}) {
    const toks = opts.toks ?? f.toks;
    const root = opts.into ?? this.root;
    if (!opts.into) this.flat = f;
    const bl = blocks(toks, 0, toks.length);
    const paras = paragraphsOf(bl);
    const labels = listLabels(f, paras);
    const labelOf = new Map(paras.map((p, i) => [p, labels[i]]));
    // Elements from the last render, by what they show.
    const pool = new Map<string, Element[]>();
    for (const el of Array.from(root.children)) {
      const s = this.sigs.get(el);
      if (s !== undefined && !this.dirty.has(el)) {
        const arr = pool.get(s) ?? [];
        arr.push(el);
        pool.set(s, arr);
      }
    }
    const els: Element[] = bl.map((b) => {
      const spec = this.spec(f, b, labelOf);
      const sig = JSON.stringify(spec);
      const reuse = pool.get(sig)?.shift();
      if (reuse) return reuse;
      const el = this.build(f, spec);
      this.sigs.set(el, sig);
      return el;
    });
    els.forEach((el, i) => {
      if (root.children[i] !== el) root.insertBefore(el, root.children[i] ?? null);
    });
    while (root.children.length > els.length) root.lastElementChild!.remove();
    // Text the browser put outside any paragraph (rare) goes too.
    for (const n of Array.from(root.childNodes)) if (n.nodeType === 3) n.remove();
    if (opts.inert) return;
    this.dirty.clear();
    this.paras = Array.from(root.querySelectorAll<HTMLElement>("[data-p]"));
    this.starts = paras.map((p) => p.s);
    this.paras.forEach((el, i) => (el.dataset.p = String(this.starts[i] ?? 0)));
  }

  // What a block shows (its signature is this as JSON).
  private spec(f: Flat, b: Block, labelOf: Map<Block, string>): Json {
    if (b.t === "tbl") return { t: "tbl", st: b.style ?? null, rows: b.rows.map((r) => r.cells.map((c) => ({ st: c.style ?? null, b: c.blocks.map((x) => this.spec(f, x, labelOf)) }))) };
    const ps = b.nl.ps ?? {};
    const runs: Json[] = [];
    let cur: Json = null;
    b.toks.slice(0, -1).forEach((t, o) => {
      if (t.k === "c") {
        const key = `${keyOf(t.ts)}|${t.sug ?? ""}|${t.ro ?? ""}`;
        if (cur && cur.key === key) cur.text += t.ch;
        else runs.push((cur = { key, o, text: t.ch, ts: t.ts, sug: t.sug, ro: t.ro }));
        return;
      }
      cur = null;
      if (t.k === "io") runs.push({ io: t.id, o, obj: f.inline[t.id] ?? null, ts: keyOf(t.ts) });
      else if (t.k === "pb") runs.push({ pb: 1, o });
      else if (t.k === "x" && t.first) runs.push({ x: t.what, label: t.label, len: t.len, o });
    });
    const label = labelOf.get(b) ?? "";
    const list = b.nl.bullet ? f.lists[b.nl.bullet.listId] : null;
    const level = b.nl.bullet ? (list?.listProperties?.nestingLevels?.[b.nl.bullet.nestingLevel ?? 0] ?? {}) : null;
    const checked = label === "check" && runs.length > 0 && runs.every((r) => !r.text || r.ts?.strikethrough);
    return { t: "p", ns: ps.namedStyleType ?? "NORMAL_TEXT", ps, label, level, checked, check: isCheckList(list), ro: b.nl.ro ?? null, runs: runs.map(({ key: _k, ...r }) => r), bts: b.nl.bullet?.textStyle ?? null };
  }

  private build(f: Flat, spec: Json): HTMLElement {
    if (spec.t === "tbl") {
      const table = document.createElement("table");
      table.className = "dx-table";
      const cols: Json[] = spec.st?.tableColumnProperties ?? [];
      if (cols.some((c) => c.widthType === "FIXED_WIDTH" && pt(c.width))) {
        const cg = document.createElement("colgroup");
        for (const c of cols) {
          const col = document.createElement("col");
          if (c.widthType === "FIXED_WIDTH" && pt(c.width)) col.style.width = `${pt(c.width)}pt`;
          cg.appendChild(col);
        }
        table.appendChild(cg);
      }
      const tb = document.createElement("tbody");
      for (const row of spec.rows as Json[][]) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          const st = cell.st ?? {};
          const bg = rgbOf(st.backgroundColor);
          if (bg) td.style.backgroundColor = bg;
          if (st.contentAlignment === "MIDDLE") td.style.verticalAlign = "middle";
          if (st.contentAlignment === "BOTTOM") td.style.verticalAlign = "bottom";
          for (const side of ["Top", "Bottom", "Left", "Right"]) {
            const bd = st[`border${side}`];
            if (bd?.width) td.style.setProperty(`border-${side.toLowerCase()}`, `${pt(bd.width) ?? 1}pt ${bd.dashStyle === "DASH" ? "dashed" : bd.dashStyle === "DOT" ? "dotted" : "solid"} ${rgbOf(bd.color) ?? "#000"}`);
          }
          if (st.columnSpan > 1) td.colSpan = st.columnSpan;
          if (st.rowSpan > 1) td.rowSpan = st.rowSpan;
          for (const b of cell.b) td.appendChild(this.build(f, b));
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      table.appendChild(tb);
      return table;
    }
    const el = document.createElement(TAG[spec.ns] ?? "p");
    el.className = `dx-p dx-ns-${spec.ns}${spec.ro ? " dx-ro" : ""}`;
    el.dataset.p = "0";
    if (spec.ro) el.contentEditable = "false";
    const { css, marker } = paraCss(spec.ps, spec.level);
    set(el, css);
    if (spec.label) {
      const m = document.createElement("span");
      m.className = `dx-bullet${spec.label === "check" ? " dx-check" : ""}`;
      m.contentEditable = "false";
      m.textContent = spec.label === "check" ? (spec.checked ? "☑" : "☐") : spec.label;
      if (spec.label === "check") m.title = "Ticking checklist items isn't available through Google's API; open the file in Google Docs to tick it.";
      m.style.left = `${marker ?? 18}pt`;
      if (spec.bts) set(m, runCss(spec.bts));
      el.appendChild(m);
    }
    let lastText = "";
    for (const r of spec.runs as Json[]) {
      if (r.text !== undefined) {
        const s = document.createElement("span");
        s.dataset.o = String(r.o);
        set(s, runCss(r.ts));
        if (r.ts.link) {
          s.classList.add("dx-link");
          s.dataset.href = r.ts.link.url ?? (r.ts.link.headingId ? `#${r.ts.link.headingId}` : r.ts.link.bookmarkId ? `#${r.ts.link.bookmarkId}` : "");
        }
        if (r.sug) {
          s.classList.add(r.sug === "i" ? "dx-sug-i" : "dx-sug-d");
          s.contentEditable = "false";
          s.title = r.sug === "i" ? "Suggested text (accept or reject it in Google Docs)" : "Suggested deletion (accept or reject it in Google Docs)";
        }
        s.textContent = r.text.replace(/\u000b/g, "\n");
        el.appendChild(s);
        lastText = r.text;
        continue;
      }
      lastText = "";
      const a = document.createElement("span");
      a.dataset.o = String(r.o);
      a.dataset.len = String(r.len ?? 1);
      a.contentEditable = "false";
      if (r.io) {
        a.className = "dx-io";
        a.dataset.io = r.io;
        const emb = r.obj?.inlineObjectProperties?.embeddedObject ?? {};
        const w = pt(emb.size?.width);
        const h = pt(emb.size?.height);
        const src = emb.imageProperties?.contentUri;
        if (src) {
          const img = document.createElement("img");
          img.src = src;
          img.alt = emb.title ?? emb.description ?? "Image";
          img.draggable = false;
          if (w) img.style.width = `${w}pt`;
          if (h) img.style.height = `${h}pt`;
          a.appendChild(img);
        } else {
          a.classList.add("dx-chip");
          a.textContent = emb.embeddedDrawingProperties !== undefined ? "Drawing (edit it in Google Docs)" : "Embedded object";
          if (w) a.style.minWidth = `${Math.min(w, 400)}pt`;
        }
      } else if (r.pb) {
        a.className = "dx-pb";
        a.title = "Page break";
      } else if (r.x === "horizontalRule") a.className = "dx-hr";
      else if (r.x === "footnoteReference") {
        a.className = "dx-fn";
        a.textContent = r.label;
      } else if (r.x === "columnBreak") a.className = "dx-colbreak";
      else {
        a.className = "dx-chip";
        a.textContent = r.x === "person" ? `@${r.label}` : r.label;
        a.title = r.x === "equation" ? "Equation (edit it in Google Docs)" : `${r.label} (a smart chip; edit it in Google Docs)`;
      }
      el.appendChild(a);
    }
    // Keep empty lines visible: an empty paragraph, or one ending in a soft line break.
    if (!spec.runs.length || lastText.endsWith("\u000b") || spec.runs[spec.runs.length - 1]?.pb) el.appendChild(document.createElement("br"));
    return el;
  }

  // ── Mapping ──
  private lenOf(el: Element) {
    const h = el as HTMLElement;
    return h.dataset.len ? Number(h.dataset.len) : (h.textContent ?? "").length;
  }
  /** The Google index for a DOM point in the page, or null if it isn't in the body. */
  pos(node: Node, off: number): number | null {
    if (!this.root.contains(node)) return null;
    const elOf = (n: Node) => (n.nodeType === 3 ? n.parentElement : (n as Element));
    const start = elOf(node);
    const p = start?.closest<HTMLElement>("[data-p]");
    if (!p || !this.root.contains(p)) {
      // Between blocks (the page, a table, a row or a cell): the nearest paragraph.
      const el = start as Element;
      const kids = el.childNodes;
      for (let k = off; k < kids.length; k++) {
        const n = kids[k] as Element;
        const q = n.nodeType === 1 ? (n.matches("[data-p]") ? (n as HTMLElement) : n.querySelector<HTMLElement>("[data-p]")) : null;
        if (q) return Number(q.dataset.p);
      }
      for (let k = Math.min(off, kids.length) - 1; k >= 0; k--) {
        const n = kids[k] as Element;
        const all = n.nodeType === 1 ? (n.matches("[data-p]") ? [n as HTMLElement] : Array.from(n.querySelectorAll<HTMLElement>("[data-p]"))) : [];
        const q = all[all.length - 1];
        if (q) return this.endOf(q);
      }
      return null;
    }
    const base = Number(p.dataset.p);
    if (node === p) {
      let at = 0;
      for (let k = 0; k < off && k < p.childNodes.length; k++) {
        const c = p.childNodes[k];
        if (c.nodeType === 1 && (c as HTMLElement).dataset.o !== undefined) at = Number((c as HTMLElement).dataset.o) + this.lenOf(c as Element);
        else if (c.nodeType === 3) at += (c.textContent ?? "").length;
      }
      return base + at;
    }
    const span = start!.closest<HTMLElement>("[data-o]");
    if (!span || !p.contains(span)) {
      // A text node the browser put straight into the paragraph.
      let at = 0;
      for (const c of Array.from(p.childNodes)) {
        if (c === node || c.contains(node)) return base + at + (node.nodeType === 3 ? off : 0);
        if (c.nodeType === 1 && (c as HTMLElement).dataset.o !== undefined) at = Number((c as HTMLElement).dataset.o) + this.lenOf(c as Element);
        else if (c.nodeType === 3) at += (c.textContent ?? "").length;
      }
      return base + at;
    }
    const o = Number(span.dataset.o);
    if (span.dataset.len) return base + o + (node === span && off > 0 ? Number(span.dataset.len) : 0);
    if (node.nodeType === 3) {
      let at = 0;
      for (const c of Array.from(span.childNodes)) {
        if (c === node) return base + o + at + off;
        at += (c.textContent ?? "").length;
      }
      return base + o + off;
    }
    return base + o + (off > 0 ? this.lenOf(span) : 0);
  }
  private endOf(p: HTMLElement) {
    const i = this.paras.indexOf(p);
    const next = this.starts[i + 1];
    let last = Number(p.dataset.p);
    for (const c of Array.from(p.children) as HTMLElement[]) if (c.dataset.o !== undefined) last = Number(p.dataset.p) + Number(c.dataset.o) + this.lenOf(c);
    return next !== undefined ? Math.min(last, next - 1) : last;
  }
  /** The paragraph element holding index i (the one at or after i when i is between paragraphs). */
  paraIndex(i: number) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    // i past this paragraph's end (e.g. a table start): the next one.
    const p = this.paras[lo];
    if (p && i > this.endOf(p) && lo + 1 < this.paras.length) return lo + 1;
    return lo;
  }
  /** A DOM point for index i. */
  point(i: number): [Node, number] | null {
    const k = this.paraIndex(i);
    const p = this.paras[k];
    if (!p) return null;
    const off = Math.max(0, i - this.starts[k]);
    let lead = 0;
    const kids = Array.from(p.childNodes);
    for (let n = 0; n < kids.length; n++) {
      const c = kids[n] as HTMLElement;
      if (c.nodeType !== 1 || c.dataset?.o === undefined) {
        if (c.nodeType === 1 && c.classList.contains("dx-bullet")) lead = n + 1;
        continue;
      }
      const o = Number(c.dataset.o);
      const len = this.lenOf(c);
      if (c.dataset.len) {
        if (off === o) return [p, n];
        if (off === o + len) {
          const next = kids[n + 1] as HTMLElement | undefined;
          if (next?.dataset?.o !== undefined && !next.dataset.len && next.firstChild) return [next.firstChild, 0];
          return [p, n + 1];
        }
        continue;
      }
      if (off >= o && off <= o + len) {
        const t = c.firstChild;
        if (t && t.nodeType === 3) return [t, Math.min(off - o, (t.textContent ?? "").length)];
        return [c, 0];
      }
    }
    return [p, lead];
  }
  getSel(): { a: number; f: number } | null {
    const s = window.getSelection();
    if (!s || !s.anchorNode || !this.root.contains(s.anchorNode)) return null;
    const a = this.pos(s.anchorNode, s.anchorOffset);
    const f = s.focusNode ? this.pos(s.focusNode, s.focusOffset) : a;
    if (a === null || f === null) return null;
    return { a, f };
  }
  setSel(a: number, f = a) {
    const pa = this.point(a);
    const pf = this.point(f);
    const s = window.getSelection();
    if (!pa || !pf || !s) return;
    try {
      s.setBaseAndExtent(pa[0], pa[1], pf[0], pf[1]);
    } catch {}
  }
  /** Where index i is on screen (for the link bubble and scrolling). */
  rectAt(i: number): DOMRect | null {
    const pt0 = this.point(i);
    if (!pt0) return null;
    const r = document.createRange();
    try {
      r.setStart(pt0[0], pt0[1]);
      r.collapse(true);
      const rect = r.getClientRects()[0] ?? (pt0[0].nodeType === 1 ? (pt0[0] as Element).getBoundingClientRect() : pt0[0].parentElement?.getBoundingClientRect());
      return rect ?? null;
    } catch {
      return null;
    }
  }
  /** A paragraph's text as the browser now shows it, in model terms (chips and images as U+FFFC). */
  domText(p: HTMLElement) {
    let out = "";
    const walk = (n: Node) => {
      if (n.nodeType === 3) {
        out += (n.textContent ?? "").replace(/\n/g, "\u000b").replace(/ /g, " ");
        return;
      }
      const el = n as HTMLElement;
      if (el.classList?.contains("dx-bullet") || el.tagName === "BR") return;
      if (el.dataset?.len) {
        out += "￼".repeat(Number(el.dataset.len));
        return;
      }
      for (const c of Array.from(el.childNodes)) walk(c);
    };
    for (const c of Array.from(p.childNodes)) walk(c);
    return out;
  }
  get doc() {
    return this.flat;
  }
}

/** A paragraph's text in model terms, without its newline (chips and images as U+FFFC). */
export function modelText(toks: Tok[], s: number, e: number) {
  let out = "";
  for (let i = s; i < e; i++) {
    const t = toks[i];
    out += t.k === "c" ? t.ch : t.k === "n" ? "" : "￼";
  }
  return out;
}
