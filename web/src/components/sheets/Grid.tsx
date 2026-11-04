"use client";

import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { Funnel } from "lucide-react";
import { borderColor, colName, DEFAULT_FONT, DEFAULT_SIZE, fillOf, indexAt, inkOf, norm, type Border, type Cell, type GridRange, type Range, type Tab } from "./model";

export type Pt = { r: number; c: number };
export type Sel = { a: Pt; f: Pt };
export type Editing = { r: number; c: number; text: string; mode: "enter" | "edit" | "bar" };
export type GridApi = { focus: () => void; scrollTo: (r: number, c: number) => void };
type Hit = { kind: "cell" | "row" | "col" | "corner"; r: number; c: number; vx: number; vy: number };

const RH0 = 46; // row header width
const CH0 = 24; // column header height

let ctx2d: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string) {
  if (typeof document === "undefined") return text.length * 7;
  ctx2d ??= document.createElement("canvas").getContext("2d");
  if (!ctx2d) return text.length * 7;
  ctx2d.font = font;
  return ctx2d.measureText(text).width;
}

const BORDER: Record<string, string> = { SOLID: "1px solid", SOLID_MEDIUM: "2px solid", SOLID_THICK: "3px solid", DASHED: "1px dashed", DOTTED: "1px dotted", DOUBLE: "3px double" };
const borderCss = (b?: Border) => (b && b.style && b.style !== "NONE" ? `${BORDER[b.style] ?? "1px solid"} ${borderColor(b)}` : undefined);

/** How a cell looks: Google's defaults (Arial 10, numbers right, bottom aligned) plus its own format. */
function look(cell: Cell, z: number) {
  const uf = cell.uf ?? {};
  const tf = uf.textFormat ?? {};
  const size = (tf.fontSize ?? DEFAULT_SIZE) * (96 / 72) * z;
  const family = tf.fontFamily ?? DEFAULT_FONT;
  const font = `${tf.italic ? "italic " : ""}${tf.bold ? "700 " : "400 "}${size}px "${family}", Arial, sans-serif`;
  const link = !!(cell.link || tf.link?.uri);
  const isNum = cell.num !== undefined && !cell.uv?.stringValue;
  const ha = uf.horizontalAlignment ?? (cell.bool ? "CENTER" : isNum || cell.err ? "RIGHT" : "LEFT");
  const deco = [tf.underline || link ? "underline" : "", tf.strikethrough ? "line-through" : ""].filter(Boolean).join(" ");
  return { font, family, size, ha, va: uf.verticalAlignment ?? "BOTTOM", wrap: uf.wrapStrategy ?? "OVERFLOW_CELL", fill: fillOf(uf), ink: inkOf(uf) ?? (link ? "#1155cc" : "#000000"), deco, b: tf.bold, i: tf.italic };
}

const shown = (cell: Cell | null | undefined) => !!cell && (!!cell.v || !!cell.uf || !!cell.note);

/**
 * The spreadsheet grid, drawn like Google Sheets: white cells, light
 * gridlines, grey headers and the blue selection, with frozen rows and
 * columns. Only the rows and columns in view are drawn, so a sheet of tens
 * of thousands of rows scrolls smoothly. Gridlines are drawn once per row and
 * column; only cells with content or formatting get their own element.
 */
export default function Grid(p: {
  tab: Tab;
  zoom: number;
  rowOff: Float64Array;
  colOff: Float64Array;
  cell: (r: number, c: number) => Cell | null | undefined;
  ver: number;
  sel: Sel;
  editing: Editing | null;
  clip: { range: Range; cut: boolean } | null;
  refPick: Range | null;
  readOnly: boolean;
  apiRef: React.Ref<GridApi>;
  onSelect: (s: Sel) => void;
  onEdit: (r: number, c: number) => void;
  onDraft: (text: string) => void;
  onCommit: (move: [number, number] | null) => void;
  onCancel: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onResize: (dim: "ROWS" | "COLUMNS", index: number, px: number) => void;
  onAutoFit: (dim: "ROWS" | "COLUMNS", index: number) => void;
  onContext: (h: { x: number; y: number; kind: Hit["kind"]; r: number; c: number }) => void;
  onFill: (dest: Range) => void;
  onVisible: (r0: number, r1: number) => void;
  onRefPick: (range: Range) => void;
  onFilterMenu: (c: number, x: number, y: number) => void;
}) {
  const { tab, zoom: z, rowOff, colOff } = p;
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ st: 0, sl: 0, vw: 800, vh: 500 });
  const [guide, setGuide] = useState<{ dim: "ROWS" | "COLUMNS"; pos: number } | null>(null);
  const [fillTo, setFillToState] = useState<Range | null>(null);
  const fillRef = useRef<Range | null>(null);
  const setFillTo = (f: Range | null) => {
    fillRef.current = f;
    setFillToState(f);
  };
  const drag = useRef<null | { mode: "sel" | "rows" | "cols" | "fill" | "ref" | "resize"; from: Pt; dim?: "ROWS" | "COLUMNS"; index?: number; start?: number; px?: number; last?: number }>(null);
  const raf = useRef(0);

  const nR = tab.rowCount;
  const nC = tab.colCount;
  const fr = Math.min(tab.frozenRows, nR);
  const fc = Math.min(tab.frozenCols, nC);
  const RH = RH0 * Math.max(z, 0.75);
  const CH = CH0 * Math.max(z, 0.75);
  const FH = rowOff[fr] * z;
  const FW = colOff[fc] * z;
  const W = RH + colOff[nC] * z + 60;
  const H = CH + rowOff[nR] * z + 60;
  const X = (c: number) => RH + colOff[Math.min(c, nC)] * z;
  const rowH = (r: number) => (rowOff[r + 1] - rowOff[r]) * z;
  const colW = (c: number) => (colOff[c + 1] - colOff[c]) * z;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ st: el.scrollTop, sl: el.scrollLeft, vw: el.clientWidth, vh: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) setView({ st: el.scrollTop, sl: el.scrollLeft, vw: el.clientWidth, vh: el.clientHeight });
    });
  };

  // Rows and columns in view (with a little extra either side).
  const rA = Math.max(fr, indexAt(rowOff, (view.st + FH) / z) - 2);
  const rB = Math.min(nR, indexAt(rowOff, (view.st + view.vh - CH) / z) + 3);
  const cA = Math.max(fc, indexAt(colOff, (view.sl + FW) / z) - 1);
  const cB = Math.min(nC, indexAt(colOff, (view.sl + view.vw - RH) / z) + 2);
  const { onVisible } = p;
  useEffect(() => onVisible(rA, rB), [rA, rB, onVisible, tab.sheetId]);

  useImperativeHandle(p.apiRef, () => ({
    focus: () => scroller.current?.focus({ preventScroll: true }),
    scrollTo: (r: number, c: number) => {
      const el = scroller.current;
      if (!el) return;
      if (r >= fr) {
        const top = rowOff[r] * z - FH;
        const bottom = rowOff[r + 1] * z - FH;
        const room = el.clientHeight - CH - FH;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (bottom > el.scrollTop + room) el.scrollTop = bottom - room;
      }
      if (c >= fc) {
        const left = colOff[c] * z - FW;
        const right = colOff[c + 1] * z - FW;
        const room = el.clientWidth - RH - FW;
        if (left < el.scrollLeft) el.scrollLeft = left;
        else if (right > el.scrollLeft + room) el.scrollLeft = Math.min(left, right - room);
      }
    },
  }));

  /** Which header or cell is under the pointer. */
  function hit(clientX: number, clientY: number): Hit {
    const el = scroller.current!;
    const b = el.getBoundingClientRect();
    const vx = clientX - b.left;
    const vy = clientY - b.top;
    const gx = vx < RH + FW ? (vx - RH) / z : (vx - RH + el.scrollLeft) / z;
    const gy = vy < CH + FH ? (vy - CH) / z : (vy - CH + el.scrollTop) / z;
    const c = Math.max(0, Math.min(nC - 1, indexAt(colOff, Math.max(0, gx))));
    const r = Math.max(0, Math.min(nR - 1, indexAt(rowOff, Math.max(0, gy))));
    const kind = vx < RH && vy < CH ? "corner" : vx < RH ? "row" : vy < CH ? "col" : "cell";
    return { kind, r, c, vx, vy };
  }

  const editingFormula = !!p.editing && p.editing.text.startsWith("=") && /[=(,+\-*/:;&^<>]\s*$/.test(p.editing.text);

  function down(e: React.MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("textarea, .sg-filter")) return;
    if (e.button !== 0) {
      // Right-click inside the selection keeps it (for the menu).
      return;
    }
    const resize = t.closest<HTMLElement>(".sg-resize");
    if (resize) {
      e.preventDefault();
      const dim = resize.dataset.dim as "ROWS" | "COLUMNS";
      const index = Number(resize.dataset.index);
      const px = dim === "COLUMNS" ? colOff[index + 1] - colOff[index] : rowOff[index + 1] - rowOff[index];
      drag.current = { mode: "resize", from: { r: 0, c: 0 }, dim, index, start: dim === "COLUMNS" ? e.clientX : e.clientY, px, last: px };
      return;
    }
    const h = hit(e.clientX, e.clientY);
    if (t.closest(".sg-fill")) {
      e.preventDefault();
      drag.current = { mode: "fill", from: { r: h.r, c: h.c } };
      return;
    }
    if (p.editing && p.editing.mode !== "bar" && h.kind === "cell" && (editingFormula || p.refPick)) {
      // Clicking a cell while writing a formula puts its reference in.
      e.preventDefault();
      drag.current = { mode: "ref", from: { r: h.r, c: h.c } };
      p.onRefPick({ r0: h.r, c0: h.c, r1: h.r, c1: h.c });
      return;
    }
    if (p.editing) p.onCommit(null);
    e.preventDefault();
    scroller.current?.focus({ preventScroll: true });
    const ext = e.shiftKey;
    if (h.kind === "corner") return p.onSelect({ a: { r: 0, c: 0 }, f: { r: nR - 1, c: nC - 1 } });
    if (h.kind === "col") {
      const a = ext ? { r: 0, c: p.sel.a.c } : { r: 0, c: h.c };
      drag.current = { mode: "cols", from: a };
      return p.onSelect({ a, f: { r: nR - 1, c: h.c } });
    }
    if (h.kind === "row") {
      const a = ext ? { r: p.sel.a.r, c: 0 } : { r: h.r, c: 0 };
      drag.current = { mode: "rows", from: a };
      return p.onSelect({ a, f: { r: h.r, c: nC - 1 } });
    }
    const a = ext ? p.sel.a : { r: h.r, c: h.c };
    drag.current = { mode: "sel", from: a };
    p.onSelect({ a, f: { r: h.r, c: h.c } });
  }

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      const el = scroller.current;
      if (!d || !el) return;
      if (d.mode === "resize") {
        const delta = ((d.dim === "COLUMNS" ? e.clientX : e.clientY) - d.start!) / z;
        d.last = Math.max(d.dim === "COLUMNS" ? 8 : 6, Math.round(d.px! + delta));
        const b = el.getBoundingClientRect();
        setGuide({ dim: d.dim!, pos: d.dim === "COLUMNS" ? e.clientX - b.left : e.clientY - b.top });
        return;
      }
      // Scroll when dragging past the edge.
      const b = el.getBoundingClientRect();
      if (e.clientY > b.bottom - 8) el.scrollTop += 24;
      else if (e.clientY < b.top + CH + FH + 4 && el.scrollTop > 0) el.scrollTop -= 24;
      if (e.clientX > b.right - 8) el.scrollLeft += 30;
      else if (e.clientX < b.left + RH + FW + 4 && el.scrollLeft > 0) el.scrollLeft -= 30;
      const h = hit(e.clientX, e.clientY);
      if (d.mode === "sel") p.onSelect({ a: d.from, f: { r: h.r, c: h.c } });
      else if (d.mode === "cols") p.onSelect({ a: d.from, f: { r: nR - 1, c: h.c } });
      else if (d.mode === "rows") p.onSelect({ a: d.from, f: { r: h.r, c: nC - 1 } });
      else if (d.mode === "ref") p.onRefPick(norm(d.from, h));
      else if (d.mode === "fill") {
        const s = norm(p.sel.a, p.sel.f);
        const down = h.r > s.r1 ? h.r - s.r1 : h.r < s.r0 ? h.r - s.r0 : 0;
        const right = h.c > s.c1 ? h.c - s.c1 : h.c < s.c0 ? h.c - s.c0 : 0;
        if (!down && !right) setFillTo(null);
        else if (Math.abs(down) >= Math.abs(right)) setFillTo(down > 0 ? { ...s, r1: h.r } : { ...s, r0: h.r });
        else setFillTo(right > 0 ? { ...s, c1: h.c } : { ...s, c0: h.c });
      }
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.mode === "resize") {
        setGuide(null);
        if (d.last !== d.px) p.onResize(d.dim!, d.index!, d.last!);
      }
      if (d.mode === "fill") {
        const f = fillRef.current;
        setFillTo(null);
        if (f) p.onFill(f);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  const sel = norm(p.sel.a, p.sel.f);
  const fullRows = sel.c0 === 0 && sel.c1 >= nC - 1;
  const fullCols = sel.r0 === 0 && sel.r1 >= nR - 1;

  // Merges that touch what's drawn.
  const merges = tab.merges.map((m) => ({ r0: m.startRowIndex ?? 0, r1: (m.endRowIndex ?? nR) - 1, c0: m.startColumnIndex ?? 0, c1: (m.endColumnIndex ?? nC) - 1 }));
  const mergeOf = (r: number, c: number) => merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);
  const expand = (g: Range) => {
    const out = { ...g };
    for (const m of merges) if (m.r0 <= out.r1 && m.r1 >= out.r0 && m.c0 <= out.c1 && m.c1 >= out.c0) Object.assign(out, { r0: Math.min(out.r0, m.r0), r1: Math.max(out.r1, m.r1), c0: Math.min(out.c0, m.c0), c1: Math.max(out.c1, m.c1) });
    return out;
  };
  const active = mergeOf(p.sel.a.r, p.sel.a.c) ?? { r0: p.sel.a.r, r1: p.sel.a.r, c0: p.sel.a.c, c1: p.sel.a.c };
  const selBox = expand(sel);
  const filter = tab.filter?.range;

  /** One pane's cells, gridlines, selection and editor, in that pane's coordinates. */
  function pane(rows: [number, number], cols: [number, number], top: boolean) {
    const Y = (r: number) => (top ? CH + rowOff[Math.min(r, nR)] * z : rowOff[Math.min(r, nR)] * z - FH);
    const out: React.ReactNode[] = [];
    const [ra, rb] = rows;
    const [ca, cb] = cols;
    if (ra >= rb || ca >= cb) return out;
    const x0 = X(ca);
    const x1 = X(cb);
    const y0 = Y(ra);
    const y1 = Y(rb);
    if (!tab.hideGridlines) {
      for (let r = ra; r < rb; r++) if (rowH(r) > 0) out.push(<div key={`h${r}`} className="sg-hl" style={{ top: Y(r + 1) - 1, left: x0, width: x1 - x0 }} />);
      for (let c = ca; c < cb; c++) if (colW(c) > 0) out.push(<div key={`v${c}`} className="sg-vl" style={{ left: X(c + 1) - 1, top: y0, height: y1 - y0 }} />);
    }
    const drawn = new Set<string>();
    const box = (r: number, c: number, cell: Cell | null | undefined, w: number, h: number, key: string, spans = false) => {
      if (!cell || !shown(cell)) return;
      const L = look(cell, z);
      const x = X(c);
      const y = Y(r);
      let width = w;
      // Text runs over empty cells to its right, as in Google Sheets.
      if (!spans && L.wrap === "OVERFLOW_CELL" && L.ha === "LEFT" && cell.v && !cell.v.includes("\n")) {
        const need = measure(cell.v, L.font) + 6 * z;
        for (let k = c + 1; width < need && k < cb && !shown(p.cell(r, k)) && !mergeOf(r, k); k++) width += colW(k);
      }
      const b = cell.uf?.borders;
      const covers = !!L.fill || spans || width > w;
      out.push(
        <div
          key={key}
          className="sg-cell"
          title={cell.note || undefined}
          style={{ left: x, top: y, width: covers ? width : width - 1, height: covers ? h : h - 1, background: L.fill ?? (covers ? "#fff" : undefined), zIndex: covers ? 1 : undefined }}
        >
          <div
            className="sg-text"
            style={{
              font: L.font,
              color: L.ink,
              textDecoration: L.deco || undefined,
              justifyContent: L.ha === "CENTER" ? "center" : L.ha === "RIGHT" ? "flex-end" : "flex-start",
              textAlign: L.ha === "CENTER" ? "center" : L.ha === "RIGHT" ? "right" : "left",
              alignItems: L.va === "TOP" ? "flex-start" : L.va === "MIDDLE" ? "center" : "flex-end",
              whiteSpace: L.wrap === "WRAP" || L.wrap === "LEGACY_WRAP" ? "pre-wrap" : "pre",
              padding: `0 ${3 * z}px ${1 * z}px`,
            }}
          >
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{cell.v}</span>
          </div>
          {b && (
            <div className="sg-borders" style={{ borderTop: borderCss(b.top), borderBottom: borderCss(b.bottom), borderLeft: borderCss(b.left), borderRight: borderCss(b.right) }} />
          )}
          {cell.note && <span className="sg-note" aria-label="Has a note" />}
          {cell.err && <span className="sg-err" title={cell.err} />}
        </div>,
      );
    };
    // Merged cells first, so the cells they cover are skipped.
    for (const m of merges) {
      if (m.r1 < ra || m.r0 >= rb || m.c1 < ca || m.c0 >= cb) continue;
      for (let r = Math.max(m.r0, ra); r <= Math.min(m.r1, rb - 1); r++) for (let c = Math.max(m.c0, ca); c <= Math.min(m.c1, cb - 1); c++) drawn.add(`${r},${c}`);
      const cell = p.cell(m.r0, m.c0) ?? { v: "" };
      const w = X(m.c1 + 1) - X(m.c0);
      const h = Y(m.r1 + 1) - Y(m.r0);
      box(m.r0, m.c0, { ...cell, uf: { ...cell.uf, backgroundColor: cell.uf?.backgroundColor ?? (fillOf(cell.uf) ? undefined : { red: 1, green: 1, blue: 1 }) }, v: cell.v ?? "" }, w, h, `m${m.r0},${m.c0}`, true);
    }
    for (let r = ra; r < rb; r++) {
      if (rowH(r) <= 0) continue;
      for (let c = ca; c < cb; c++) {
        if (drawn.has(`${r},${c}`)) continue;
        box(r, c, p.cell(r, c), colW(c), rowH(r), `${r},${c}`);
      }
    }
    // Filter buttons on the filter's header row.
    if (filter && (filter.startRowIndex ?? 0) >= ra && (filter.startRowIndex ?? 0) < rb) {
      const fr0 = filter.startRowIndex ?? 0;
      for (let c = Math.max(ca, filter.startColumnIndex ?? 0); c < Math.min(cb, filter.endColumnIndex ?? nC); c++) {
        const filtered = (tab.filter?.filterSpecs as { columnIndex?: number }[] | undefined)?.some((s) => s.columnIndex === c);
        out.push(
          <button
            key={`f${c}`}
            type="button"
            className={`sg-filter ${filtered ? "on" : ""}`}
            aria-label={`Filter column ${colName(c)}`}
            style={{ left: X(c + 1) - 20 * z, top: Y(fr0) + (rowH(fr0) - 16 * z) / 2, width: 16 * z, height: 16 * z }}
            onClick={(e) => p.onFilterMenu(c, e.clientX, e.clientY)}
          >
            <Funnel size={10 * z} />
          </button>,
        );
      }
    }
    // Selection: the range, the active cell, the copied range and the fill handle.
    const rect = (g: Range) => ({ left: X(g.c0) - 1, top: Y(g.r0) - 1, width: X(g.c1 + 1) - X(g.c0) + 1, height: Y(g.r1 + 1) - Y(g.r0) + 1 });
    const multi = selBox.r0 !== selBox.r1 || selBox.c0 !== selBox.c1;
    if (multi) out.push(<div key="sel" className="sg-range" style={rect(selBox)} />);
    if (!p.editing || p.editing.mode === "bar") out.push(<div key="act" className="sg-active" style={rect(active)} />);
    if (p.clip) out.push(<div key="clip" className="sg-clip" style={rect(p.clip.range)} />);
    if (p.refPick) out.push(<div key="ref" className="sg-ref" style={rect(p.refPick)} />);
    if (fillTo) out.push(<div key="fillto" className="sg-fillto" style={rect(fillTo)} />);
    if (!p.readOnly && !p.editing && selBox.r1 >= ra && selBox.r1 < rb && selBox.c1 >= ca && selBox.c1 < cb) {
      out.push(<div key="fill" className="sg-fill" title="Drag to fill" style={{ left: X(selBox.c1 + 1) - 4, top: Y(selBox.r1 + 1) - 4, width: 7, height: 7 }} />);
    }
    // The cell editor.
    const ed = p.editing;
    if (ed && ed.mode !== "bar" && ed.r >= ra && ed.r < rb && ed.c >= ca && ed.c < cb) {
      const m = mergeOf(ed.r, ed.c) ?? { r0: ed.r, r1: ed.r, c0: ed.c, c1: ed.c };
      const L = look(p.cell(ed.r, ed.c) ?? {}, z);
      out.push(
        <CellEditor
          key="editor"
          text={ed.text}
          mode={ed.mode}
          style={{ left: X(m.c0) - 1, top: Y(m.r0) - 1, minWidth: X(m.c1 + 1) - X(m.c0) + 1, minHeight: Y(m.r1 + 1) - Y(m.r0) + 1, font: L.font, color: "#000", maxWidth: Math.max(240, view.vw - (X(m.c0) - view.sl) - 8) }}
          onDraft={p.onDraft}
          onCommit={p.onCommit}
          onCancel={p.onCancel}
        />,
      );
    }
    return out;
  }

  /** Column letters for columns ca..cb. */
  function colHeads(ca: number, cb: number) {
    const out: React.ReactNode[] = [];
    for (let c = ca; c < cb; c++) {
      const w = colW(c);
      if (w <= 0) continue;
      const on = c >= sel.c0 && c <= sel.c1;
      out.push(
        <div key={`ch${c}`} className={`sg-head ${on ? (fullCols ? "full" : "on") : ""}`} style={{ left: X(c), top: 0, width: w, height: CH, fontSize: 11 * Math.max(z, 0.8) }}>
          {colName(c)}
          {!p.readOnly && (
            <span className="sg-resize col" data-dim="COLUMNS" data-index={c} onDoubleClick={() => p.onAutoFit("COLUMNS", c)} title="Drag to resize; double-click to fit" />
          )}
        </div>,
      );
    }
    return out;
  }
  /** Row numbers for rows ra..rb in a pane. */
  function rowHeads(ra: number, rb: number, top: boolean) {
    const out: React.ReactNode[] = [];
    for (let r = ra; r < rb; r++) {
      const h = rowH(r);
      if (h <= 0) continue;
      const on = r >= sel.r0 && r <= sel.r1;
      const y = top ? CH + rowOff[r] * z : rowOff[r] * z - FH;
      out.push(
        <div key={`rh${r}`} className={`sg-head row ${on ? (fullRows ? "full" : "on") : ""}`} style={{ left: 0, top: y, width: RH, height: h, fontSize: 11 * Math.max(z, 0.8) }}>
          {r + 1}
          {!p.readOnly && <span className="sg-resize row" data-dim="ROWS" data-index={r} onDoubleClick={() => p.onAutoFit("ROWS", r)} title="Drag to resize; double-click to fit" />}
        </div>,
      );
    }
    return out;
  }

  return (
    <div
      ref={scroller}
      className="sg-scroll"
      tabIndex={0}
      role="grid"
      aria-label={`${tab.title} cells`}
      aria-rowcount={nR}
      aria-colcount={nC}
      onScroll={onScroll}
      onMouseDown={down}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".sg-resize, textarea, .sg-filter")) return;
        const h = hit(e.clientX, e.clientY);
        if (h.kind === "cell" && !p.readOnly) p.onEdit(h.r, h.c);
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("textarea")) return;
        e.preventDefault();
        const h = hit(e.clientX, e.clientY);
        p.onContext({ x: e.clientX, y: e.clientY, kind: h.kind, r: h.r, c: h.c });
      }}
      onKeyDown={p.onKeyDown}
    >
      <div style={{ width: W, height: H, position: "relative" }}>
        <div className="sg-top" style={{ height: CH + FH, width: W }}>
          <div className="sg-corner" style={{ width: RH + FW }}>
            {pane([0, fr], [0, fc], true)}
            {colHeads(0, fc)}
            {rowHeads(0, fr, true)}
            <div className="sg-head corner" style={{ left: 0, top: 0, width: RH, height: CH }} />
            {fc > 0 && <div className="sg-freeze v" style={{ left: RH + FW - 2, top: 0, height: CH + FH }} />}
            {fr > 0 && <div className="sg-freeze h" style={{ top: CH + FH - 2, left: 0, width: RH + FW }} />}
          </div>
          {pane([0, fr], [cA, cB], true)}
          {colHeads(cA, cB)}
          {fr > 0 && <div className="sg-freeze h" style={{ top: CH + FH - 2, left: 0, width: X(nC) }} />}
        </div>
        <div className="sg-body" style={{ height: H - CH - FH, width: W }}>
          <div className="sg-left" style={{ width: RH + FW }}>
            {pane([rA, rB], [0, fc], false)}
            {rowHeads(rA, rB, false)}
            {fc > 0 && <div className="sg-freeze v" style={{ left: RH + FW - 2, top: rowOff[rA] * z - FH, height: view.vh + 200 }} />}
          </div>
          {pane([rA, rB], [cA, cB], false)}
        </div>
      </div>
      {guide && <div className={`sg-guide ${guide.dim === "COLUMNS" ? "v" : "h"}`} style={guide.dim === "COLUMNS" ? { left: guide.pos + view.sl } : { top: guide.pos + view.st }} />}
    </div>
  );
}

/** The in-cell editor: Enter, Tab and the arrows (while typing) save and move; Esc cancels; Alt+Enter adds a line. */
function CellEditor({
  text,
  mode,
  style,
  onDraft,
  onCommit,
  onCancel,
}: {
  text: string;
  mode: Editing["mode"];
  style: React.CSSProperties;
  onDraft: (t: string) => void;
  onCommit: (move: [number, number] | null) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="sg-editor"
      aria-label="Cell value"
      spellCheck={false}
      value={text}
      style={style}
      onChange={(e) => onDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        const k = e.key;
        if (k === "Enter" && (e.altKey || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const el = e.currentTarget;
          const s = el.selectionStart;
          onDraft(text.slice(0, s) + "\n" + text.slice(el.selectionEnd));
          requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1));
          return;
        }
        if (k === "Enter") return e.preventDefault(), onCommit([e.shiftKey ? -1 : 1, 0]);
        if (k === "Tab") return e.preventDefault(), onCommit([0, e.shiftKey ? -1 : 1]);
        if (k === "Escape") return e.preventDefault(), onCancel();
        if (mode === "enter" && !text.startsWith("=") && k.startsWith("Arrow")) {
          e.preventDefault();
          onCommit(k === "ArrowDown" ? [1, 0] : k === "ArrowUp" ? [-1, 0] : k === "ArrowLeft" ? [0, -1] : [0, 1]);
        }
      }}
    />
  );
}

export type { GridRange };
