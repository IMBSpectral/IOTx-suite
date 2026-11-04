/**
 * The Sheets editor's data and saving, outside React: cells loaded from
 * Google in blocks of rows, changes shown at once and sent to Google in
 * batches (debounced), an undo stack of the inverse changes, and a refresh
 * that picks up other people's edits. The editor re-renders on change().
 */
import { DEFAULT_COL, DEFAULT_ROW, restoreCells, type Cell, type Op, type Range, type Tab } from "./model";

export const CHUNK = 200;
export type EditorFile = { id: string; name: string; webViewLink: string; starred?: boolean; modifiedTime: string; owners?: { displayName?: string }[]; capabilities?: { canEdit?: boolean } };
export type Meta = { file: EditorFile; title: string; locale: string; timeZone: string; tabs: Tab[]; canEdit: boolean; connection: { email: string; canEdit: boolean } };
type Store = { rows: Map<number, (Cell | null)[]>; chunks: Map<number, "loading" | "ok" | "stale">; rowPx: Map<number, number>; colPx: number[] };
export type Entry = { label: string; redo: Op[]; undo: Op[] | null; how: "cells" | "all" };
export type SaveState = { state: "idle" | "saving" | "saved" | "error"; error?: string; at?: number };

export class SheetEngine {
  meta: Meta | null = null;
  loadError: { text: string; connect?: boolean; reconnect?: boolean } | null = null;
  save: SaveState = { state: "idle" };
  /** Bumped whenever a row height or column width changes. */
  geom = 0;
  private stores = new Map<number, Store>();
  private pending: Op[] = [];
  private inflight = false;
  private how: "cells" | "all" | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failed: Op[] = [];
  private gen = 0;
  private undos: Entry[] = [];
  private redos: Entry[] = [];
  private visible: { sheetId: number; r0: number; r1: number } | null = null;
  private visTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    private change: () => void,
  ) {}

  private url(q = "") {
    return `/api/google/sheets/${encodeURIComponent(this.id)}${q}`;
  }

  // ── Reading ──
  tab(sheetId: number) {
    return this.meta?.tabs.find((t) => t.sheetId === sheetId) ?? null;
  }
  private store(sheetId: number) {
    let s = this.stores.get(sheetId);
    if (!s) this.stores.set(sheetId, (s = { rows: new Map(), chunks: new Map(), rowPx: new Map(), colPx: [] }));
    return s;
  }
  cell(sheetId: number, r: number, c: number): Cell | null | undefined {
    return this.stores.get(sheetId)?.rows.get(r)?.[c];
  }
  isLoaded(sheetId: number, r0: number, r1: number) {
    const s = this.stores.get(sheetId);
    if (!s) return false;
    for (let k = Math.floor(r0 / CHUNK); k <= Math.floor(r1 / CHUNK); k++) if (!s.chunks.has(k) || s.chunks.get(k) === "loading") return false;
    return true;
  }
  /** Row heights and column widths in pixels (Google's defaults until loaded). */
  sizes(tab: Tab) {
    const s = this.store(tab.sheetId);
    const rows = new Float64Array(tab.rowCount).fill(DEFAULT_ROW);
    for (const [r, px] of s.rowPx) if (r < tab.rowCount) rows[r] = px;
    const cols = new Float64Array(tab.colCount).fill(DEFAULT_COL);
    s.colPx.forEach((px, c) => c < tab.colCount && (cols[c] = px));
    return { rows, cols };
  }
  get canUndo() {
    return this.undos.length > 0;
  }
  get canRedo() {
    return this.redos.length > 0;
  }
  get busy() {
    return this.inflight || this.pending.length > 0;
  }

  // ── Loading ──
  async loadMeta(touch = false) {
    const r = await fetch(this.url(`?view=meta${touch ? "&touch=1" : ""}`));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (!this.meta) this.loadError = { text: d.error ?? "Couldn't open the spreadsheet.", connect: !!d.connect, reconnect: !!d.reconnect };
      this.change();
      return false;
    }
    this.meta = d as Meta;
    this.loadError = null;
    this.change();
    return true;
  }

  private async loadChunk(tab: Tab, k: number) {
    const s = this.store(tab.sheetId);
    const had = s.chunks.has(k) && s.chunks.get(k) !== "loading";
    s.chunks.set(k, "loading");
    const gen = this.gen;
    const r0 = k * CHUNK;
    const r1 = Math.min(tab.rowCount, r0 + CHUNK);
    try {
      const r = await fetch(this.url(`?view=grid&${new URLSearchParams({ tab: tab.title, r0: String(r0), r1: String(r1), cols: String(tab.colCount) })}`));
      const d = (await r.json()) as { rows?: (Cell | null)[][]; rowPx?: number[]; colPx?: number[]; error?: string };
      if (!r.ok) throw new Error(d.error);
      // Local changes made meanwhile win; this block is read again after they're saved.
      if (had && (gen !== this.gen || this.busy)) {
        s.chunks.set(k, "stale");
        return;
      }
      for (let i = 0; i < r1 - r0; i++) {
        s.rows.set(r0 + i, d.rows?.[i] ?? []);
        const px = d.rowPx?.[i];
        const before = s.rowPx.get(r0 + i) ?? DEFAULT_ROW;
        if (px !== undefined && px !== DEFAULT_ROW) s.rowPx.set(r0 + i, px);
        else s.rowPx.delete(r0 + i);
        if ((px ?? DEFAULT_ROW) !== before) this.geom++;
      }
      if (d.colPx?.length && d.colPx.join() !== s.colPx.join()) {
        s.colPx = d.colPx;
        this.geom++;
      }
      s.chunks.set(k, "ok");
      this.change();
    } catch {
      if (had) s.chunks.set(k, "stale");
      else s.chunks.delete(k);
    }
  }

  /** The grid reports the rows in view; missing or stale blocks load shortly after scrolling settles. */
  show(sheetId: number, r0: number, r1: number) {
    this.visible = { sheetId, r0, r1 };
    clearTimeout(this.visTimer);
    this.visTimer = setTimeout(() => this.loadVisible(), this.stores.has(sheetId) ? 120 : 0);
  }
  private loadVisible(force = false) {
    const v = this.visible;
    const tab = v && this.tab(v.sheetId);
    if (!v || !tab) return;
    const s = this.store(tab.sheetId);
    for (let k = Math.floor(v.r0 / CHUNK); k <= Math.floor(Math.max(v.r0, v.r1 - 1) / CHUNK); k++) {
      const st = s.chunks.get(k);
      if (force ? st !== "loading" : !st || st === "stale") void this.loadChunk(tab, k);
    }
  }
  /** Load every block a range needs (for undo snapshots of sorts and whole columns); up to 5,000 rows. */
  async ensure(sheetId: number, g: Range) {
    const tab = this.tab(sheetId);
    if (!tab) return false;
    const r1 = Math.min(g.r1, tab.rowCount - 1);
    if (r1 - g.r0 > 5000) return this.isLoaded(sheetId, g.r0, r1);
    const s = this.store(sheetId);
    const jobs = [];
    for (let k = Math.floor(g.r0 / CHUNK); k <= Math.floor(r1 / CHUNK); k++) if (!s.chunks.has(k)) jobs.push(this.loadChunk(tab, k));
    await Promise.all(jobs);
    return this.isLoaded(sheetId, g.r0, r1);
  }

  /** Others' edits: the layout and the rows in view, unless our own changes are still saving. */
  async refresh() {
    if (this.busy || !this.meta) return;
    const gen = this.gen;
    if (!(await this.loadMeta())) return;
    if (gen !== this.gen || this.busy) return;
    for (const s of this.stores.values()) for (const [k, st] of s.chunks) if (st === "ok") s.chunks.set(k, "stale");
    this.loadVisible(true);
  }

  /** After rows or columns moved (insert, delete, sort): forget the tab's cells and read them again. */
  private reset(sheetId?: number) {
    for (const [id, s] of this.stores) if (sheetId === undefined || id === sheetId) for (const k of s.chunks.keys()) s.chunks.set(k, "stale");
  }

  // ── Local changes (shown before Google confirms) ──
  edit(sheetId: number, r: number, c: number, fn: (cell: Cell) => Cell | null) {
    const s = this.store(sheetId);
    const row = s.rows.get(r) ?? [];
    row[c] = fn({ ...(row[c] ?? {}) });
    s.rows.set(r, row);
    this.gen++;
  }
  editRange(sheetId: number, g: Range, fn: (cell: Cell, r: number, c: number) => Cell | null) {
    const tab = this.tab(sheetId);
    const s = this.store(sheetId);
    const r1 = Math.min(g.r1, (tab?.rowCount ?? 1) - 1);
    const c1 = Math.min(g.c1, (tab?.colCount ?? 1) - 1);
    for (let r = g.r0; r <= r1; r++) {
      const row = s.rows.get(r);
      if (!row && !s.chunks.has(Math.floor(r / CHUNK))) continue;
      const out = row ?? [];
      for (let c = g.c0; c <= c1; c++) out[c] = fn({ ...(out[c] ?? {}) }, r, c);
      s.rows.set(r, out);
    }
    this.gen++;
  }
  setTab(sheetId: number, patch: Partial<Tab>) {
    if (!this.meta) return;
    this.meta = { ...this.meta, tabs: this.meta.tabs.map((t) => (t.sheetId === sheetId ? { ...t, ...patch } : t)) };
  }
  /** Replace the tab list (added, deleted or reordered tabs, shown before Google confirms). */
  setTabs(fn: (tabs: Tab[]) => Tab[]) {
    if (this.meta) this.meta = { ...this.meta, tabs: fn(this.meta.tabs) };
  }
  setColPx(sheetId: number, c: number, px: number) {
    const s = this.store(sheetId);
    const tab = this.tab(sheetId);
    while (s.colPx.length < (tab?.colCount ?? c + 1)) s.colPx.push(DEFAULT_COL);
    s.colPx[c] = px;
    this.geom++;
  }
  setRowPx(sheetId: number, r: number, px: number) {
    const s = this.store(sheetId);
    if (px === DEFAULT_ROW) s.rowPx.delete(r);
    else s.rowPx.set(r, px);
    this.geom++;
  }
  setFile(patch: Partial<EditorFile>) {
    if (this.meta) this.meta = { ...this.meta, file: { ...this.meta.file, ...patch }, title: patch.name ?? this.meta.title };
    this.change();
  }

  /** Cells as they are now, as a request that puts them back (for undo); null if they aren't all loaded. */
  async snapshot(sheetId: number, g: Range, fields = "userEnteredValue,userEnteredFormat,note") {
    const tab = this.tab(sheetId);
    if (!tab) return null;
    const box = { r0: g.r0, c0: g.c0, r1: Math.min(g.r1, tab.rowCount - 1), c1: Math.min(g.c1, tab.colCount - 1) };
    if ((box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1) > 100_000) return null;
    if (!(await this.ensure(sheetId, box))) return null;
    const req = restoreCells(sheetId, box, (r, c) => this.cell(sheetId, r, c));
    (req.updateCells as { fields: string }).fields = fields;
    return req;
  }

  // ── Saving ──
  /** Do a change: remember how to undo it, show it, and send it to Google. */
  apply(entry: Entry) {
    this.undos.push(entry);
    if (this.undos.length > 100) this.undos.shift();
    this.redos = [];
    this.queue(entry.redo, entry.how);
  }
  undo() {
    const e = this.undos.pop();
    if (!e) return null;
    if (!e.undo) {
      this.change();
      return e;
    }
    this.redos.push(e);
    this.queue(e.undo, "all", 0);
    return e;
  }
  redo() {
    const e = this.redos.pop();
    if (!e) return null;
    this.undos.push(e);
    this.queue(e.redo, "all", 0);
    return e;
  }

  queue(ops: Op[], how: "cells" | "all" = "cells", delay = 500) {
    this.pending.push(...ops);
    this.how = how === "all" || this.how === "all" ? "all" : "cells";
    this.save = { state: "saving" };
    this.change();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), how === "all" ? 0 : delay);
  }

  /** Send what's waiting, merging neighbouring writes of the same kind into one call. */
  async flush(): Promise<void> {
    if (this.inflight || !this.pending.length) return;
    const ops: Op[] = [];
    for (const op of this.pending.splice(0)) {
      const last = ops[ops.length - 1];
      if (last?.t === "values" && op.t === "values") last.data.push(...op.data);
      else if (last?.t === "batch" && op.t === "batch") last.requests.push(...op.requests);
      else ops.push(op.t === "values" ? { t: "values", data: [...op.data] } : { t: "batch", requests: [...op.requests] });
    }
    this.inflight = true;
    try {
      const r = await fetch(this.url(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "write", ops }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Google didn't accept the change.");
    } catch (e) {
      this.inflight = false;
      this.failed = ops;
      this.pending = [];
      this.how = null;
      this.save = { state: "error", error: (e as Error).message || "Couldn't save to Google." };
      // Show what Google actually has.
      this.reset();
      await this.loadMeta();
      this.loadVisible(true);
      this.change();
      return;
    }
    this.inflight = false;
    if (this.pending.length) return this.flush();
    const how = this.how;
    this.how = null;
    this.save = { state: "saved", at: Date.now() };
    if (how === "all") {
      this.reset();
      await this.loadMeta();
    } else for (const s of this.stores.values()) for (const [k, st] of s.chunks) if (st === "ok") s.chunks.set(k, "stale");
    this.loadVisible(true);
    this.change();
  }
  retry() {
    const ops = this.failed;
    this.failed = [];
    if (ops.length) this.queue(ops, "all", 0);
  }
  dismissError() {
    this.failed = [];
    this.save = { state: "idle" };
    this.change();
  }
}
