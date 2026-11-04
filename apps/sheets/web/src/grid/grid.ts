// The canvas grid. One <canvas> paints only the visible window; a transparent scroller on top
// supplies native scrolling and pointer events; one always-focused <textarea> receives every
// keystroke (navigation when idle, the cell's text while editing).
import type { EngineClient } from "../engine/client";
import type { Info, ViewBorder, ViewCell, Viewport, ViewStyle } from "../engine/protocol";
import { a1, Axis, colName, normalize, type Range, rangeA1 } from "./axis";

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;
const HEADER_W = 46;
const HEADER_H = 24;
const MARGIN = 20; // extra rows/cols fetched around the visible window
const FONT = "Arial, Helvetica, sans-serif";

const theme = {
  bg: "#ffffff",
  grid: "#e2e3e3",
  header: "#f8f9fa",
  headerText: "#5f6368",
  headerSel: "#d3e3fd",
  headerSelText: "#0b57d0",
  sel: "#0b57d0",
  selFill: "rgba(11, 87, 208, 0.10)",
  text: "#1f1f1f",
  error: "#c5221f",
  freeze: "#c4c7c5",
  filter: "#188038",
};

/** A merged area `[r0, c0, r1, c1]`. */
type Merge = [number, number, number, number];

export interface Cell {
  row: number;
  col: number;
}

export interface GridEvents {
  /** The active cell or selection changed. */
  selection(active: Cell, range: Range): void;
  /** The workbook changed (any edit, undo, format). */
  changed(revision: number): void;
  /** A user-visible error from the engine. */
  error(message: string): void;
  /** The filter button on a header cell was clicked (screen position of the button). */
  filterButton?(at: { x: number; y: number; col: number; range: Range }): void;
  /** A range went to the clipboard. */
  copied?(range: string, cut: boolean): void;
  /**
   * Right-click. `row`/`col` are -1 on the column/row headers (a header click has already
   * selected its whole column or row; a click outside the selection has selected that cell).
   */
  contextMenu?(at: { x: number; y: number; row: number; col: number }): void;
}

export class Grid {
  readonly rows: Axis;
  readonly cols: Axis;
  active: Cell = { row: 0, col: 0 };
  private anchor: Cell = { row: 0, col: 0 };
  private cells = new Map<number, ViewCell>();
  private styles = new Map<number, ViewStyle>();
  /** Viewport style ids are local to one reply; looks are re-keyed into this grid-wide table. */
  private styleIds = new Map<string, number>();
  /** Merged areas seen in the fetched window, keyed by `row * MAX_COLS + col` of every covered cell. */
  private mergeAt = new Map<number, Merge>();
  private merges: Merge[] = [];
  private filter: Viewport["filter"] | undefined;
  /** Frozen rows and columns of the active sheet. */
  private freeze: [number, number] = [0, 0];
  private gridlines = true;
  private fetchedFreeze = "0,0";
  /** The fill handle being dragged: the source range and the range it would fill. */
  private filling: { source: Range; target: Range } | null = null;
  private fetched: Range | null = null;
  private fetchedRevision = -1;
  private revision = 0;
  private fetchToken = 0;
  private frame = 0;
  private editing = false;
  private dragging = false;
  /** A header border being dragged: which axis, which line, where the drag started. */
  private resizing: { axis: "col" | "row"; index: number; start: number; size: number } | null = null;
  private resizePreview: number | null = null;
  /** The exact text the engine gave for our last copy/cut (the OS may rewrite its line endings). */
  private copiedText: string | null = null;
  /** Other people's selections on this sheet, drawn as coloured boxes with their name. */
  private peers: { name: string; color: string; range: Range }[] = [];
  /** While true (joining a shared workbook) edits are refused: they would be lost. */
  readOnly = false;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scroller: HTMLDivElement;
  private spacer: HTMLDivElement;
  readonly input: HTMLTextAreaElement;

  constructor(
    private host: HTMLElement,
    private engine: EngineClient,
    private events: GridEvents,
  ) {
    this.rows = new Axis(20, 1000);
    this.cols = new Axis(100, 26);
    host.classList.add("grid-host");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "grid-canvas";
    this.scroller = document.createElement("div");
    this.scroller.className = "grid-scroller";
    this.scroller.setAttribute("data-testid", "grid");
    this.spacer = document.createElement("div");
    this.spacer.className = "grid-spacer";
    this.scroller.appendChild(this.spacer);
    this.input = document.createElement("textarea");
    this.input.className = "cell-input";
    this.input.setAttribute("aria-label", "Cell editor");
    this.input.setAttribute("data-testid", "cell-input");
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    host.append(this.canvas, this.scroller, this.input);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;

    new ResizeObserver(() => this.layout()).observe(host);
    this.scroller.addEventListener("scroll", () => {
      this.growIfNearEnd();
      this.invalidate();
    });
    this.scroller.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.scroller.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.scroller.addEventListener("pointerup", (e) => void this.onPointerUp(e));
    this.scroller.addEventListener("dblclick", (e) => {
      const h = this.hit(e);
      if (h && h.row >= 0 && h.col >= 0) void this.beginEdit(null);
    });
    this.scroller.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.input.addEventListener("keydown", (e) => void this.onKey(e));
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("copy", (e) => this.onCopy(e, "edit.copy"));
    this.input.addEventListener("cut", (e) => this.onCopy(e, "edit.cut"));
    this.input.addEventListener("paste", (e) => this.onPaste(e));
    this.layout();
  }

  // ---------- state from the engine ----------

  private usedEnd: [number, number] | null = null;

  applyInfo(info: Info): void {
    this.usedEnd = info.used_end;
    const freeze: [number, number] = info.freeze ?? [0, 0];
    if (freeze[0] !== this.freeze[0] || freeze[1] !== this.freeze[1]) this.freeze = freeze;
    this.gridlines = info.gridlines ?? true;
    this.rows.setDefault(info.default_row_height);
    this.cols.setDefault(info.default_col_width);
    const [ur, uc] = info.used_end ?? [0, 0];
    this.rows.count = Math.min(MAX_ROWS, Math.max(this.rows.count, 1000, ur + 200));
    this.cols.count = Math.min(MAX_COLS, Math.max(this.cols.count, 26, uc + 5));
    this.revision = info.revision;
    this.resizeSpacer();
    this.invalidate();
  }

  /** Forgets cached cells (after opening a file or switching sheets). */
  reset(): void {
    this.cells.clear();
    this.styles.clear();
    this.styleIds.clear();
    this.mergeAt.clear();
    this.merges = [];
    this.filter = undefined;
    this.fetched = null;
    this.fetchedRevision = -1;
    this.rows.count = 1000;
    this.cols.count = 26;
    this.select({ row: 0, col: 0 }, false);
    this.scroller.scrollTo(0, 0);
  }

  markChanged(revision: number): void {
    this.revision = revision;
    this.events.changed(revision);
    this.invalidate();
  }

  get selection(): Range {
    return normalize(this.anchor, this.active);
  }

  get isEditing(): boolean {
    return this.editing;
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  // ---------- layout and painting ----------

  private layout(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  private resizeSpacer(): void {
    this.spacer.style.width = `${HEADER_W + this.cols.total()}px`;
    this.spacer.style.height = `${HEADER_H + this.rows.total()}px`;
  }

  private growIfNearEnd(): void {
    const { scrollTop, scrollLeft, clientHeight, clientWidth } = this.scroller;
    let grew = false;
    if (scrollTop + clientHeight > HEADER_H + this.rows.total() - 400 && this.rows.count < MAX_ROWS) {
      this.rows.count = Math.min(MAX_ROWS, this.rows.count + 1000);
      grew = true;
    }
    if (scrollLeft + clientWidth > HEADER_W + this.cols.total() - 400 && this.cols.count < MAX_COLS) {
      this.cols.count = Math.min(MAX_COLS, this.cols.count + 26);
      grew = true;
    }
    if (grew) this.resizeSpacer();
  }

  /** Width of the frozen columns and height of the frozen rows, in pixels. */
  private get frozenW(): number {
    return this.cols.offset(this.freeze[1]);
  }
  private get frozenH(): number {
    return this.rows.offset(this.freeze[0]);
  }

  /** Screen x of column `c`'s left edge (frozen columns don't scroll). */
  private x(c: number): number {
    return HEADER_W + this.cols.offset(c) - (c < this.freeze[1] ? 0 : this.scroller.scrollLeft);
  }
  private y(r: number): number {
    return HEADER_H + this.rows.offset(r) - (r < this.freeze[0] ? 0 : this.scroller.scrollTop);
  }

  /** The scrolling cells currently in view (inclusive), below and right of any frozen panes. */
  visible(): Range {
    const { scrollTop, scrollLeft } = this.scroller;
    const w = this.host.clientWidth - HEADER_W;
    const h = this.host.clientHeight - HEADER_H;
    const [fr, fc] = this.freeze;
    return {
      r0: Math.max(fr, this.rows.indexAt(scrollTop + this.frozenH)),
      c0: Math.max(fc, this.cols.indexAt(scrollLeft + this.frozenW)),
      r1: Math.max(fr, this.rows.indexAt(scrollTop + h)),
      c1: Math.max(fc, this.cols.indexAt(scrollLeft + w)),
    };
  }

  invalidate(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
      void this.ensureData();
    });
  }

  private covers(outer: Range | null, inner: Range): boolean {
    return !!outer && outer.r0 <= inner.r0 && outer.c0 <= inner.c0 && outer.r1 >= inner.r1 && outer.c1 >= inner.c1;
  }

  /** Fetches the visible window (plus a margin) when the cache doesn't cover it or is stale. */
  private async ensureData(): Promise<void> {
    const v = this.visible();
    const freezeKey = this.freeze.join(",");
    if (this.fetchedRevision === this.revision && this.fetchedFreeze === freezeKey && this.covers(this.fetched, v)) return;
    const [fr, fc] = this.freeze;
    const want: Range = {
      r0: Math.max(fr, v.r0 - MARGIN),
      c0: Math.max(fc, v.c0 - MARGIN / 2),
      r1: Math.min(MAX_ROWS - 1, v.r1 + MARGIN),
      c1: Math.min(MAX_COLS - 1, v.c1 + MARGIN / 2),
    };
    // The frozen strips are fetched on their own so scrolling far away stays a small window.
    const parts: Range[] = [want];
    if (fr > 0) parts.push({ r0: 0, c0: want.c0, r1: fr - 1, c1: want.c1 });
    if (fc > 0) parts.push({ r0: want.r0, c0: 0, r1: want.r1, c1: fc - 1 });
    if (fr > 0 && fc > 0) parts.push({ r0: 0, c0: 0, r1: fr - 1, c1: fc - 1 });
    const token = ++this.fetchToken;
    const revision = this.revision;
    try {
      const vps = await Promise.all(parts.map((p) => this.engine.viewport(p.r0, p.c0, p.r1, p.c1)));
      if (token !== this.fetchToken) return; // a newer request superseded this one
      this.cells.clear();
      this.styles.clear();
      this.styleIds.clear();
      this.mergeAt.clear();
      this.merges = [];
      const seen = new Set<string>();
      vps.forEach((vp) => {
        const local = new Map<number, number>();
        for (const [k, st] of Object.entries(vp.styles)) {
          const keyText = JSON.stringify(st);
          let id = this.styleIds.get(keyText);
          if (id === undefined) {
            id = this.styleIds.size + 1;
            this.styleIds.set(keyText, id);
            this.styles.set(id, st);
          }
          local.set(Number(k), id);
        }
        for (const c of vp.cells) this.cells.set(key(c[0], c[1]), [c[0], c[1], c[2], c[3], local.get(c[4]) ?? 0]);
        for (const m of vp.merges ?? []) {
          const k = m.join(",");
          if (seen.has(k)) continue;
          seen.add(k);
          this.merges.push(m);
        }
      });
      for (const m of this.merges) {
        // Index only the part of a (possibly huge) merge that is near the window.
        for (let r = Math.max(m[0], 0); r <= Math.min(m[2], want.r1); r++) {
          if (r > fr && r < want.r0) continue;
          for (let c = Math.max(m[1], 0); c <= Math.min(m[3], want.c1); c++) {
            if (c > fc && c < want.c0) continue;
            this.mergeAt.set(key(r, c), m);
          }
        }
      }
      this.filter = vps[0].filter;
      if (!this.resizing) {
        let changed = this.cols.apply(want.c0, vps[0].col_widths);
        changed = this.rows.apply(want.r0, vps[0].row_heights) || changed;
        if (fr > 0) changed = this.rows.apply(0, vps[1].row_heights) || changed;
        if (fc > 0) changed = this.cols.apply(0, vps[fr > 0 ? 2 : 1].col_widths) || changed;
        if (changed) this.resizeSpacer();
      }
      this.fetched = want;
      this.fetchedRevision = revision;
      this.fetchedFreeze = freezeKey;
      this.paint();
      if (this.revision !== revision) this.invalidate();
    } catch (e) {
      this.events.error(String(e));
    }
  }

  /** The merged area covering a cell, if any. */
  mergeOf(row: number, col: number): Merge | undefined {
    return this.mergeAt.get(key(row, col));
  }

  cellAt(row: number, col: number): ViewCell | undefined {
    return this.cells.get(key(row, col));
  }

  private paint(): void {
    const ctx = this.ctx;
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    const v = this.visible();
    const [fr, fc] = this.freeze;
    const FW = this.frozenW;
    const FH = this.frozenH;

    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);

    // Four panes: the scrolling body, the frozen top rows, the frozen left columns, the corner.
    const panes: { r: Range; clip: [number, number, number, number] }[] = [
      { r: v, clip: [HEADER_W + FW, HEADER_H + FH, W, H] },
    ];
    if (fr > 0) panes.push({ r: { r0: 0, r1: fr - 1, c0: v.c0, c1: v.c1 }, clip: [HEADER_W + FW, HEADER_H, W, HEADER_H + FH] });
    if (fc > 0) panes.push({ r: { r0: v.r0, r1: v.r1, c0: 0, c1: fc - 1 }, clip: [HEADER_W, HEADER_H + FH, HEADER_W + FW, H] });
    if (fr > 0 && fc > 0) panes.push({ r: { r0: 0, r1: fr - 1, c0: 0, c1: fc - 1 }, clip: [HEADER_W, HEADER_H, HEADER_W + FW, HEADER_H + FH] });
    for (const pane of panes) {
      const [x0, y0, x1, y1] = pane.clip;
      if (x1 <= x0 || y1 <= y0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      this.paintBody(pane.r, pane.r.c0 >= fc ? fc : 0, x1, y1);
      ctx.restore();
    }

    // Selection, fill-handle preview and other people's cursors, over every pane.
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, HEADER_H, W - HEADER_W, H - HEADER_H);
    ctx.clip();
    const sel = this.selection;
    const [sx, sy, sw, sh] = this.rangeRect(sel);
    const single = sel.r0 === sel.r1 && sel.c0 === sel.c1;
    const m = this.mergeOf(this.active.row, this.active.col);
    const inMerge = !!m && m[0] === sel.r0 && m[1] === sel.c0 && m[2] >= sel.r1 && m[3] >= sel.c1;
    if (!single && !inMerge) {
      ctx.fillStyle = theme.selFill;
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeStyle = theme.sel;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
    }
    const [ax, ay, aw, ah] = this.rangeRect(m ? { r0: m[0], c0: m[1], r1: m[2], c1: m[3] } : { r0: this.active.row, c0: this.active.col, r1: this.active.row, c1: this.active.col });
    ctx.strokeStyle = theme.sel;
    ctx.lineWidth = 2;
    ctx.strokeRect(ax + 1, ay + 1, aw - 2, ah - 2);
    if (this.filling) {
      const [fx, fy, fw, fh] = this.rangeRect(this.filling.target);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#5f6368";
      ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
      ctx.setLineDash([]);
    }
    // The fill handle: a small square on the selection's bottom-right corner.
    if (!this.editing && !this.readOnly && sel.r1 < MAX_ROWS - 1 && sel.c1 < MAX_COLS - 1) {
      const [hx, hy] = this.handlePoint();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(hx - 4, hy - 4, 8, 8);
      ctx.fillStyle = theme.sel;
      ctx.fillRect(hx - 3, hy - 3, 6, 6);
    }
    ctx.restore();

    this.paintPeers(W, H);

    // Freeze bars.
    ctx.fillStyle = theme.freeze;
    if (fr > 0) ctx.fillRect(0, HEADER_H + FH - 2, W, 3);
    if (fc > 0) ctx.fillRect(HEADER_W + FW - 2, 0, 3, H);

    this.paintHeaders(v, W, H);
    this.placeInput();
  }

  /**
   * Where a cell (or the merge covering it) is drawn, relative to the grid element:
   * `[x, y, w, h]`. Part of it may sit under the frozen panes or headers when scrolled.
   */
  cellRect(row: number, col: number): [number, number, number, number] {
    const m = this.mergeOf(row, col);
    return this.rangeRect(m ? { r0: m[0], c0: m[1], r1: m[2], c1: m[3] } : { r0: row, c0: col, r1: row, c1: col });
  }

  /** The area cells are drawn in (right of the row headers, below the column headers, past the frozen panes). */
  get scrollArea(): { x: number; y: number } {
    return { x: HEADER_W + this.frozenW, y: HEADER_H + this.frozenH };
  }

  /** Screen rectangle `[x, y, w, h]` of a range (frozen panes respected). */
  private rangeRect(r: Range): [number, number, number, number] {
    const x0 = this.x(r.c0);
    const y0 = this.y(r.r0);
    return [x0, y0, this.x(r.c1) + this.cols.size(r.c1) - x0, this.y(r.r1) + this.rows.size(r.r1) - y0];
  }

  private handlePoint(): [number, number] {
    const [sx, sy, sw, sh] = this.rangeRect(this.selection);
    return [sx + sw, sy + sh];
  }

  /** Fills, gridlines, text, borders and filter buttons for one pane. `minCol` bounds text overflow. */
  private paintBody(v: Range, minCol: number, W: number, H: number): void {
    const ctx = this.ctx;
    const x = (c: number) => this.x(c);
    const y = (r: number) => this.y(r);
    const style = (cell: ViewCell | undefined) => (cell ? this.styles.get(cell[4]) : undefined);

    // Fills (a merge takes its anchor's fill over the whole area, painted below).
    for (let r = v.r0; r <= v.r1; r++) {
      if (this.rows.size(r) === 0) continue;
      for (let c = v.c0; c <= v.c1; c++) {
        if (this.mergeOf(r, c)) continue;
        const st = style(this.cellAt(r, c));
        if (st?.fill) {
          ctx.fillStyle = st.fill;
          ctx.fillRect(x(c), y(r), this.cols.size(c), this.rows.size(r));
        }
      }
    }

    // Gridlines.
    if (this.gridlines) {
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = v.c0; c <= v.c1 + 1; c++) {
        const px = Math.floor(x(c)) + 0.5;
        ctx.moveTo(px, y(v.r0));
        ctx.lineTo(px, Math.min(H, y(v.r1) + this.rows.size(v.r1)));
      }
      for (let r = v.r0; r <= v.r1 + 1; r++) {
        const py = Math.floor(y(r)) + 0.5;
        ctx.moveTo(x(v.c0), py);
        ctx.lineTo(Math.min(W, x(v.c1) + this.cols.size(v.c1)), py);
      }
      ctx.stroke();
    }

    // Merged areas cover the gridlines inside them.
    for (const m of this.merges) {
      if (m[2] < v.r0 || m[0] > v.r1 || m[3] < v.c0 || m[1] > v.c1) continue;
      const [mx, my, mw, mh] = this.rangeRect({ r0: m[0], c0: m[1], r1: m[2], c1: m[3] });
      ctx.fillStyle = style(this.cellAt(m[0], m[1]))?.fill ?? theme.bg;
      ctx.fillRect(mx + 1, my + 1, mw - 1, mh - 1);
    }

    // Text. Left-aligned text overflows into empty neighbours (right-aligned to the left).
    ctx.textBaseline = "middle";
    const drawn = new Set<Merge>();
    for (let r = v.r0; r <= v.r1; r++) {
      if (this.rows.size(r) === 0) continue;
      for (let c = Math.max(minCol, v.c0 - 10); c <= v.c1 + 10; c++) {
        const m = this.mergeOf(r, c);
        let cell: ViewCell | undefined;
        let rect: [number, number, number, number];
        if (m) {
          if (drawn.has(m)) continue;
          drawn.add(m);
          cell = this.cellAt(m[0], m[1]);
          rect = this.rangeRect({ r0: m[0], c0: m[1], r1: m[2], c1: m[3] });
        } else {
          if (c > v.c1 && !this.cellAt(r, c)) continue;
          cell = this.cellAt(r, c);
          rect = [x(c), y(r), this.cols.size(c), this.rows.size(r)];
        }
        if (!cell || rect[2] <= 0) continue;
        if (this.editing && cell[0] === this.active.row && cell[1] === this.active.col) continue;
        this.paintCellText(cell, style(cell), rect, !m, minCol, W);
      }
    }

    // Borders, after text so neighbouring fills never hide them.
    for (let r = v.r0; r <= v.r1; r++) {
      if (this.rows.size(r) === 0) continue;
      for (let c = v.c0; c <= v.c1; c++) {
        const st = style(this.cellAt(r, c));
        if (!st || !(st.bt || st.br || st.bb || st.bl)) continue;
        const m = this.mergeOf(r, c);
        const [bx, by, bw, bh] = m ? this.rangeRect({ r0: m[0], c0: m[1], r1: m[2], c1: m[3] }) : [x(c), y(r), this.cols.size(c), this.rows.size(r)];
        if (st.bt) this.edge(st.bt, bx, by, bx + bw, by);
        if (st.bb) this.edge(st.bb, bx, by + bh, bx + bw, by + bh);
        if (st.bl) this.edge(st.bl, bx, by, bx, by + bh);
        if (st.br) this.edge(st.br, bx + bw, by, bx + bw, by + bh);
      }
    }

    // Filter buttons on the filter's header row.
    const f = this.filter;
    if (f && f.range[0] >= v.r0 && f.range[0] <= v.r1) {
      const r = f.range[0];
      for (let c = Math.max(v.c0, f.range[1]); c <= Math.min(v.c1, f.range[3]); c++) {
        const [bx, by, bw, bh] = this.filterButtonRect(r, c);
        const on = f.active.includes(c - f.range[1]);
        ctx.fillStyle = on ? theme.filter : "#ffffff";
        ctx.strokeStyle = on ? theme.filter : "#80868b";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bx + 0.5, by + 0.5, bw - 1, bh - 1, 3);
        ctx.fill();
        ctx.stroke();
        // Three lines narrowing downwards: Google's filter glyph.
        ctx.fillStyle = on ? "#ffffff" : "#3c4043";
        const cx = bx + bw / 2;
        const cy = by + bh / 2;
        ctx.fillRect(cx - 4, cy - 3, 8, 1.5);
        ctx.fillRect(cx - 2.5, cy - 0.5, 5, 1.5);
        ctx.fillRect(cx - 1, cy + 2, 2, 1.5);
      }
    }
  }

  /** The filter button inside a header cell: `[x, y, w, h]`. */
  private filterButtonRect(r: number, c: number): [number, number, number, number] {
    const size = Math.min(16, this.rows.size(r) - 4);
    return [this.x(c) + this.cols.size(c) - size - 3, this.y(r) + (this.rows.size(r) - size) / 2, size, size];
  }

  private edge(b: ViewBorder, x0: number, y0: number, x1: number, y1: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = b.color;
    const w = b.k === "=" ? 1 : b.w;
    ctx.lineWidth = w;
    ctx.setLineDash(b.k === "d" ? [4, 2] : b.k === "o" ? [1, 1] : []);
    const odd = w % 2 === 1 ? 0.5 : 0;
    const lines = b.k === "=" ? [-1, 1] : [0];
    ctx.beginPath();
    for (const d of lines) {
      if (y0 === y1) {
        const py = Math.floor(y0) + odd + d;
        ctx.moveTo(x0, py);
        ctx.lineTo(x1, py);
      } else {
        const px = Math.floor(x0) + odd + d;
        ctx.moveTo(px, y0);
        ctx.lineTo(px, y1);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** One cell's value: font, alignment, wrapping, rotation, indent and conditional bars/icons. */
  private paintCellText(
    cell: ViewCell,
    st: ViewStyle | undefined,
    rect: [number, number, number, number],
    canOverflow: boolean,
    minCol: number,
    W: number,
  ): void {
    const ctx = this.ctx;
    const [cx0, cy0, cw, ch] = rect;
    const text = cell[2];
    if (st?.bar) {
      const [frac, color] = st.bar;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(cx0 + 2, cy0 + 2, Math.max(0, (cw - 4) * frac), ch - 4);
      ctx.globalAlpha = 1;
    }
    let iconW = 0;
    if (st?.icon) {
      iconW = 16;
      this.paintIcon(st.icon, cx0 + 3, cy0 + ch / 2);
    }
    if (text === "" || st?.hide) return;
    const align = st?.h ?? (cell[3] === "n" ? "r" : cell[3] === "s" ? "l" : "c");
    let pt = st?.size ?? 10;
    if (st?.va) pt *= 0.7;
    const px = (pt * 96) / 72;
    const family = st?.font ? `"${st.font}", ${FONT}` : FONT;
    ctx.font = `${st?.i ? "italic " : ""}${st?.b ? "bold " : ""}${px.toFixed(1)}px ${family}`;
    ctx.fillStyle = cell[3] === "e" ? theme.error : (st?.color ?? theme.text);
    const indent = (st?.indent ?? 0) * 9;
    const pad = 3;
    const lineH = Math.round(px * 1.25);
    const vAlign = st?.v ?? "b";

    // Overflow: the clip widens into empty neighbours on the side the text runs.
    let left = cx0;
    let right = cx0 + cw;
    const r = cell[0];
    const c = cell[1];
    const wrap = !!st?.wrap;
    if (canOverflow && !wrap && !st?.rot && cell[3] === "s") {
      const free = (n: number) => !this.cellAt(r, n) && !this.mergeOf(r, n);
      if (align === "l" || align === "c") {
        for (let n = c + 1; n < this.cols.count && free(n) && this.x(n) < W; n++) right += this.cols.size(n);
      }
      if (align === "r" || align === "c") {
        for (let n = c - 1; n >= minCol && free(n) && this.x(n) + this.cols.size(n) > HEADER_W; n--) left -= this.cols.size(n);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, cy0, right - left, ch);
    ctx.clip();

    if (st?.rot) {
      ctx.translate(cx0 + cw / 2, cy0 + ch / 2);
      ctx.rotate((-st.rot * Math.PI) / 180);
      ctx.textAlign = "center";
      ctx.fillText(text, 0, 1);
      ctx.restore();
      return;
    }

    const lines = wrap ? wrapLines(ctx, text, cw - 2 * pad - indent - iconW) : text.split("\n");
    const blockH = lines.length * lineH;
    // Text taller than the cell shows its first lines, as Google does.
    const top =
      vAlign === "t" || blockH > ch - 4 ? cy0 + 2 : vAlign === "m" ? cy0 + (ch - blockH) / 2 : cy0 + ch - blockH - 2;
    lines.forEach((line, i) => {
      const tw = ctx.measureText(line).width;
      let tx: number;
      if (align === "r") tx = cx0 + cw - pad - indent - tw;
      else if (align === "c") tx = cx0 + (cw - tw) / 2;
      else tx = cx0 + pad + indent + iconW;
      let ty = top + lineH * i + lineH / 2 + 1;
      if (st?.va === "p") ty -= px * 0.35;
      else if (st?.va === "b") ty += px * 0.25;
      ctx.fillText(line, tx, ty);
      if (st?.u) ctx.fillRect(tx, ty + px / 2 - 1, tw, 1);
      if (st?.s) ctx.fillRect(tx, ty, tw, 1);
    });
    ctx.restore();
  }

  /** Conditional-format icons, drawn as Google/Excel-style coloured shapes. */
  private paintIcon([set, index]: [string, number], x0: number, cy: number): void {
    const ctx = this.ctx;
    const n = /5/.test(set) ? 5 : /4/.test(set) ? 4 : 3;
    const palette = n === 3 ? ["#d93025", "#f9ab00", "#188038"] : n === 4 ? ["#d93025", "#f9ab00", "#81c995", "#188038"] : ["#d93025", "#ee675c", "#f9ab00", "#81c995", "#188038"];
    ctx.fillStyle = palette[Math.min(index, n - 1)];
    if (/arrow/i.test(set)) {
      const up = index >= n - 1 ? -1 : index === 0 ? 1 : 0;
      ctx.beginPath();
      if (up === 0) {
        ctx.moveTo(x0, cy - 4);
        ctx.lineTo(x0 + 10, cy);
        ctx.lineTo(x0, cy + 4);
      } else {
        ctx.moveTo(x0 + 5, cy + up * 5);
        ctx.lineTo(x0 + 10, cy - up * 3);
        ctx.lineTo(x0, cy - up * 3);
      }
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x0 + 5, cy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Column and row headers for the frozen and scrolling parts. */
  private paintHeaders(v: Range, W: number, H: number): void {
    const ctx = this.ctx;
    const sel = this.selection;
    const [fr, fc] = this.freeze;
    const FW = this.frozenW;
    const FH = this.frozenH;
    ctx.fillStyle = theme.header;
    ctx.fillRect(0, 0, W, HEADER_H);
    ctx.fillRect(0, 0, HEADER_W, H);
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const colSpans: [number, number, number, number][] = [[v.c0, v.c1, HEADER_W + FW, W]];
    if (fc > 0) colSpans.push([0, fc - 1, HEADER_W, HEADER_W + FW]);
    const rowSpans: [number, number, number, number][] = [[v.r0, v.r1, HEADER_H + FH, H]];
    if (fr > 0) rowSpans.push([0, fr - 1, HEADER_H, HEADER_H + FH]);
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    for (const [c0, c1, x0, x1] of colSpans) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, HEADER_H);
      ctx.clip();
      ctx.beginPath();
      for (let c = c0; c <= c1; c++) {
        const w = this.cols.size(c);
        if (w === 0) continue;
        const on = c >= sel.c0 && c <= sel.c1;
        if (on) {
          ctx.fillStyle = theme.headerSel;
          ctx.fillRect(this.x(c), 0, w, HEADER_H);
        }
        ctx.fillStyle = on ? theme.headerSelText : theme.headerText;
        ctx.fillText(colName(c), this.x(c) + w / 2, HEADER_H / 2 + 1);
        const px = Math.floor(this.x(c + 1)) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, HEADER_H);
      }
      ctx.stroke();
      ctx.restore();
    }
    for (const [r0, r1, y0, y1] of rowSpans) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, HEADER_W, y1 - y0);
      ctx.clip();
      ctx.beginPath();
      for (let r = r0; r <= r1; r++) {
        const h = this.rows.size(r);
        if (h === 0) continue;
        const on = r >= sel.r0 && r <= sel.r1;
        if (on) {
          ctx.fillStyle = theme.headerSel;
          ctx.fillRect(0, this.y(r), HEADER_W, h);
        }
        ctx.fillStyle = on ? theme.headerSelText : theme.headerText;
        ctx.fillText(String(r + 1), HEADER_W / 2, this.y(r) + h / 2 + 1);
        const py = Math.floor(this.y(r + 1)) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(HEADER_W, py);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.textAlign = "start";
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H + 0.5);
    ctx.lineTo(W, HEADER_H + 0.5);
    ctx.moveTo(HEADER_W + 0.5, 0);
    ctx.lineTo(HEADER_W + 0.5, H);
    ctx.stroke();
    ctx.fillStyle = theme.header;
    ctx.fillRect(0, 0, HEADER_W, HEADER_H);
    if (fr > 0) {
      ctx.fillStyle = theme.freeze;
      ctx.fillRect(0, HEADER_H + FH - 2, HEADER_W, 3);
    }
    if (fc > 0) {
      ctx.fillStyle = theme.freeze;
      ctx.fillRect(HEADER_W + FW - 2, 0, 3, HEADER_H);
    }
  }

  setPeers(peers: { name: string; color: string; range: Range }[]): void {
    this.peers = peers;
    this.invalidate();
  }

  private paintPeers(W: number, H: number): void {
    if (!this.peers.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, HEADER_H, W - HEADER_W, H - HEADER_H);
    ctx.clip();
    for (const p of this.peers) {
      const [px, py, w, h] = this.rangeRect(p.range);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, w - 2, h - 2);
      ctx.font = `11px ${FONT}`;
      const tw = ctx.measureText(p.name).width + 8;
      ctx.fillStyle = p.color;
      ctx.fillRect(px + w - tw, py - 14, tw, 14);
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.fillText(p.name, px + w - tw + 4, py - 7);
    }
    ctx.restore();
  }

  /** Keeps the input box over the active cell: invisible when idle, the editor while editing. */
  private placeInput(): void {
    const m = this.mergeOf(this.active.row, this.active.col);
    const [left, top, w, h] = this.rangeRect(
      m ? { r0: m[0], c0: m[1], r1: m[2], c1: m[3] } : { r0: this.active.row, c0: this.active.col, r1: this.active.row, c1: this.active.col },
    );
    const s = this.input.style;
    s.left = `${Math.max(HEADER_W, left)}px`;
    s.top = `${Math.max(HEADER_H, top)}px`;
    s.minWidth = `${w}px`;
    s.height = `${h}px`;
    this.input.classList.toggle("editing", this.editing);
  }

  // ---------- selection ----------

  select(cell: Cell, extend: boolean): void {
    this.active = { row: clamp(cell.row, 0, MAX_ROWS - 1), col: clamp(cell.col, 0, MAX_COLS - 1) };
    if (!extend) this.anchor = { ...this.active };
    this.scrollIntoView(this.active);
    this.events.selection(this.active, this.selection);
    this.invalidate();
  }

  private scrollIntoView(c: Cell): void {
    const [fr, fc] = this.freeze;
    const top = this.rows.offset(c.row);
    const bottom = top + this.rows.size(c.row);
    const left = this.cols.offset(c.col);
    const right = left + this.cols.size(c.col);
    const viewH = this.scroller.clientHeight - HEADER_H;
    const viewW = this.scroller.clientWidth - HEADER_W;
    if (c.row >= this.rows.count - 50 && this.rows.count < MAX_ROWS) {
      this.rows.count = Math.min(MAX_ROWS, Math.max(this.rows.count + 1000, c.row + 100));
      this.resizeSpacer();
    }
    if (c.col >= this.cols.count - 2 && this.cols.count < MAX_COLS) {
      this.cols.count = Math.min(MAX_COLS, Math.max(this.cols.count + 26, c.col + 5));
      this.resizeSpacer();
    }
    // Content under the frozen panes is hidden, so the scrolling area starts after them.
    if (c.row >= fr) {
      if (top - this.frozenH < this.scroller.scrollTop) this.scroller.scrollTop = top - this.frozenH;
      else if (bottom > this.scroller.scrollTop + viewH) this.scroller.scrollTop = bottom - viewH;
    }
    if (c.col >= fc) {
      if (left - this.frozenW < this.scroller.scrollLeft) this.scroller.scrollLeft = left - this.frozenW;
      else if (right > this.scroller.scrollLeft + viewW) this.scroller.scrollLeft = right - viewW;
    }
  }

  /** Content offset along an axis for a screen offset past the header (frozen lines don't scroll). */
  private contentX(px: number): number {
    const lx = px - HEADER_W;
    return lx < this.frozenW ? lx : lx + this.scroller.scrollLeft;
  }
  private contentY(py: number): number {
    const ly = py - HEADER_H;
    return ly < this.frozenH ? ly : ly + this.scroller.scrollTop;
  }

  private hit(e: PointerEvent | MouseEvent): Cell | null {
    const rect = this.scroller.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px > this.scroller.clientWidth || py > this.scroller.clientHeight) return null; // scrollbars
    const col = px < HEADER_W ? -1 : this.cols.indexAt(this.contentX(px));
    const row = py < HEADER_H ? -1 : this.rows.indexAt(this.contentY(py));
    return { row, col };
  }

  /** The header border under the pointer (within 4px), if any. */
  private borderAt(e: PointerEvent): { axis: "col" | "row"; index: number } | null {
    const rect = this.scroller.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (py < HEADER_H && px > HEADER_W) {
      const abs = this.contentX(px);
      const c = this.cols.indexAt(abs);
      const edge = this.cols.offset(c + 1);
      if (Math.abs(abs - edge) <= 4) return { axis: "col", index: c };
      if (c > 0 && Math.abs(abs - this.cols.offset(c)) <= 4) return { axis: "col", index: c - 1 };
    } else if (px < HEADER_W && py > HEADER_H) {
      const abs = this.contentY(py);
      const r = this.rows.indexAt(abs);
      const edge = this.rows.offset(r + 1);
      if (Math.abs(abs - edge) <= 3) return { axis: "row", index: r };
      if (r > 0 && Math.abs(abs - this.rows.offset(r)) <= 3) return { axis: "row", index: r - 1 };
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    // Only the primary button selects; a right-button press leaves the selection for the
    // context menu (onContextMenu adjusts it when the click lands outside).
    if (e.button !== 0) return;
    const border = this.borderAt(e);
    if (border) {
      e.preventDefault();
      const ax = border.axis === "col" ? this.cols : this.rows;
      this.resizing = { ...border, start: border.axis === "col" ? e.clientX : e.clientY, size: ax.size(border.index) };
      this.resizePreview = this.resizing.size;
      this.scroller.setPointerCapture(e.pointerId);
      return;
    }
    if (this.nearHandle(e)) {
      e.preventDefault();
      if (this.editing) void this.commit();
      this.filling = { source: this.selection, target: this.selection };
      this.scroller.setPointerCapture(e.pointerId);
      return;
    }
    const h = this.hit(e);
    if (!h) return;
    e.preventDefault();
    if (this.editing) void this.commit();
    if (h.row >= 0 && h.col >= 0 && this.onFilterButton(e, h)) return;
    if (h.row < 0 && h.col < 0) {
      this.anchor = { row: 0, col: 0 };
      this.active = { row: MAX_ROWS - 1, col: MAX_COLS - 1 };
      this.events.selection(this.active, this.selection);
      this.invalidate();
    } else if (h.row < 0) {
      this.anchor = { row: 0, col: h.col };
      this.active = { row: MAX_ROWS - 1, col: h.col };
      this.events.selection({ row: 0, col: h.col }, this.selection);
      this.invalidate();
    } else if (h.col < 0) {
      this.anchor = { row: h.row, col: 0 };
      this.active = { row: h.row, col: MAX_COLS - 1 };
      this.events.selection({ row: h.row, col: 0 }, this.selection);
      this.invalidate();
    } else {
      this.select(h, e.shiftKey);
      this.dragging = true;
      this.scroller.setPointerCapture(e.pointerId);
    }
    this.focus();
  }

  private onContextMenu(e: MouseEvent): void {
    const h = this.hit(e);
    if (!h) return;
    e.preventDefault();
    if (this.editing) void this.commit();
    const sel = this.selection;
    const inside =
      (h.row < 0 || (h.row >= sel.r0 && h.row <= sel.r1)) && (h.col < 0 || (h.col >= sel.c0 && h.col <= sel.c1));
    if (!inside) {
      if (h.row < 0 && h.col >= 0) this.selectLines("col", h.col, h.col);
      else if (h.col < 0 && h.row >= 0) this.selectLines("row", h.row, h.row);
      else if (h.row >= 0 && h.col >= 0) this.select(h, false);
    }
    this.focus();
    this.events.contextMenu?.({ x: e.clientX, y: e.clientY, row: h.row, col: h.col });
  }

  /** Selects whole columns or rows `a..=b`. */
  selectLines(axis: "col" | "row", a: number, b: number): void {
    if (axis === "col") {
      this.anchor = { row: 0, col: a };
      this.active = { row: MAX_ROWS - 1, col: b };
      this.events.selection({ row: 0, col: a }, this.selection);
    } else {
      this.anchor = { row: a, col: 0 };
      this.active = { row: b, col: MAX_COLS - 1 };
      this.events.selection({ row: a, col: 0 }, this.selection);
    }
    this.invalidate();
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.resizing) {
      const delta = (this.resizing.axis === "col" ? e.clientX : e.clientY) - this.resizing.start;
      this.resizePreview = Math.max(this.resizing.axis === "col" ? 8 : 6, Math.round(this.resizing.size + delta));
      const ax = this.resizing.axis === "col" ? this.cols : this.rows;
      ax.apply(this.resizing.index, [this.resizePreview]);
      this.resizeSpacer();
      this.invalidate();
      return;
    }
    if (this.filling) {
      const h = this.hit(e);
      if (h && h.row >= 0 && h.col >= 0) this.filling.target = fillTarget(this.filling.source, h);
      this.invalidate();
      return;
    }
    const border = this.borderAt(e);
    this.scroller.style.cursor = border ? (border.axis === "col" ? "col-resize" : "row-resize") : this.nearHandle(e) ? "crosshair" : "";
    if (!this.dragging) return;
    const h = this.hit(e);
    if (!h || h.row < 0 || h.col < 0) return;
    if (h.row !== this.active.row || h.col !== this.active.col) this.select(h, true);
  }

  private async onPointerUp(e: PointerEvent): Promise<void> {
    this.dragging = false;
    const fill = this.filling;
    if (fill) {
      this.filling = null;
      this.scroller.releasePointerCapture(e.pointerId);
      const t = fill.target;
      const s0 = fill.source;
      if (t.r0 === s0.r0 && t.r1 === s0.r1 && t.c0 === s0.c0 && t.c1 === s0.c1) return this.invalidate();
      if (await this.run("edit.autoFill", { source: rangeA1(s0), target: rangeA1(t) })) {
        this.select({ row: t.r0, col: t.c0 }, false);
        this.select({ row: t.r1, col: t.c1 }, true);
      }
      return;
    }
    const r = this.resizing;
    if (!r) return;
    this.resizing = null;
    this.scroller.releasePointerCapture(e.pointerId);
    const size = this.resizePreview ?? r.size;
    this.resizePreview = null;
    if (size === r.size) return;
    // A drag on a selected header resizes every selected line, as in other spreadsheets.
    const sel = this.selection;
    const whole = r.axis === "col" ? sel.r0 === 0 && sel.r1 === MAX_ROWS - 1 : sel.c0 === 0 && sel.c1 === MAX_COLS - 1;
    const [lo, hi] = r.axis === "col" ? [sel.c0, sel.c1] : [sel.r0, sel.r1];
    const [a, b] = whole && r.index >= lo && r.index <= hi ? [lo, hi] : [r.index, r.index];
    if (r.axis === "col") await this.run("home.columnWidth", { cols: `${colName(a)}:${colName(b)}`, width: size });
    else await this.run("home.rowHeight", { rows: `${a + 1}:${b + 1}`, height: size });
    this.fetched = null; // re-read line sizes from the engine
  }

  /** Whether the pointer is on the fill handle. */
  private nearHandle(e: PointerEvent): boolean {
    if (this.readOnly || this.editing) return false;
    const sel = this.selection;
    if (sel.r1 >= MAX_ROWS - 1 || sel.c1 >= MAX_COLS - 1) return false;
    const rect = this.scroller.getBoundingClientRect();
    const [hx, hy] = this.handlePoint();
    return Math.abs(e.clientX - rect.left - hx) <= 5 && Math.abs(e.clientY - rect.top - hy) <= 5;
  }

  /** A click on a filter button opens the filter menu (via the `filterButton` event). */
  private onFilterButton(e: PointerEvent, h: Cell): boolean {
    const f = this.filter;
    if (!f || h.row !== f.range[0] || h.col < f.range[1] || h.col > f.range[3]) return false;
    const rect = this.scroller.getBoundingClientRect();
    const [bx, by, bw, bh] = this.filterButtonRect(h.row, h.col);
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px < bx || px > bx + bw || py < by || py > by + bh) return false;
    this.select(h, false);
    this.focus();
    const [r0, c0, r1, c1] = f.range;
    this.events.filterButton?.({ x: rect.left + bx, y: rect.top + by + bh, col: h.col, range: { r0, c0, r1, c1 } });
    return true;
  }

  /** The filter range on the active sheet, if any. */
  get filterRange(): Range | null {
    const f = this.filter;
    return f ? { r0: f.range[0], c0: f.range[1], r1: f.range[2], c1: f.range[3] } : null;
  }

  // ---------- clipboard ----------

  /** Copy/cut: the engine records the range (formulas, formats) and returns its text for other apps. */
  private onCopy(e: ClipboardEvent, id: "edit.copy" | "edit.cut"): void {
    if (this.editing) return; // the editor's own text selection
    e.preventDefault();
    const range = rangeA1(this.clampToUsed(this.selection));
    void this.engine
      .execute(id, { range })
      .then(async (r) => {
        const text = (r.result as { text?: string } | null)?.text ?? "";
        this.copiedText = text;
        await navigator.clipboard.writeText(text);
        this.events.copied?.(range, id === "edit.cut");
      })
      .catch((err) => this.events.error(String(err)));
  }

  /** Paste: the engine pastes its own copy (formulas shifted, formats kept) or parses external text. */
  private onPaste(e: ClipboardEvent): void {
    if (this.editing) return;
    e.preventDefault();
    let text = e.clipboardData?.getData("text/plain") ?? "";
    // Our own copy coming back: give the engine its original text so it pastes formulas and formats.
    if (this.copiedText !== null && sameText(text, this.copiedText)) text = this.copiedText;
    const html = e.clipboardData?.getData("text/html") ?? "";
    const sel = this.selection;
    void this.run("edit.paste", { at: a1(sel.r0, sel.c0), text, ...(html ? { html } : {}) });
  }

  /** Whole-column/row selections shrink to the used area so copying them stays small. */
  private clampToUsed(r: Range): Range {
    const [ur, uc] = this.usedEnd ?? [0, 0];
    return { r0: r.r0, c0: r.c0, r1: Math.max(r.r0, Math.min(r.r1, ur)), c1: Math.max(r.c0, Math.min(r.c1, uc)) };
  }

  // ---------- editing ----------

  /** Starts editing the active cell. `initial` null = edit the existing content (F2). */
  async beginEdit(initial: string | null): Promise<void> {
    if (this.editing || this.readOnly) return;
    this.editing = true;
    this.input.value = initial ?? (await this.engine.editText(this.active.row, this.active.col));
    this.invalidate();
    this.focus();
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
    this.events.selection(this.active, this.selection);
  }

  cancelEdit(): void {
    this.editing = false;
    this.input.value = "";
    this.invalidate();
  }

  /** Writes the editor's text into the active cell. */
  async commit(): Promise<void> {
    if (!this.editing) return;
    const text = this.input.value;
    const cell = a1(this.active.row, this.active.col);
    this.editing = false;
    this.input.value = "";
    await this.run("cell.set", { cell, input: text });
  }

  /** Runs an engine command and repaints. Errors are reported, never thrown. */
  async run(id: string, params: unknown = {}): Promise<boolean> {
    if (this.readOnly && !id.startsWith("sheet.activate") && id !== "edit.copy") {
      this.events.error("Still connecting; edits will be possible in a moment.");
      return false;
    }
    try {
      const r = await this.engine.execute(id, params);
      this.markChanged(r.revision);
      return true;
    } catch (e) {
      this.events.error(e instanceof Error ? e.message : String(e));
      this.invalidate();
      return false;
    }
  }

  private onInput(): void {
    if (this.readOnly) {
      this.input.value = "";
      return;
    }
    if (!this.editing) {
      // A printable key arrived while idle: it starts an edit that replaces the cell.
      const typed = this.input.value;
      this.editing = true;
      this.input.value = typed;
      this.invalidate();
    }
    this.events.selection(this.active, this.selection);
  }

  private move(dr: number, dc: number, extend: boolean): void {
    let { row, col } = this.active;
    const m = this.mergeOf(row, col);
    if (m && !extend) {
      if (dr > 0) row = m[2];
      if (dr < 0) row = m[0];
      if (dc > 0) col = m[3];
      if (dc < 0) col = m[1];
    }
    row += dr;
    col += dc;
    const to = this.mergeOf(row, col);
    if (to && !extend) {
      row = to[0];
      col = to[1];
    }
    this.select({ row, col }, extend);
  }

  private async onKey(e: KeyboardEvent): Promise<void> {
    const mod = e.ctrlKey || e.metaKey;
    if (this.editing) {
      if (e.key === "Enter" && !e.altKey) {
        e.preventDefault();
        // Move first: commit() captures the text and cell synchronously, so the next keystrokes
        // land in the next cell even while the engine is still applying this one.
        const saved = this.commit();
        this.move(e.shiftKey ? -1 : 1, 0, false);
        await saved;
      } else if (e.key === "Tab") {
        e.preventDefault();
        const saved = this.commit();
        this.move(0, e.shiftKey ? -1 : 1, false);
        await saved;
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancelEdit();
      }
      return;
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const range = rangeA1(this.selection);
      // Toggles state the new value from the active cell: the engine's own active cell isn't
      // shared with collaborators, so it mustn't decide.
      const st = this.styles.get(this.cellAt(this.active.row, this.active.col)?.[4] ?? 0);
      const commands: Record<string, [string, unknown]> = {
        z: e.shiftKey ? ["edit.redo", {}] : ["edit.undo", {}],
        y: ["edit.redo", {}],
        b: ["home.bold", { range, on: !st?.b }],
        i: ["home.italic", { range, on: !st?.i }],
        u: ["home.underline", { range, on: !st?.u }],
      };
      const cmd = commands[k];
      if (cmd) {
        e.preventDefault();
        await this.run(cmd[0], cmd[1]);
      } else if (k === "a") {
        e.preventDefault();
        this.anchor = { row: 0, col: 0 };
        this.active = { row: MAX_ROWS - 1, col: MAX_COLS - 1 };
        this.events.selection({ row: 0, col: 0 }, this.selection);
        this.invalidate();
      } else if (k === "home") {
        e.preventDefault();
        this.select({ row: 0, col: 0 }, e.shiftKey);
      }
      return;
    }
    const nav: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const page = Math.max(1, this.visible().r1 - this.visible().r0);
    if (nav[e.key]) {
      e.preventDefault();
      this.move(nav[e.key][0], nav[e.key][1], e.shiftKey);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      this.move(e.key === "PageDown" ? page : -page, 0, e.shiftKey);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.move(e.shiftKey ? -1 : 1, 0, false);
    } else if (e.key === "Tab") {
      e.preventDefault();
      this.move(0, e.shiftKey ? -1 : 1, false);
    } else if (e.key === "Home") {
      e.preventDefault();
      this.select({ row: this.active.row, col: 0 }, e.shiftKey);
    } else if (e.key === "F2") {
      e.preventDefault();
      await this.beginEdit(null);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      await this.run("edit.clearContents", { range: rangeA1(this.selection) });
    }
  }
}

/** The range a fill-handle drag to `to` fills: the source extended along the axis dragged furthest. */
export function fillTarget(src: Range, to: Cell): Range {
  const down = to.row > src.r1 ? to.row - src.r1 : 0;
  const up = to.row < src.r0 ? src.r0 - to.row : 0;
  const rightward = to.col > src.c1 ? to.col - src.c1 : 0;
  const leftward = to.col < src.c0 ? src.c0 - to.col : 0;
  if (Math.max(down, up) >= Math.max(rightward, leftward)) {
    if (down) return { ...src, r1: to.row };
    if (up) return { ...src, r0: to.row };
    return src;
  }
  if (rightward) return { ...src, c1: to.col };
  return { ...src, c0: to.col };
}

/** Breaks text into lines that fit `width`: at spaces, and inside words longer than a line. */
export function wrapLines(ctx: { measureText(t: string): { width: number } }, text: string, width: number): string[] {
  const fits = (t: string) => ctx.measureText(t).width <= width;
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      line = "";
      // The word alone: split it by characters when it is wider than the cell.
      for (const ch of word) {
        if (line && !fits(line + ch)) {
          out.push(line);
          line = ch;
        } else line += ch;
      }
    }
    out.push(line);
  }
  return out;
}

/** Equal apart from line-ending style and trailing newlines. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return norm(a) === norm(b);
}

function key(r: number, c: number): number {
  return r * MAX_COLS + c;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
