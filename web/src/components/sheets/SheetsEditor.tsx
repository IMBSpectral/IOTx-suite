"use client";

import "./sheets.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, CloudCheck, CloudOff, Copy, Database, ExternalLink, LoaderCircle, Lock, Menu as MenuIcon, Pencil, Plus, Sheet, Star, Trash } from "lucide-react";
import { usePerms } from "@/components/iotx/PermsProvider";
import Grid, { type Editing, type GridApi, type Sel } from "./Grid";
import Toolbar, { FUNCTIONS, Palette, ZOOMS, type BorderKind, type Tools } from "./Toolbar";
import { Dropdown, MenuList, useDismiss, type Item } from "./Menu";
import { SheetEngine, type Entry } from "./engine";
import { useTabTitle } from "@/components/iotx/tabs";
import {
  a1,
  changeDecimals,
  colName,
  currencyPattern,
  fmtNum,
  fromHex,
  getUF,
  gridRange,
  inputOf,
  NUMBER_FORMATS,
  offsets,
  parseRef,
  parseTSV,
  patchUF,
  quoteTab,
  rangeA1,
  restoreCells,
  SIZES,
  stats,
  toHex,
  toTSV,
  norm,
  type Op,
  type Range,
  type Tab,
} from "./model";

type Dialog = null | { kind: "find" } | { kind: "link" } | { kind: "note" } | { kind: "live" } | { kind: "trash" } | { kind: "deleteTab"; sheetId: number };
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * A Google Sheets file, edited the way Google Sheets does it: title, menus,
 * toolbar, formula bar, the grid and the sheet tabs. Values are written as if
 * typed (USER_ENTERED) so Google computes formulas; formats, merges, sizes,
 * rows and columns, sorting, filters and tabs go through batchUpdate. Every
 * change is shown at once, saved in batches, and can be undone.
 */
export default function SheetsEditor({ id }: { id: string }) {
  const router = useRouter();
  const perms = usePerms();
  const [ver, setVer] = useState(0);
  const [eng] = useState(() => new SheetEngine(id, () => setVer((v) => v + 1)));
  const meta = eng.meta;
  useTabTitle(meta?.file.name);
  const [tabId, setTabId] = useState<number | null>(null);
  const tab: Tab | null = meta ? (meta.tabs.find((t) => t.sheetId === tabId) ?? meta.tabs.find((t) => !t.hidden) ?? meta.tabs[0] ?? null) : null;
  const sid = tab?.sheetId ?? 0;
  const [sel, setSel] = useState<Sel>({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [refPick, setRefPick] = useState<{ range: Range; start: number; end: number } | null>(null);
  const [clip, setClip] = useState<{ sheetId: number; range: Range; cut: boolean; tsv: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [ctx, setCtx] = useState<{ x: number; y: number; kind: "cell" | "row" | "col" | "corner" } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ c: number; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToastText] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [showFx, setShowFx] = useState(true);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [stat, setStat] = useState<"Sum" | "Average" | "Min" | "Max" | "Count" | "Count (filled)">("Sum");
  const [renamingTab, setRenamingTab] = useState<{ sheetId: number; text: string } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const grid = useRef<GridApi>(null);
  const root = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const fxInput = useRef<HTMLTextAreaElement>(null);

  const say = useCallback((text: string) => {
    setToastText(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(null), 4500);
  }, []);

  // Load, then keep in step with others' edits: every 20 seconds and when the window regains focus.
  useEffect(() => {
    void eng.loadMeta(true);
    const t = setInterval(() => void eng.refresh(), 20_000);
    const focus = () => void eng.refresh();
    window.addEventListener("focus", focus);
    const leave = (e: BeforeUnloadEvent) => {
      if (eng.busy) e.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", focus);
      window.removeEventListener("beforeunload", leave);
      void eng.flush();
    };
  }, [eng]);

  // Fill the space below whatever bar sits above the editor.
  const opened = !!eng.meta;
  useEffect(() => {
    if (!opened) return;
    const fit = () => {
      const el = root.current;
      if (el) setHeight(Math.max(320, Math.floor(window.innerHeight - el.getBoundingClientRect().top)));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    if (root.current) ro.observe(root.current.parentElement ?? root.current);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [opened]);

  const readOnly = !meta?.canEdit;
  const range = norm(sel.a, sel.f);
  const box = tab ? { r0: range.r0, c0: range.c0, r1: Math.min(range.r1, tab.rowCount - 1), c1: Math.min(range.c1, tab.colCount - 1) } : range;
  const cur = eng.cell(sid, sel.a.r, sel.a.c);
  const geom = eng.geom;
  const rowCount = tab?.rowCount ?? 0;
  const colCount = tab?.colCount ?? 0;
  const { sizes, rowOff, colOff } = useMemo(() => {
    const t = eng.tab(sid);
    const sz = t ? eng.sizes({ ...t, rowCount, colCount }) : null;
    return { sizes: sz, rowOff: offsets(sz?.rows ?? []), colOff: offsets(sz?.cols ?? []) };
    // geom changes when sizes load or are resized; the engine itself is the same object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, sid, rowCount, colCount, geom]);
  const merges = tab?.merges ?? [];
  const mergeAt = (r: number, c: number) => merges.find((m) => r >= (m.startRowIndex ?? 0) && r < (m.endRowIndex ?? 0) && c >= (m.startColumnIndex ?? 0) && c < (m.endColumnIndex ?? 0));
  const cellRef = (r: number, c: number) => `${quoteTab(tab?.title ?? "Sheet1")}!${a1(r, c)}`;

  const onVisible = useCallback((r0: number, r1: number) => eng.show(sid, r0, r1), [eng, sid]);
  const cellGet = useCallback((r: number, c: number) => eng.cell(sid, r, c), [eng, sid]);

  // ── Selection ──
  function select(s: Sel, scroll = true) {
    setSel(s);
    setNameDraft(null);
    if (scroll) requestAnimationFrame(() => grid.current?.scrollTo(s.f.r, s.f.c));
  }
  function moveBy(dr: number, dc: number, extend: boolean, from = extend ? sel.f : sel.a) {
    if (!tab || !sizes) return;
    let r = from.r;
    let c = from.c;
    // Step over rows hidden by a filter, and out of merged cells.
    const m = mergeAt(r, c);
    if (m && !extend) {
      if (dr > 0) r = (m.endRowIndex ?? r + 1) - 1;
      if (dc > 0) c = (m.endColumnIndex ?? c + 1) - 1;
    }
    r = Math.max(0, Math.min(tab.rowCount - 1, r + dr));
    while (dr && sizes.rows[r] === 0 && r > 0 && r < tab.rowCount - 1) r += Math.sign(dr);
    c = Math.max(0, Math.min(tab.colCount - 1, c + dc));
    const to = { r, c };
    const mm = mergeAt(r, c);
    const anchor = mm && !extend ? { r: mm.startRowIndex ?? r, c: mm.startColumnIndex ?? c } : to;
    select(extend ? { a: sel.a, f: to } : { a: anchor, f: anchor });
  }
  /** Ctrl+arrow: to the edge of the data, like Google. */
  function jump(dr: number, dc: number, extend: boolean) {
    if (!tab) return;
    const from = extend ? sel.f : sel.a;
    const filled = (r: number, c: number) => !!eng.cell(sid, r, c)?.v;
    let r = from.r;
    let c = from.c;
    const ok = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr < tab.rowCount && cc < tab.colCount;
    const startFilled = filled(r, c) && ok(r + dr, c + dc) && filled(r + dr, c + dc);
    const step = () => {
      r += dr;
      c += dc;
    };
    if (startFilled) while (ok(r + dr, c + dc) && filled(r + dr, c + dc)) step();
    else {
      step();
      while (ok(r, c) && !filled(r, c) && ok(r + dr, c + dc)) step();
    }
    r = Math.max(0, Math.min(tab.rowCount - 1, r));
    c = Math.max(0, Math.min(tab.colCount - 1, c));
    select(extend ? { a: sel.a, f: { r, c } } : { a: { r, c }, f: { r, c } });
  }

  // ── Editing cells ──
  function startEdit(r: number, c: number, text: string | null, mode: Editing["mode"]) {
    if (readOnly) return say("This spreadsheet is view only here.");
    const m = mergeAt(r, c);
    const rr = m ? (m.startRowIndex ?? r) : r;
    const cc = m ? (m.startColumnIndex ?? c) : c;
    setEditing({ r: rr, c: cc, text: text ?? inputOf(eng.cell(sid, rr, cc)), mode });
    setRefPick(null);
  }
  function writeCell(r: number, c: number, text: string) {
    if (!tab) return;
    const prev = eng.cell(sid, r, c);
    if (text === inputOf(prev)) return;
    const undo = restoreCells(sid, { r0: r, c0: c, r1: r, c1: c }, () => prev);
    (undo.updateCells as { fields: string }).fields = "userEnteredValue";
    eng.edit(sid, r, c, (cell) => {
      const num = NUM.test(text.trim()) ? Number(text) : undefined;
      return {
        ...cell,
        v: text.startsWith("=") ? "Loading…" : text,
        uv: text === "" ? undefined : text.startsWith("=") ? { formulaValue: text } : num !== undefined ? { numberValue: num } : { stringValue: text },
        num,
        err: undefined,
      };
    });
    eng.apply({ label: "Edit", redo: [{ t: "values", data: [{ range: cellRef(r, c), values: [[text]] }] }], undo: [{ t: "batch", requests: [undo] }], how: "cells" });
  }
  function commit(move: [number, number] | null) {
    const ed = editing;
    if (!ed) return;
    setEditing(null);
    setRefPick(null);
    writeCell(ed.r, ed.c, ed.text);
    if (move) moveBy(move[0], move[1], false, { r: ed.r, c: ed.c });
    // Focus moves now, so keys typed straight after Enter reach the grid.
    grid.current?.focus();
  }
  function cancel() {
    setEditing(null);
    setRefPick(null);
    grid.current?.focus();
  }
  function draft(text: string) {
    setEditing((e) => (e ? { ...e, text } : e));
    setRefPick(null);
  }
  function pickRef(g: Range) {
    if (!editing) return;
    const ref = g.r0 === g.r1 && g.c0 === g.c1 ? a1(g.r0, g.c0) : `${a1(g.r0, g.c0)}:${a1(g.r1, g.c1)}`;
    const start = refPick ? refPick.start : editing.text.length;
    const end = refPick ? refPick.end : editing.text.length;
    setEditing({ ...editing, text: editing.text.slice(0, start) + ref + editing.text.slice(end) });
    setRefPick({ range: g, start, end: start + ref.length });
  }

  // ── Changes ──
  const clampBox = (g: Range): Range => (tab ? { r0: Math.max(0, g.r0), c0: Math.max(0, g.c0), r1: Math.min(g.r1, tab.rowCount - 1), c1: Math.min(g.c1, tab.colCount - 1) } : g);
  const batch = (...requests: Record<string, unknown>[]): Op => ({ t: "batch", requests });
  function apply(label: string, redo: Op[], undo: Op[] | null, how: Entry["how"] = "all") {
    if (readOnly) return say("This spreadsheet is view only here.");
    eng.apply({ label, redo, undo, how });
  }
  /** Set one or more format fields on the selection (shown at once). */
  async function fmtMany(changes: [string, unknown][], label: string) {
    if (readOnly || !tab) return;
    const g = clampBox(range);
    const snap = await eng.snapshot(sid, g, "userEnteredFormat");
    let cellFmt: Record<string, unknown> = {};
    for (const [path, value] of changes) cellFmt = (patchUF(cellFmt, path, value) ?? {}) as Record<string, unknown>;
    eng.editRange(sid, g, (cell) => {
      let uf = cell.uf;
      for (const [path, value] of changes) uf = patchUF(uf, path, value);
      return { ...cell, uf };
    });
    apply(label, [batch({ repeatCell: { range: gridRange(sid, g), cell: { userEnteredFormat: cellFmt }, fields: changes.map(([p]) => `userEnteredFormat.${p}`).join(",") } })], snap ? [batch(snap)] : null, "cells");
    if (!snap) say(`${label} was applied. It's too large to undo here.`);
  }
  const fmt = (path: string, value: unknown, label: string) => void fmtMany([[path, value]], label);
  function colour(which: "text" | "fill", hex: string | null) {
    const base = which === "text" ? "textFormat.foregroundColor" : "backgroundColor";
    void fmtMany(hex ? [[`${base}Style`, { rgbColor: fromHex(hex) }]] : [[base, undefined], [`${base}Style`, undefined]], which === "text" ? "Text colour" : "Fill colour");
  }
  async function clearFormatting() {
    if (readOnly || !tab) return;
    const g = clampBox(range);
    const snap = await eng.snapshot(sid, g, "userEnteredFormat");
    eng.editRange(sid, g, (cell) => ({ ...cell, uf: undefined }));
    apply("Clear formatting", [batch({ repeatCell: { range: gridRange(sid, g), cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } })], snap ? [batch(snap)] : null, "cells");
  }
  async function clearValues(g = clampBox(range)) {
    if (readOnly || !tab) return;
    const snap = await eng.snapshot(sid, g, "userEnteredValue");
    eng.editRange(sid, g, (cell) => ({ ...cell, v: undefined, uv: undefined, num: undefined, bool: undefined, err: undefined }));
    apply("Delete values", [batch({ updateCells: { range: gridRange(sid, g), fields: "userEnteredValue" } })], snap ? [batch(snap)] : null, "cells");
  }
  async function borders(kind: BorderKind, color: string, style: string) {
    if (!tab) return;
    const g = clampBox(range);
    const b = kind === "clear" ? { style: "NONE" } : { style, colorStyle: { rgbColor: fromHex(color) } };
    const sides: Record<string, string[]> = {
      all: ["top", "bottom", "left", "right", "innerHorizontal", "innerVertical"],
      inner: ["innerHorizontal", "innerVertical"],
      horizontal: ["innerHorizontal"],
      vertical: ["innerVertical"],
      outer: ["top", "bottom", "left", "right"],
      left: ["left"],
      right: ["right"],
      top: ["top"],
      bottom: ["bottom"],
      clear: ["top", "bottom", "left", "right", "innerHorizontal", "innerVertical"],
    };
    // Borders are stored on neighbouring cells too, so undo covers one cell around.
    const around = clampBox({ r0: g.r0 - 1, c0: g.c0 - 1, r1: g.r1 + 1, c1: g.c1 + 1 });
    const snap = await eng.snapshot(sid, around, "userEnteredFormat.borders");
    apply("Borders", [batch({ updateBorders: { range: gridRange(sid, g), ...Object.fromEntries(sides[kind].map((s) => [s, b])) } })], snap ? [batch(snap)] : null, "cells");
  }
  async function merge(type: "MERGE_ALL" | "MERGE_COLUMNS" | "MERGE_ROWS" | "UNMERGE") {
    if (!tab) return;
    const g = clampBox(range);
    const inside = merges.filter((m) => (m.startRowIndex ?? 0) <= g.r1 && (m.endRowIndex ?? 0) > g.r0 && (m.startColumnIndex ?? 0) <= g.c1 && (m.endColumnIndex ?? 0) > g.c0);
    if (type === "UNMERGE") {
      if (!inside.length) return say("There are no merged cells there.");
      const all = inside.reduce((o, m) => ({ r0: Math.min(o.r0, m.startRowIndex ?? 0), c0: Math.min(o.c0, m.startColumnIndex ?? 0), r1: Math.max(o.r1, (m.endRowIndex ?? 1) - 1), c1: Math.max(o.c1, (m.endColumnIndex ?? 1) - 1) }), g);
      return apply("Unmerge", [batch({ unmergeCells: { range: gridRange(sid, all) } })], [batch(...inside.map((m) => ({ mergeCells: { range: m, mergeType: "MERGE_ALL" } })))]);
    }
    if (g.r0 === g.r1 && g.c0 === g.c1) return say("Select more than one cell to merge.");
    const snap = await eng.snapshot(sid, g);
    apply("Merge", [batch({ mergeCells: { range: gridRange(sid, g), mergeType: type } })], snap ? [batch({ unmergeCells: { range: gridRange(sid, g) } }, snap)] : null);
  }
  function numberFormat(nf: { type: string; pattern?: string } | null, label: string) {
    fmt("numberFormat", nf ?? undefined, label);
  }
  function insertDim(dim: "ROWS" | "COLUMNS", before: boolean) {
    if (!tab) return;
    const g = clampBox(range);
    const count = dim === "ROWS" ? g.r1 - g.r0 + 1 : g.c1 - g.c0 + 1;
    const start = dim === "ROWS" ? (before ? g.r0 : g.r1 + 1) : before ? g.c0 : g.c1 + 1;
    const dr = { sheetId: sid, dimension: dim, startIndex: start, endIndex: start + count };
    apply(`Insert ${dim === "ROWS" ? "rows" : "columns"}`, [batch({ insertDimension: { range: dr, inheritFromBefore: start > 0 } })], [batch({ deleteDimension: { range: dr } })]);
    eng.setTab(sid, dim === "ROWS" ? { rowCount: tab.rowCount + count } : { colCount: tab.colCount + count });
    const s = dim === "ROWS" ? { a: { r: start, c: sel.a.c }, f: { r: start + count - 1, c: sel.f.c } } : { a: { r: sel.a.r, c: start }, f: { r: sel.f.r, c: start + count - 1 } };
    select(s, false);
  }
  async function deleteDim(dim: "ROWS" | "COLUMNS") {
    if (!tab) return;
    const g = clampBox(range);
    const [a, b] = dim === "ROWS" ? [g.r0, g.r1 + 1] : [g.c0, g.c1 + 1];
    if (dim === "ROWS" ? b - a >= tab.rowCount - tab.frozenRows && b - a >= tab.rowCount : b - a >= tab.colCount) return say(`You can't delete all the ${dim === "ROWS" ? "rows" : "columns"} on a sheet.`);
    const area = dim === "ROWS" ? { r0: a, r1: b - 1, c0: 0, c1: tab.colCount - 1 } : { r0: 0, r1: tab.rowCount - 1, c0: a, c1: b - 1 };
    const snap = await eng.snapshot(sid, area);
    const dr = { sheetId: sid, dimension: dim, startIndex: a, endIndex: b };
    apply(`Delete ${dim === "ROWS" ? "rows" : "columns"}`, [batch({ deleteDimension: { range: dr } })], snap ? [batch({ insertDimension: { range: dr, inheritFromBefore: a > 0 } }, snap)] : null);
    eng.setTab(sid, dim === "ROWS" ? { rowCount: tab.rowCount - (b - a) } : { colCount: tab.colCount - (b - a) });
    if (!snap) say("Deleted. This sheet is too large to undo that here.");
  }
  async function sort(scope: "sheet" | "range", asc: boolean, column = sel.a.c) {
    if (!tab) return;
    const g = scope === "sheet" ? { r0: tab.frozenRows, r1: tab.rowCount - 1, c0: 0, c1: tab.colCount - 1 } : clampBox(range);
    if (g.r1 <= g.r0 && scope === "range") return say("Select more than one row to sort.");
    const snap = await eng.snapshot(sid, g);
    apply(`Sort ${asc ? "A to Z" : "Z to A"}`, [batch({ sortRange: { range: gridRange(sid, g), sortSpecs: [{ dimensionIndex: column, sortOrder: asc ? "ASCENDING" : "DESCENDING" }] } })], snap ? [batch(snap)] : null);
    if (!snap) say("Sorted. This sheet is too large to undo that here.");
  }
  function freeze(dim: "rows" | "cols", n: number) {
    if (!tab) return;
    const key = dim === "rows" ? "frozenRowCount" : "frozenColumnCount";
    const old = dim === "rows" ? tab.frozenRows : tab.frozenCols;
    const req = (v: number) => batch({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { [key]: v } }, fields: `gridProperties.${key}` } });
    eng.setTab(sid, dim === "rows" ? { frozenRows: n } : { frozenCols: n });
    apply("Freeze", [req(n)], [req(old)]);
  }
  function gridlines(show: boolean) {
    if (!tab) return;
    const req = (hide: boolean) => batch({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { hideGridlines: hide } }, fields: "gridProperties.hideGridlines" } });
    eng.setTab(sid, { hideGridlines: !show });
    apply("Gridlines", [req(!show)], [req(show)]);
  }
  function resize(dim: "ROWS" | "COLUMNS", index: number, px: number) {
    if (!tab || !sizes) return;
    // Resizing one of several selected whole rows or columns resizes them all, as in Google.
    const whole = dim === "COLUMNS" ? range.r0 === 0 && range.r1 >= tab.rowCount - 1 && index >= range.c0 && index <= range.c1 : range.c0 === 0 && range.c1 >= tab.colCount - 1 && index >= range.r0 && index <= range.r1;
    const [a, b] = whole ? (dim === "COLUMNS" ? [range.c0, range.c1] : [range.r0, range.r1]) : [index, index];
    const old: Record<string, unknown>[] = [];
    for (let i = a; i <= b; i++) {
      old.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: dim, startIndex: i, endIndex: i + 1 }, properties: { pixelSize: dim === "COLUMNS" ? sizes.cols[i] : sizes.rows[i] }, fields: "pixelSize" } });
      if (dim === "COLUMNS") eng.setColPx(sid, i, px);
      else eng.setRowPx(sid, i, px);
    }
    apply("Resize", [batch({ updateDimensionProperties: { range: { sheetId: sid, dimension: dim, startIndex: a, endIndex: b + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } })], [batch(...old)], "cells");
  }
  function autoFit(dim: "ROWS" | "COLUMNS", index: number) {
    if (!tab || !sizes) return;
    const old = dim === "COLUMNS" ? sizes.cols[index] : sizes.rows[index];
    apply("Fit to data", [batch({ autoResizeDimensions: { dimensions: { sheetId: sid, dimension: dim, startIndex: index, endIndex: index + 1 } } })], [batch({ updateDimensionProperties: { range: { sheetId: sid, dimension: dim, startIndex: index, endIndex: index + 1 }, properties: { pixelSize: old }, fields: "pixelSize" } })]);
  }
  async function fill(dest: Range) {
    if (!tab) return;
    const s = clampBox(range);
    const [dimension, len] = dest.r1 > s.r1 ? ["ROWS", dest.r1 - s.r1] : dest.r0 < s.r0 ? ["ROWS", dest.r0 - s.r0] : dest.c1 > s.c1 ? ["COLUMNS", dest.c1 - s.c1] : ["COLUMNS", dest.c0 - s.c0];
    const ext = dimension === "ROWS" ? (len > 0 ? { ...s, r0: s.r1 + 1, r1: dest.r1 } : { ...s, r0: dest.r0, r1: s.r0 - 1 }) : len > 0 ? { ...s, c0: s.c1 + 1, c1: dest.c1 } : { ...s, c0: dest.c0, c1: s.c0 - 1 };
    const snap = await eng.snapshot(sid, ext);
    apply("Fill", [batch({ autoFill: { useAlternateSeries: false, sourceAndDestination: { source: gridRange(sid, s), dimension, fillLength: len } } })], snap ? [batch(snap)] : null, "cells");
    select({ a: { r: dest.r0, c: dest.c0 }, f: { r: dest.r1, c: dest.c1 } }, false);
  }
  async function toggleFilter() {
    if (!tab) return;
    if (tab.filter) {
      const old = tab.filter;
      eng.setTab(sid, { filter: null });
      return apply("Remove filter", [batch({ clearBasicFilter: { sheetId: sid } })], [batch({ setBasicFilter: { filter: old } })]);
    }
    const g = range.r0 === range.r1 && range.c0 === range.c1 ? { sheetId: sid } : gridRange(sid, clampBox(range));
    apply("Create a filter", [batch({ setBasicFilter: { filter: { range: g } } })], [batch({ clearBasicFilter: { sheetId: sid } })]);
  }
  function filterValues(c: number, hidden: string[]) {
    if (!tab?.filter) return;
    const old = tab.filter;
    const specs = ((old.filterSpecs ?? []) as { columnIndex?: number }[]).filter((s) => s.columnIndex !== c);
    if (hidden.length) specs.push({ columnIndex: c, filterCriteria: { hiddenValues: hidden } } as { columnIndex: number });
    apply("Filter", [batch({ setBasicFilter: { filter: { range: old.range, filterSpecs: specs } } })], [batch({ setBasicFilter: { filter: old } })]);
  }
  async function filterSort(c: number, asc: boolean) {
    if (!tab?.filter) return;
    const fr = tab.filter.range;
    const g = { r0: (fr.startRowIndex ?? 0) + 1, r1: (fr.endRowIndex ?? tab.rowCount) - 1, c0: fr.startColumnIndex ?? 0, c1: (fr.endColumnIndex ?? tab.colCount) - 1 };
    const snap = await eng.snapshot(sid, g);
    apply(`Sort ${asc ? "A to Z" : "Z to A"}`, [batch({ sortRange: { range: gridRange(sid, g), sortSpecs: [{ dimensionIndex: c, sortOrder: asc ? "ASCENDING" : "DESCENDING" }] } })], snap ? [batch(snap)] : null);
  }
  function insertFunction(name: string) {
    if (readOnly) return;
    if (range.r0 !== range.r1 || range.c0 !== range.c1) {
      // With a range selected, the total goes under it, ready to confirm with Enter.
      const r = Math.min(box.r1 + 1, (tab?.rowCount ?? 1) - 1);
      select({ a: { r, c: box.c0 }, f: { r, c: box.c0 } });
      setEditing({ r, c: box.c0, text: `=${name}(${rangeA1(box)})`, mode: "edit" });
      return;
    }
    setEditing({ r: sel.a.r, c: sel.a.c, text: `=${name}(`, mode: "edit" });
  }

  // ── Clipboard (tab-separated values, like Google and Excel) ──
  function selectionTSV(g: Range) {
    const rows: string[][] = [];
    if ((g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) > 200_000) return null;
    for (let r = g.r0; r <= g.r1; r++) {
      const row: string[] = [];
      for (let c = g.c0; c <= g.c1; c++) row.push(eng.cell(sid, r, c)?.v ?? "");
      rows.push(row);
    }
    return toTSV(rows);
  }
  function copy(cut: boolean, data?: DataTransfer | null) {
    const g = clampBox(range);
    const tsv = selectionTSV(g);
    if (tsv === null) return say("That's too much to copy at once.");
    if (data) {
      data.setData("text/plain", tsv);
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      data.setData("text/html", `<table>${parseTSV(tsv).map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</table>`);
    } else void navigator.clipboard?.writeText(tsv).catch(() => {});
    setClip({ sheetId: sid, range: g, cut: cut && !readOnly, tsv });
  }
  async function paste(text: string) {
    if (readOnly || !tab) return;
    const same = clip && text.replace(/\r\n/g, "\n").replace(/\n$/, "") === clip.tsv;
    if (same && clip) {
      // Inside the spreadsheet: Google copies formats and adjusts formulas itself.
      const h = clip.range.r1 - clip.range.r0;
      const w = clip.range.c1 - clip.range.c0;
      const dest = { r0: sel.a.r, c0: sel.a.c, r1: sel.a.r + h, c1: sel.a.c + w };
      if (dest.r1 >= tab.rowCount || dest.c1 >= tab.colCount) return say("There isn't room to paste there.");
      const snapD = await eng.snapshot(sid, dest);
      const snapS = clip.cut ? await eng.snapshot(clip.sheetId, clip.range) : null;
      const req = clip.cut
        ? { cutPaste: { source: gridRange(clip.sheetId, clip.range), destination: { sheetId: sid, rowIndex: dest.r0, columnIndex: dest.c0 }, pasteType: "PASTE_NORMAL" } }
        : { copyPaste: { source: gridRange(clip.sheetId, clip.range), destination: gridRange(sid, dest), pasteType: "PASTE_NORMAL", pasteOrientation: "NORMAL" } };
      apply(clip.cut ? "Cut and paste" : "Paste", [batch(req)], snapD && (!clip.cut || snapS) ? [batch(...(snapS ? [snapS] : []), snapD)] : null);
      if (clip.cut) setClip(null);
      select({ a: { r: dest.r0, c: dest.c0 }, f: { r: dest.r1, c: dest.c1 } }, false);
      return;
    }
    const rows = parseTSV(text);
    const h = rows.length;
    const w = Math.max(...rows.map((r) => r.length));
    if (h * w > 200_000) return say("That's too much to paste at once.");
    const dest = { r0: sel.a.r, c0: sel.a.c, r1: sel.a.r + h - 1, c1: sel.a.c + w - 1 };
    const grow: Record<string, unknown>[] = [];
    if (dest.r1 >= tab.rowCount) grow.push({ appendDimension: { sheetId: sid, dimension: "ROWS", length: dest.r1 - tab.rowCount + 1 } });
    if (dest.c1 >= tab.colCount) grow.push({ appendDimension: { sheetId: sid, dimension: "COLUMNS", length: dest.c1 - tab.colCount + 1 } });
    const snap = await eng.snapshot(sid, clampBox(dest), "userEnteredValue");
    eng.editRange(sid, clampBox(dest), (cell, r, c) => {
      const v = rows[r - dest.r0]?.[c - dest.c0] ?? "";
      return { ...cell, v: v.startsWith("=") ? "Loading…" : v, uv: v ? { stringValue: v } : undefined, num: NUM.test(v.trim()) ? Number(v) : undefined };
    });
    const values = rows.map((r) => Array.from({ length: w }, (_, i) => r[i] ?? ""));
    apply("Paste", [...(grow.length ? [batch(...grow)] : []), { t: "values", data: [{ range: cellRef(dest.r0, dest.c0), values }] }], snap && !grow.length ? [batch(snap)] : null, grow.length ? "all" : "cells");
    select({ a: { r: dest.r0, c: dest.c0 }, f: { r: dest.r1, c: dest.c1 } }, false);
  }
  useEffect(() => {
    const inGrid = () => (document.activeElement as HTMLElement | null)?.classList.contains("sg-scroll");
    const onCopy = (e: ClipboardEvent) => {
      if (!inGrid()) return;
      e.preventDefault();
      copyRef.current(e.type === "cut", e.clipboardData);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!inGrid()) return;
      e.preventDefault();
      void pasteRef.current(e.clipboardData?.getData("text/plain") ?? "");
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, []);
  const copyRef = useRef(copy);
  const pasteRef = useRef(paste);
  useEffect(() => {
    copyRef.current = copy;
    pasteRef.current = paste;
  });
  async function pasteFromMenu() {
    try {
      const text = await navigator.clipboard.readText();
      await paste(text);
    } catch {
      say("Use Ctrl+V to paste (the browser blocked reading the clipboard).");
    }
  }

  function undo() {
    const e = eng.undo();
    if (e && !e.undo) say(`"${e.label}" can't be undone here.`);
  }
  const redo = () => eng.redo();

  // ── Keys on the grid ──
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const l = k.toLowerCase();
      if (l === "z" && !e.shiftKey) return e.preventDefault(), undo();
      if (l === "y" || (l === "z" && e.shiftKey)) return e.preventDefault(), redo();
      if (l === "b") return e.preventDefault(), fmt("textFormat.bold", !getUF(cur?.uf, "textFormat.bold"), "Bold");
      if (l === "i") return e.preventDefault(), fmt("textFormat.italic", !getUF(cur?.uf, "textFormat.italic"), "Italic");
      if (l === "u") return e.preventDefault(), fmt("textFormat.underline", !getUF(cur?.uf, "textFormat.underline"), "Underline");
      if (l === "k") return e.preventDefault(), setDialog({ kind: "link" });
      if (k === "\\") return e.preventDefault(), void clearFormatting();
      if (l === "a") return e.preventDefault(), tab && select({ a: { r: 0, c: 0 }, f: { r: tab.rowCount - 1, c: tab.colCount - 1 } }, false);
      if (l === "f" || l === "h") return e.preventDefault(), setDialog({ kind: "find" });
      if (k === "Home") return e.preventDefault(), select({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } });
      if (k.startsWith("Arrow")) {
        e.preventDefault();
        return jump(k === "ArrowDown" ? 1 : k === "ArrowUp" ? -1 : 0, k === "ArrowRight" ? 1 : k === "ArrowLeft" ? -1 : 0, e.shiftKey);
      }
      return;
    }
    if (e.altKey && e.shiftKey && k === "%") return e.preventDefault(), fmt("textFormat.strikethrough", !getUF(cur?.uf, "textFormat.strikethrough"), "Strikethrough");
    switch (k) {
      case "ArrowDown":
      case "ArrowUp":
      case "ArrowLeft":
      case "ArrowRight":
        e.preventDefault();
        return moveBy(k === "ArrowDown" ? 1 : k === "ArrowUp" ? -1 : 0, k === "ArrowRight" ? 1 : k === "ArrowLeft" ? -1 : 0, e.shiftKey);
      case "Tab":
        e.preventDefault();
        return moveBy(0, e.shiftKey ? -1 : 1, false);
      case "Enter":
        e.preventDefault();
        if (e.shiftKey) return moveBy(-1, 0, false);
        return startEdit(sel.a.r, sel.a.c, null, "edit");
      case "F2":
        e.preventDefault();
        return startEdit(sel.a.r, sel.a.c, null, "edit");
      case "Delete":
      case "Backspace":
        e.preventDefault();
        return void clearValues();
      case "Escape":
        return setClip(null);
      case "PageDown":
      case "PageUp":
        e.preventDefault();
        return moveBy(k === "PageDown" ? 25 : -25, 0, e.shiftKey);
      case "Home":
        e.preventDefault();
        return select({ a: { r: sel.a.r, c: 0 }, f: { r: sel.a.r, c: 0 } });
    }
    if (k.length === 1 && !e.altKey) {
      e.preventDefault();
      startEdit(sel.a.r, sel.a.c, k, "enter");
    }
  }

  // ── File ──
  async function post(body: Record<string, unknown>) {
    const r = await fetch(`/api/google/sheets/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Google didn't accept that.");
    return d;
  }
  async function rename(name: string) {
    setTitleDraft(null);
    const n = name.trim();
    if (!meta || !n || n === meta.file.name) return;
    const old = meta.file.name;
    eng.setFile({ name: n });
    try {
      await post({ action: "rename", name: n });
      say("Renamed. Saved to Drive.");
    } catch (e) {
      eng.setFile({ name: old });
      say((e as Error).message);
    }
  }
  async function star() {
    if (!meta) return;
    const to = !meta.file.starred;
    eng.setFile({ starred: to });
    try {
      await post({ action: "star", starred: to });
    } catch (e) {
      eng.setFile({ starred: !to });
      say((e as Error).message);
    }
  }
  async function googlePost(body: Record<string, unknown>) {
    const r = await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Google didn't accept that.");
    return d;
  }
  async function newSheet() {
    try {
      const { file } = await googlePost({ action: "create", kind: "sheets", name: "Untitled spreadsheet" });
      router.push(`/sheets/${file.id}`);
    } catch (e) {
      say((e as Error).message);
    }
  }
  async function makeCopy() {
    if (!meta) return;
    try {
      const { file } = await googlePost({ action: "copy", id, name: `Copy of ${meta.file.name}` });
      say(`Made "${file.name}".`);
      router.push(`/sheets/${file.id}`);
    } catch (e) {
      say((e as Error).message);
    }
  }
  async function trash() {
    try {
      await googlePost({ action: "trash", id });
      router.push("/sheets?trashed=1");
    } catch (e) {
      say((e as Error).message);
    }
  }

  // ── Tabs ──
  const newSheetId = () => Math.floor(Math.random() * 2_000_000_000) + 1;
  function switchTab(sheetId: number) {
    if (editing) commit(null);
    setTabId(sheetId);
    setSel({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } });
    setFilterMenu(null);
  }
  function addTab() {
    if (!meta) return;
    let n = meta.tabs.length + 1;
    while (meta.tabs.some((t) => t.title === `Sheet${n}`)) n++;
    const sheetId = newSheetId();
    apply("Add sheet", [batch({ addSheet: { properties: { sheetId, title: `Sheet${n}`, index: meta.tabs.length } } })], [batch({ deleteSheet: { sheetId } })]);
    eng.setTabs((tabs) => [...tabs, { sheetId, title: `Sheet${n}`, index: meta.tabs.length, hidden: false, color: null, rowCount: 1000, colCount: 26, frozenRows: 0, frozenCols: 0, hideGridlines: false, merges: [], filter: null }]);
    switchTab(sheetId);
  }
  function renameTab(t: Tab, name: string) {
    setRenamingTab(null);
    const n = name.trim().slice(0, 100);
    if (!n || n === t.title) return;
    if (meta?.tabs.some((x) => x.title.toLowerCase() === n.toLowerCase() && x.sheetId !== t.sheetId)) return say(`A sheet named "${n}" already exists.`);
    const req = (title: string) => batch({ updateSheetProperties: { properties: { sheetId: t.sheetId, title }, fields: "title" } });
    eng.setTab(t.sheetId, { title: n });
    apply("Rename sheet", [req(n)], [req(t.title)]);
  }
  function duplicateTab(t: Tab) {
    const sheetId = newSheetId();
    let name = `Copy of ${t.title}`;
    for (let i = 2; meta?.tabs.some((x) => x.title === name); i++) name = `Copy ${i} of ${t.title}`;
    apply("Duplicate sheet", [batch({ duplicateSheet: { sourceSheetId: t.sheetId, insertSheetIndex: t.index + 1, newSheetId: sheetId, newSheetName: name } })], [batch({ deleteSheet: { sheetId } })]);
    setTimeout(() => setTabId(sheetId), 0);
  }
  function deleteTab(t: Tab) {
    setDialog(null);
    if (!meta || meta.tabs.filter((x) => !x.hidden).length <= 1) return say("A spreadsheet needs at least one sheet.");
    const next = meta.tabs.filter((x) => x.sheetId !== t.sheetId && !x.hidden)[0];
    apply("Delete sheet", [batch({ deleteSheet: { sheetId: t.sheetId } })], null);
    eng.setTabs((tabs) => tabs.filter((x) => x.sheetId !== t.sheetId));
    switchTab(next.sheetId);
    say(`Deleted "${t.title}". Deleting a sheet can't be undone here; Google keeps it in File → Version history.`);
  }
  function colourTab(t: Tab, hex: string | null) {
    const req = (c: Tab["color"]) => batch({ updateSheetProperties: { properties: { sheetId: t.sheetId, ...(c ? { tabColorStyle: { rgbColor: c } } : {}) }, fields: c ? "tabColorStyle" : "tabColor,tabColorStyle" } });
    const to = hex ? fromHex(hex) : null;
    eng.setTab(t.sheetId, { color: to });
    apply("Sheet colour", [req(to)], [req(t.color)]);
  }
  function moveTab(t: Tab, dir: -1 | 1) {
    if (!meta) return;
    const i = t.index;
    if ((dir < 0 && i === 0) || (dir > 0 && i >= meta.tabs.length - 1)) return;
    // Google counts the new index before the move: moving right by one is index + 2.
    const req = (sheetId: number, index: number) => batch({ updateSheetProperties: { properties: { sheetId, index }, fields: "index" } });
    apply("Move sheet", [req(t.sheetId, dir < 0 ? i - 1 : i + 2)], [req(t.sheetId, dir < 0 ? i + 1 : i)]);
    eng.setTabs((all) => {
      const tabs = [...all].sort((a, b) => a.index - b.index);
      tabs.splice(i, 1);
      tabs.splice(i + dir, 0, t);
      return tabs.map((x, n) => ({ ...x, index: n }));
    });
  }

  // ── Explore chip: sum, average and counts of the selection ──
  const summary = useMemo(() => {
    if (!tab || (box.r0 === box.r1 && box.c0 === box.c1) || (box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1) > 100_000) return null;
    const nums: number[] = [];
    let filled = 0;
    for (let r = box.r0; r <= box.r1; r++)
      for (let c = box.c0; c <= box.c1; c++) {
        const cell = eng.cell(sid, r, c);
        if (cell?.v) filled++;
        if (cell?.num !== undefined && !cell.uv?.stringValue) nums.push(cell.num);
      }
    return { ...stats(nums, filled), filled };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sid, box.r0, box.r1, box.c0, box.c1, ver]);

  // ── Menus ──
  const ro = readOnly;
  const one = range.r0 === range.r1 && range.c0 === range.c1;
  const nR = box.r1 - box.r0 + 1;
  const nC = box.c1 - box.c0 + 1;
  const rowsLabel = nR === 1 ? `row ${box.r0 + 1}` : `rows ${box.r0 + 1}–${box.r1 + 1}`;
  const colsLabel = nC === 1 ? `column ${colName(box.c0)}` : `columns ${colName(box.c0)}–${colName(box.c1)}`;
  const exportUrl = (format: string) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=${format}${format === "csv" || format === "tsv" ? `&gid=${sid}` : ""}`;
  const openUrl = (u: string) => window.open(u, "_blank", "noopener,noreferrer");
  const canLive = perms.can("sheets.google.live");
  const menus: Record<string, Item[]> = {
    File: [
      { label: "New spreadsheet", icon: <Plus size={15} />, onClick: newSheet, disabled: !perms.can("sheets.google.edit") },
      { label: "Open", hint: "Sheets home", onClick: () => router.push("/sheets") },
      { label: "Make a copy", icon: <Copy size={15} />, onClick: makeCopy, disabled: !perms.can("sheets.google.edit") },
      "-",
      { label: "Rename", icon: <Pencil size={15} />, onClick: () => titleInput.current?.focus(), disabled: ro },
      { label: meta?.file.starred ? "Remove star" : "Star", icon: <Star size={15} />, onClick: star },
      {
        label: "Download",
        sub: [
          { label: "Microsoft Excel (.xlsx)", onClick: () => openUrl(exportUrl("xlsx")) },
          { label: "OpenDocument (.ods)", onClick: () => openUrl(exportUrl("ods")) },
          { label: "PDF (.pdf)", onClick: () => openUrl(exportUrl("pdf")) },
          { label: "Comma-separated values (.csv)", hint: "this sheet", onClick: () => openUrl(exportUrl("csv")) },
          { label: "Tab-separated values (.tsv)", hint: "this sheet", onClick: () => openUrl(exportUrl("tsv")) },
        ],
      },
      "-",
      { label: "Share", icon: <Lock size={15} />, onClick: () => meta && openUrl(meta.file.webViewLink) },
      { label: "Open in Google Sheets", icon: <ExternalLink size={15} />, onClick: () => meta && openUrl(meta.file.webViewLink) },
      ...(canLive ? [{ label: "Use as live data", icon: <Database size={15} />, onClick: () => setDialog({ kind: "live" }) }] : []),
      "-",
      { label: "Move to trash", icon: <Trash size={15} />, danger: true, disabled: !perms.can("sheets.google.edit") || ro, onClick: () => setDialog({ kind: "trash" }) },
    ],
    Edit: [
      { label: "Undo", hint: "Ctrl+Z", onClick: undo, disabled: ro || !eng.canUndo },
      { label: "Redo", hint: "Ctrl+Y", onClick: redo, disabled: ro || !eng.canRedo },
      "-",
      { label: "Cut", hint: "Ctrl+X", onClick: () => copy(true), disabled: ro },
      { label: "Copy", hint: "Ctrl+C", onClick: () => copy(false) },
      { label: "Paste", hint: "Ctrl+V", onClick: pasteFromMenu, disabled: ro },
      "-",
      { label: "Find and replace", hint: "Ctrl+H", onClick: () => setDialog({ kind: "find" }) },
      "-",
      { label: "Delete values", hint: "Delete", onClick: () => void clearValues(), disabled: ro },
      { label: `Delete ${rowsLabel}`, onClick: () => void deleteDim("ROWS"), disabled: ro },
      { label: `Delete ${colsLabel}`, onClick: () => void deleteDim("COLUMNS"), disabled: ro },
    ],
    View: [
      {
        label: "Freeze",
        disabled: ro,
        sub: [
          { label: "No rows", checked: tab?.frozenRows === 0, onClick: () => freeze("rows", 0) },
          { label: "1 row", checked: tab?.frozenRows === 1, onClick: () => freeze("rows", 1) },
          { label: "2 rows", checked: tab?.frozenRows === 2, onClick: () => freeze("rows", 2) },
          { label: `Up to row ${sel.a.r + 1}`, checked: tab?.frozenRows === sel.a.r + 1 && sel.a.r > 1, onClick: () => freeze("rows", sel.a.r + 1) },
          "-",
          { label: "No columns", checked: tab?.frozenCols === 0, onClick: () => freeze("cols", 0) },
          { label: "1 column", checked: tab?.frozenCols === 1, onClick: () => freeze("cols", 1) },
          { label: "2 columns", checked: tab?.frozenCols === 2, onClick: () => freeze("cols", 2) },
          { label: `Up to column ${colName(sel.a.c)}`, checked: tab?.frozenCols === sel.a.c + 1 && sel.a.c > 1, onClick: () => freeze("cols", sel.a.c + 1) },
        ],
      },
      {
        label: "Show",
        sub: [
          { label: "Gridlines", checked: !tab?.hideGridlines, onClick: () => gridlines(!!tab?.hideGridlines), disabled: ro },
          { label: "Formula bar", checked: showFx, onClick: () => setShowFx((s) => !s) },
        ],
      },
      { label: "Zoom", sub: ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: z === zoom, onClick: () => setZoom(z) })) },
      "-",
      { label: "Refresh from Google", onClick: () => void eng.refresh() },
    ],
    Insert: [
      {
        label: "Rows",
        disabled: ro,
        sub: [
          { label: `Insert ${nR} row${nR > 1 ? "s" : ""} above`, onClick: () => insertDim("ROWS", true) },
          { label: `Insert ${nR} row${nR > 1 ? "s" : ""} below`, onClick: () => insertDim("ROWS", false) },
        ],
      },
      {
        label: "Columns",
        disabled: ro,
        sub: [
          { label: `Insert ${nC} column${nC > 1 ? "s" : ""} left`, onClick: () => insertDim("COLUMNS", true) },
          { label: `Insert ${nC} column${nC > 1 ? "s" : ""} right`, onClick: () => insertDim("COLUMNS", false) },
        ],
      },
      { label: "Sheet", hint: "Shift+F11", onClick: addTab, disabled: ro },
      "-",
      { label: "Function", disabled: ro, sub: FUNCTIONS.map((f) => ({ label: f, onClick: () => insertFunction(f) })) },
      { label: "Link", hint: "Ctrl+K", onClick: () => setDialog({ kind: "link" }), disabled: ro },
      { label: "Note", onClick: () => setDialog({ kind: "note" }), disabled: ro },
    ],
    Format: [
      { label: "Number", disabled: ro, sub: NUMBER_FORMATS.map((f) => ({ label: f.label, hint: f.sample, onClick: () => numberFormat(f.nf, f.label) })) },
      {
        label: "Text",
        disabled: ro,
        sub: [
          { label: "Bold", hint: "Ctrl+B", checked: !!getUF(cur?.uf, "textFormat.bold"), onClick: () => fmt("textFormat.bold", !getUF(cur?.uf, "textFormat.bold"), "Bold") },
          { label: "Italic", hint: "Ctrl+I", checked: !!getUF(cur?.uf, "textFormat.italic"), onClick: () => fmt("textFormat.italic", !getUF(cur?.uf, "textFormat.italic"), "Italic") },
          { label: "Underline", hint: "Ctrl+U", checked: !!getUF(cur?.uf, "textFormat.underline"), onClick: () => fmt("textFormat.underline", !getUF(cur?.uf, "textFormat.underline"), "Underline") },
          { label: "Strikethrough", hint: "Alt+Shift+5", checked: !!getUF(cur?.uf, "textFormat.strikethrough"), onClick: () => fmt("textFormat.strikethrough", !getUF(cur?.uf, "textFormat.strikethrough"), "Strikethrough") },
        ],
      },
      {
        label: "Alignment",
        disabled: ro,
        sub: [
          { label: "Left", onClick: () => fmt("horizontalAlignment", "LEFT", "Align") },
          { label: "Center", onClick: () => fmt("horizontalAlignment", "CENTER", "Align") },
          { label: "Right", onClick: () => fmt("horizontalAlignment", "RIGHT", "Align") },
          "-",
          { label: "Top", onClick: () => fmt("verticalAlignment", "TOP", "Vertical align") },
          { label: "Middle", onClick: () => fmt("verticalAlignment", "MIDDLE", "Vertical align") },
          { label: "Bottom", onClick: () => fmt("verticalAlignment", "BOTTOM", "Vertical align") },
        ],
      },
      {
        label: "Wrapping",
        disabled: ro,
        sub: [
          { label: "Overflow", onClick: () => fmt("wrapStrategy", "OVERFLOW_CELL", "Wrapping") },
          { label: "Wrap", onClick: () => fmt("wrapStrategy", "WRAP", "Wrapping") },
          { label: "Clip", onClick: () => fmt("wrapStrategy", "CLIP", "Wrapping") },
        ],
      },
      { label: "Font size", disabled: ro, sub: SIZES.map((s) => ({ label: String(s), onClick: () => fmt("textFormat.fontSize", s, "Font size") })) },
      {
        label: "Merge cells",
        disabled: ro,
        sub: [
          { label: "Merge all", onClick: () => void merge("MERGE_ALL") },
          { label: "Merge vertically", onClick: () => void merge("MERGE_COLUMNS") },
          { label: "Merge horizontally", onClick: () => void merge("MERGE_ROWS") },
          { label: "Unmerge", onClick: () => void merge("UNMERGE") },
        ],
      },
      "-",
      { label: "Clear formatting", hint: "Ctrl+\\", onClick: () => void clearFormatting(), disabled: ro },
    ],
    Data: [
      {
        label: "Sort sheet",
        disabled: ro,
        sub: [
          { label: `Sort sheet by column ${colName(sel.a.c)} (A to Z)`, onClick: () => void sort("sheet", true) },
          { label: `Sort sheet by column ${colName(sel.a.c)} (Z to A)`, onClick: () => void sort("sheet", false) },
        ],
      },
      {
        label: "Sort range",
        disabled: ro || one,
        sub: [
          { label: `Sort range by column ${colName(sel.a.c)} (A to Z)`, onClick: () => void sort("range", true) },
          { label: `Sort range by column ${colName(sel.a.c)} (Z to A)`, onClick: () => void sort("range", false) },
        ],
      },
      "-",
      { label: tab?.filter ? "Remove filter" : "Create a filter", onClick: () => void toggleFilter(), disabled: ro },
      ...(canLive ? (["-", { label: "Use as live data", icon: <Database size={15} />, onClick: () => setDialog({ kind: "live" }) }] as Item[]) : []),
    ],
  };
  const ctxItems: Item[] = !ctx
    ? []
    : [
        { label: "Cut", hint: "Ctrl+X", onClick: () => copy(true), disabled: ro },
        { label: "Copy", hint: "Ctrl+C", onClick: () => copy(false) },
        { label: "Paste", hint: "Ctrl+V", onClick: pasteFromMenu, disabled: ro },
        "-",
        ...(ctx.kind !== "col"
          ? ([
              { label: `Insert ${nR} row${nR > 1 ? "s" : ""} above`, onClick: () => insertDim("ROWS", true), disabled: ro },
              { label: `Insert ${nR} row${nR > 1 ? "s" : ""} below`, onClick: () => insertDim("ROWS", false), disabled: ro },
            ] as Item[])
          : []),
        ...(ctx.kind !== "row"
          ? ([
              { label: `Insert ${nC} column${nC > 1 ? "s" : ""} left`, onClick: () => insertDim("COLUMNS", true), disabled: ro },
              { label: `Insert ${nC} column${nC > 1 ? "s" : ""} right`, onClick: () => insertDim("COLUMNS", false), disabled: ro },
            ] as Item[])
          : []),
        ...(ctx.kind !== "col" ? ([{ label: `Delete ${rowsLabel}`, onClick: () => void deleteDim("ROWS"), disabled: ro }] as Item[]) : []),
        ...(ctx.kind !== "row" ? ([{ label: `Delete ${colsLabel}`, onClick: () => void deleteDim("COLUMNS"), disabled: ro }] as Item[]) : []),
        { label: ctx.kind === "row" ? "Clear row" : ctx.kind === "col" ? "Clear column" : "Clear", onClick: () => void clearValues(), disabled: ro },
        "-",
        { label: "Sort sheet A to Z", hint: `by ${colName(sel.a.c)}`, onClick: () => void sort("sheet", true), disabled: ro },
        { label: "Sort sheet Z to A", hint: `by ${colName(sel.a.c)}`, onClick: () => void sort("sheet", false), disabled: ro },
        ...(!one && ctx.kind === "cell"
          ? ([
              { label: "Sort range A to Z", onClick: () => void sort("range", true), disabled: ro },
              { label: "Sort range Z to A", onClick: () => void sort("range", false), disabled: ro },
            ] as Item[])
          : []),
        "-",
        { label: "Insert link", onClick: () => setDialog({ kind: "link" }), disabled: ro },
        { label: cur?.note ? "Edit note" : "Insert note", onClick: () => setDialog({ kind: "note" }), disabled: ro },
        { label: tab?.filter ? "Remove filter" : "Create a filter", onClick: () => void toggleFilter(), disabled: ro },
      ];

  const tools: Tools = {
    cur,
    readOnly: ro,
    zoom,
    setZoom,
    canUndo: eng.canUndo,
    canRedo: eng.canRedo,
    undo,
    redo,
    fmt,
    colour,
    numberFormat,
    currency: () => numberFormat({ type: "CURRENCY", pattern: currencyPattern(meta?.locale ?? "en_US") }, "Currency"),
    decimals: (d) => fmt("numberFormat", changeDecimals(cur, d), d > 0 ? "More decimals" : "Fewer decimals"),
    borders: (k, c, s) => void borders(k, c, s),
    merge: (t) => void merge(t),
    merged: !!mergeAt(sel.a.r, sel.a.c),
    link: () => setDialog({ kind: "link" }),
    note: () => setDialog({ kind: "note" }),
    filterOn: !!tab?.filter,
    toggleFilter: () => void toggleFilter(),
    fn: insertFunction,
  };

  // ── Not connected, missing file, loading ──
  if (!meta) {
    const err = eng.loadError;
    return (
      <div className="sx-root ox-sheets" style={{ height: "60vh" }}>
        <div style={{ margin: "auto", maxWidth: 460, textAlign: "center", padding: 24 }}>
          {!err ? (
            <p style={{ color: "var(--ix-muted)", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <LoaderCircle size={16} className="animate-spin" /> Opening the spreadsheet…
            </p>
          ) : (
            <>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>{err.connect ? "Connect Google Drive" : "Couldn't open this spreadsheet"}</h1>
              <p style={{ color: "var(--ix-muted)", marginTop: 6 }}>{err.connect ? "Connect your Google account to open and edit your Google Sheets here." : err.text}</p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
                {(err.connect || err.reconnect) && (
                  <a className="sx-btn primary" href={`/api/google/connect?back=/sheets/${encodeURIComponent(id)}`}>
                    {err.connect ? "Connect Google Drive" : "Reconnect Google"}
                  </a>
                )}
                <NextLink className="sx-btn" href="/sheets">
                  Back to Sheets
                </NextLink>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const saveState = eng.save;
  const visibleTabs = [...meta.tabs].sort((a, b) => a.index - b.index);
  return (
    <div ref={root} className="sx-root ox-sheets" style={{ height: height ?? "calc(100dvh - 64px)" }}>
      {/* Title bar */}
      <div className="sx-top">
        <NextLink href="/sheets" className="sx-logo" title="Sheets home" aria-label="Sheets home">
          <Sheet size={20} />
        </NextLink>
        <div className="sx-titlebox">
          <div className="sx-titlerow">
            <input
              ref={titleInput}
              className="sx-title"
              aria-label="Spreadsheet name"
              value={titleDraft ?? meta.file.name}
              readOnly={ro}
              onChange={(e) => setTitleDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => titleDraft !== null && void rename(titleDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setTitleDraft(null);
                  requestAnimationFrame(() => grid.current?.focus());
                }
              }}
            />
            <button type="button" className={`sx-ibtn ${meta.file.starred ? "starred" : ""}`} title={meta.file.starred ? "Remove star" : "Star"} aria-label={meta.file.starred ? "Remove star" : "Star"} aria-pressed={!!meta.file.starred} onClick={star}>
              <Star size={17} fill={meta.file.starred ? "currentColor" : "none"} />
            </button>
            <span className={`sx-status ${saveState.state === "error" ? "error" : ""}`} role="status" aria-live="polite">
              {saveState.state === "saving" ? (
                <>
                  <LoaderCircle size={14} className="animate-spin" /> Saving…
                </>
              ) : saveState.state === "error" ? (
                <>
                  <CloudOff size={14} /> {saveState.error}
                  <button type="button" className="sx-btn" style={{ padding: "1px 10px", marginLeft: 4 }} onClick={() => eng.retry()}>
                    Retry
                  </button>
                  <button type="button" className="sx-btn" style={{ padding: "1px 10px" }} onClick={() => eng.dismissError()}>
                    Dismiss
                  </button>
                </>
              ) : saveState.state === "saved" ? (
                <>
                  <CloudCheck size={14} /> Saved to Drive
                </>
              ) : (
                <span className="sx-hide-phone">{ro ? "View only" : "All changes saved in Drive"}</span>
              )}
            </span>
          </div>
          <nav className="sx-menubar" aria-label="Menu">
            {Object.entries(menus).map(([name, items]) => (
              <Dropdown key={name} title={name} className="" button={name} items={items} />
            ))}
          </nav>
        </div>
        {canLive && (
          <button type="button" className="sx-live sx-hide-phone" onClick={() => setDialog({ kind: "live" })} title="Use this sheet as live data for an app or dashboard">
            <Database size={15} />
            <span>Use as live data</span>
          </button>
        )}
        <a className="sx-ibtn sx-hide-phone" href={meta.file.webViewLink} target="_blank" rel="noopener noreferrer" title="Open in Google Sheets" aria-label="Open in Google Sheets">
          <ExternalLink size={17} />
        </a>
        <a className="sx-share" href={meta.file.webViewLink} target="_blank" rel="noopener noreferrer" title="Share in Google Sheets">
          <Lock size={15} />
          <span className="sx-hide-phone">Share</span>
        </a>
      </div>

      {!meta.connection.canEdit ? (
        <div className="sx-banner">
          <b>View only.</b> Your Google connection was made with read-only access.
          <a href={`/api/google/connect?back=/sheets/${encodeURIComponent(id)}`} style={{ color: "var(--ox-ink)", fontWeight: 600, textDecoration: "underline" }}>
            Reconnect Google to allow editing
          </a>
        </div>
      ) : ro ? (
        <div className="sx-banner">
          <b>View only.</b> {meta.file.capabilities?.canEdit === false ? "The owner shared this file with you for viewing." : "Editing Google Sheets isn't turned on for your role."}
        </div>
      ) : null}

      <Toolbar t={tools} />

      {/* Formula bar */}
      {showFx && (
        <div className="sx-fbar">
          <input
            className="sx-namebox"
            aria-label="Name box (go to a cell or range)"
            value={nameDraft ?? rangeA1(range, tab ?? undefined)}
            onChange={(e) => setNameDraft(e.target.value)}
            onFocus={(e) => {
              setNameDraft(rangeA1(range, tab ?? undefined));
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={() => setNameDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") return (e.target as HTMLInputElement).blur(), grid.current?.focus();
              if (e.key !== "Enter") return;
              const ref = parseRef(nameDraft ?? "");
              const t = ref?.tab ? meta.tabs.find((x) => x.title.toLowerCase() === ref.tab!.toLowerCase()) : tab;
              if (!ref || !t) return say("Enter a cell or range, like B4 or A1:C9.");
              if (t.sheetId !== sid) setTabId(t.sheetId);
              const g = { r0: Math.min(ref.range.r0, t.rowCount - 1), c0: Math.min(ref.range.c0, t.colCount - 1), r1: Math.min(ref.range.r1, t.rowCount - 1), c1: Math.min(ref.range.c1, t.colCount - 1) };
              setNameDraft(null);
              select({ a: { r: g.r0, c: g.c0 }, f: { r: g.r1, c: g.c1 } });
              grid.current?.focus();
              requestAnimationFrame(() => grid.current?.scrollTo(g.r0, g.c0));
            }}
          />
          <span className="sx-fx" aria-hidden>
            fx
          </span>
          <textarea
            ref={fxInput}
            className="sx-fxinput"
            rows={1}
            aria-label="Formula bar"
            readOnly={ro}
            value={editing ? editing.text : inputOf(cur)}
            onFocus={() => {
              if (ro) return;
              if (!editing) setEditing({ r: mergeAt(sel.a.r, sel.a.c)?.startRowIndex ?? sel.a.r, c: mergeAt(sel.a.r, sel.a.c)?.startColumnIndex ?? sel.a.c, text: inputOf(cur), mode: "bar" });
              else if (editing.mode !== "bar") setEditing({ ...editing, mode: "bar" });
            }}
            onChange={(e) => (editing ? draft(e.target.value) : undefined)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.altKey && !e.shiftKey) return e.preventDefault(), commit([1, 0]);
              if (e.key === "Tab") return e.preventDefault(), commit([0, e.shiftKey ? -1 : 1]);
              if (e.key === "Escape") return e.preventDefault(), cancel();
            }}
          />
        </div>
      )}

      {tab && sizes && (
        <Grid
          tab={tab}
          zoom={zoom}
          rowOff={rowOff}
          colOff={colOff}
          cell={cellGet}
          ver={eng.save.at ?? 0}
          sel={sel}
          editing={editing}
          clip={clip && clip.sheetId === sid ? clip : null}
          refPick={refPick?.range ?? null}
          readOnly={ro}
          apiRef={grid}
          onSelect={(s) => {
            setSel(s);
            setNameDraft(null);
            setCtx(null);
          }}
          onEdit={(r, c) => startEdit(r, c, null, "edit")}
          onDraft={draft}
          onCommit={commit}
          onCancel={cancel}
          onKeyDown={onKeyDown}
          onResize={resize}
          onAutoFit={autoFit}
          onContext={(h) => {
            if (editing) commit(null);
            if (h.kind === "cell" && !(h.r >= range.r0 && h.r <= range.r1 && h.c >= range.c0 && h.c <= range.c1)) setSel({ a: { r: h.r, c: h.c }, f: { r: h.r, c: h.c } });
            if (h.kind === "row" && !(range.c0 === 0 && range.c1 >= tab.colCount - 1 && h.r >= range.r0 && h.r <= range.r1)) setSel({ a: { r: h.r, c: 0 }, f: { r: h.r, c: tab.colCount - 1 } });
            if (h.kind === "col" && !(range.r0 === 0 && range.r1 >= tab.rowCount - 1 && h.c >= range.c0 && h.c <= range.c1)) setSel({ a: { r: 0, c: h.c }, f: { r: tab.rowCount - 1, c: h.c } });
            setCtx({ x: h.x, y: h.y, kind: h.kind });
          }}
          onFill={(d) => void fill(d)}
          onVisible={onVisible}
          onRefPick={pickRef}
          onFilterMenu={(c, x, y) => setFilterMenu({ c, x, y })}
        />
      )}

      {/* Sheet tabs and the explore chip */}
      <div className="sx-bottom">
        {!ro && (
          <button type="button" className="sx-ibtn" title="Add sheet" aria-label="Add sheet" onClick={addTab}>
            <Plus size={18} />
          </button>
        )}
        <Dropdown
          title="All sheets"
          className="sx-ibtn"
          button={<MenuIcon size={18} />}
          items={visibleTabs.map((t) => ({ label: t.hidden ? `${t.title} (hidden)` : t.title, checked: t.sheetId === sid, onClick: () => switchTab(t.sheetId) }))}
        />
        <div className="sx-tabs" role="tablist" aria-label="Sheets">
          {visibleTabs
            .filter((t) => !t.hidden)
            .map((t) => (
              <SheetTab
                key={t.sheetId}
                t={t}
                on={t.sheetId === sid}
                ro={ro}
                renaming={renamingTab?.sheetId === t.sheetId ? renamingTab.text : null}
                last={t.index >= meta.tabs.length - 1}
                onOpen={() => switchTab(t.sheetId)}
                onRenameStart={() => setRenamingTab({ sheetId: t.sheetId, text: t.title })}
                onRenameText={(text) => setRenamingTab({ sheetId: t.sheetId, text })}
                onRename={(name) => renameTab(t, name)}
                onRenameCancel={() => setRenamingTab(null)}
                onDuplicate={() => duplicateTab(t)}
                onDelete={() => setDialog({ kind: "deleteTab", sheetId: t.sheetId })}
                onColour={(h) => colourTab(t, h)}
                onMove={(d) => moveTab(t, d)}
              />
            ))}
        </div>
        {summary && (
          <Dropdown
            title="Selection summary"
            className="sx-explore"
            align="right"
            button={
              <>
                {stat === "Count (filled)" ? `Count: ${fmtNum(summary["Count (filled)"])}` : `${stat}: ${fmtNum(summary[stat])}`} <ChevronDown size={13} />
              </>
            }
            items={(["Sum", "Average", "Min", "Max", "Count", "Count (filled)"] as const).map((k) => ({ label: `${k}: ${fmtNum(summary[k])}`, checked: k === stat, onClick: () => setStat(k) }))}
          />
        )}
      </div>

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onDone={() => setCtx(null)} />}
      {filterMenu && tab?.filter && (
        <FilterMenu
          key={filterMenu.c}
          at={filterMenu}
          values={(() => {
            const fr = tab.filter!.range;
            const out = new Set<string>();
            for (let r = (fr.startRowIndex ?? 0) + 1; r < Math.min(fr.endRowIndex ?? tab.rowCount, tab.rowCount) && out.size < 500; r++) if (eng.isLoaded(sid, r, r)) out.add(eng.cell(sid, r, filterMenu.c)?.v ?? "");
            return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          })()}
          hidden={(((tab.filter.filterSpecs ?? []) as { columnIndex?: number; filterCriteria?: { hiddenValues?: string[] } }[]).find((s) => s.columnIndex === filterMenu.c)?.filterCriteria?.hiddenValues ?? []) as string[]}
          onSort={(asc) => {
            setFilterMenu(null);
            void filterSort(filterMenu.c, asc);
          }}
          onApply={(hidden) => {
            setFilterMenu(null);
            filterValues(filterMenu.c, hidden);
          }}
          onClose={() => setFilterMenu(null)}
        />
      )}
      {dialog?.kind === "find" && (
        <FindDialog
          onClose={() => setDialog(null)}
          onFind={(text, matchCase) => {
            if (!tab || !text) return;
            const want = matchCase ? text : text.toLowerCase();
            const has = (r: number, c: number) => {
              const v = eng.cell(sid, r, c)?.v ?? "";
              return (matchCase ? v : v.toLowerCase()).includes(want);
            };
            for (let i = 1; i <= tab.rowCount * tab.colCount; i++) {
              const n = (sel.a.r * tab.colCount + sel.a.c + i) % (tab.rowCount * tab.colCount);
              const r = Math.floor(n / tab.colCount);
              const c = n % tab.colCount;
              if (!eng.isLoaded(sid, r, r)) continue;
              if (has(r, c)) return select({ a: { r, c }, f: { r, c } }), true;
              if (i > 2_000_000) break;
            }
            say(`"${text}" wasn't found in the rows loaded so far.`);
            return false;
          }}
          onReplaceAll={async (find, replacement, matchCase, allSheets) => {
            if (ro || !find || !tab) return;
            const snap = allSheets ? null : await eng.snapshot(sid, { r0: 0, c0: 0, r1: tab.rowCount - 1, c1: tab.colCount - 1 }, "userEnteredValue");
            apply("Replace all", [batch({ findReplace: { find, replacement, matchCase, includeFormulas: false, ...(allSheets ? { allSheets: true } : { sheetId: sid }) } })], snap ? [batch(snap)] : null, "cells");
            say(`Replaced "${find}" with "${replacement}".`);
            setDialog(null);
          }}
          readOnly={ro}
        />
      )}
      {dialog?.kind === "link" && (
        <TextDialog
          title="Insert link"
          label="Link"
          placeholder="https://"
          initial={cur?.link ?? (getUF(cur?.uf, "textFormat.link.uri") as string | undefined) ?? ""}
          extra={cur?.link || getUF(cur?.uf, "textFormat.link") ? "Remove link" : undefined}
          onClose={() => setDialog(null)}
          onSave={(url, remove) => {
            setDialog(null);
            const r = sel.a.r;
            const c = sel.a.c;
            const prev = eng.cell(sid, r, c);
            const undoReq = restoreCells(sid, { r0: r, c0: c, r1: r, c1: c }, () => prev);
            (undoReq.updateCells as { fields: string }).fields = "userEnteredValue,userEnteredFormat.textFormat.link";
            const u = remove ? "" : /^[a-z]+:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
            const empty = !prev?.v;
            const value: Record<string, unknown> = { userEnteredFormat: u ? { textFormat: { link: { uri: u } } } : {} };
            if (empty && u) value.userEnteredValue = { stringValue: u };
            eng.edit(sid, r, c, (cell) => ({ ...cell, v: empty && u ? u : cell.v, uv: empty && u ? { stringValue: u } : cell.uv, link: u || undefined, uf: patchUF(cell.uf, "textFormat.link", u ? { uri: u } : undefined) }));
            apply(
              u ? "Insert link" : "Remove link",
              [batch({ updateCells: { range: gridRange(sid, { r0: r, c0: c, r1: r, c1: c }), rows: [{ values: [value] }], fields: empty && u ? "userEnteredValue,userEnteredFormat.textFormat.link" : "userEnteredFormat.textFormat.link" } })],
              [batch(undoReq)],
              "cells",
            );
          }}
        />
      )}
      {dialog?.kind === "note" && (
        <TextDialog
          title={`Note on ${a1(sel.a.r, sel.a.c)}`}
          label="Note"
          multiline
          initial={cur?.note ?? ""}
          extra={cur?.note ? "Delete note" : undefined}
          onClose={() => setDialog(null)}
          onSave={(text, remove) => {
            setDialog(null);
            const r = sel.a.r;
            const c = sel.a.c;
            const old = eng.cell(sid, r, c)?.note;
            const req = (note?: string) => batch({ updateCells: { range: gridRange(sid, { r0: r, c0: c, r1: r, c1: c }), rows: [{ values: [note ? { note } : {}] }], fields: "note" } });
            const n = remove ? "" : text;
            eng.edit(sid, r, c, (cell) => ({ ...cell, note: n || undefined }));
            apply(n ? "Note" : "Delete note", [req(n)], [req(old)], "cells");
          }}
        />
      )}
      {dialog?.kind === "trash" && (
        <ConfirmDialog
          title="Move to trash?"
          text={`"${meta.file.name}" goes to Google Drive's Trash. You can restore it there for 30 days.`}
          action="Move to trash"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void trash();
          }}
        />
      )}
      {dialog?.kind === "deleteTab" &&
        (() => {
          const t = meta.tabs.find((x) => x.sheetId === dialog.sheetId);
          return t ? (
            <ConfirmDialog title={`Delete "${t.title}"?`} text="The sheet and everything on it is deleted from the spreadsheet." action="Delete" onClose={() => setDialog(null)} onConfirm={() => deleteTab(t)} />
          ) : null;
        })()}
      {dialog?.kind === "live" && <LiveData fileId={id} name={meta.file.name} onClose={() => setDialog(null)} onMessage={say} />}

      {toast && (
        <div role="status" style={{ position: "fixed", left: "50%", bottom: 64, transform: "translateX(-50%)", zIndex: 80, background: "#323232", color: "#fff", padding: "10px 16px", borderRadius: 6, fontSize: 13.5, maxWidth: "calc(100vw - 32px)", boxShadow: "0 4px 14px rgba(0,0,0,.3)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function ContextMenu({ x, y, items, onDone }: { x: number; y: number; items: Item[]; onDone: () => void }) {
  const ref = useDismiss(true, onDone);
  return (
    <div ref={ref} style={{ position: "fixed", left: x, top: y, zIndex: 70 }}>
      <MenuList items={items} onDone={onDone} label="Cell menu" />
    </div>
  );
}

/** One sheet tab: click to open, double-click to rename, the arrow for its menu. */
function SheetTab(p: {
  t: Tab;
  on: boolean;
  ro: boolean;
  last: boolean;
  renaming: string | null;
  onOpen: () => void;
  onRenameStart: () => void;
  onRenameText: (t: string) => void;
  onRename: (name: string) => void;
  onRenameCancel: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onColour: (hex: string | null) => void;
  onMove: (d: -1 | 1) => void;
}) {
  const [menu, setMenuState] = useState<"menu" | "colour" | null>(null);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const ref = useDismiss(!!menu, () => setMenuState(null));
  // The tab strip scrolls sideways, so the menu is placed on the page, above the tab.
  const setMenu = (m: "menu" | "colour" | null | ((m: "menu" | "colour" | null) => "menu" | "colour" | null)) => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.min(r.left, window.innerWidth - 250), bottom: window.innerHeight - r.top + 4 });
    setMenuState(m);
  };
  const colour = p.t.color ? toHex(p.t.color) : null;
  return (
    <div ref={ref} style={{ position: "relative", flex: "none" }}>
      <div
        role="tab"
        tabIndex={0}
        aria-selected={p.on}
        className={`sx-tab ${p.on ? "on" : ""}`}
        onClick={p.onOpen}
        onDoubleClick={() => !p.ro && p.onRenameStart()}
        onContextMenu={(e) => {
          e.preventDefault();
          p.onOpen();
          setMenu("menu");
        }}
        onKeyDown={(e) => e.key === "Enter" && p.onOpen()}
      >
        {p.renaming !== null ? (
          <input
            autoFocus
            aria-label="Sheet name"
            value={p.renaming}
            onChange={(e) => p.onRenameText(e.target.value)}
            onBlur={() => p.onRename(p.renaming ?? "")}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") p.onRename(p.renaming ?? "");
              if (e.key === "Escape") p.onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          p.t.title
        )}
        {p.on && (
          <button
            type="button"
            className="sx-ibtn"
            style={{ width: 22, height: 22 }}
            aria-label={`${p.t.title} options`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(menu ? null : "menu");
            }}
          >
            <ChevronDown size={14} />
          </button>
        )}
        {colour && <span className="bar" style={{ background: colour }} />}
      </div>
      {menu === "menu" && (
        <MenuList
          label={`${p.t.title} options`}
          style={{ position: "fixed", bottom: at?.bottom, left: at?.left }}
          onDone={() => setMenu((m) => (m === "colour" ? m : null))}
          items={[
            { label: "Delete", danger: true, disabled: p.ro, onClick: p.onDelete },
            { label: "Duplicate", disabled: p.ro, onClick: p.onDuplicate },
            { label: "Rename", disabled: p.ro, onClick: p.onRenameStart },
            { label: "Change colour", disabled: p.ro, onClick: () => setTimeout(() => setMenu("colour"), 0) },
            "-",
            { label: "Move right", disabled: p.ro || p.last, onClick: () => p.onMove(1) },
            { label: "Move left", disabled: p.ro || p.t.index === 0, onClick: () => p.onMove(-1) },
          ]}
        />
      )}
      {menu === "colour" && (
        <div className="sx-pop" style={{ position: "fixed", bottom: at?.bottom, left: at?.left }}>
          <Palette
            value={colour ?? undefined}
            reset="No colour"
            onPick={(h) => {
              p.onColour(h);
              setMenu(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useDismiss(true, onClose);
  return (
    <div ref={ref} className="sx-pop sx-dialog" role="dialog" aria-label={title}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>{title}</h2>
      {children}
    </div>
  );
}

function ConfirmDialog({ title, text, action, onClose, onConfirm }: { title: string; text: string; action: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p style={{ color: "var(--ix-muted)", fontSize: 13.5 }}>{text}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" className="sx-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sx-btn primary" style={{ background: "#dc2626", borderColor: "#dc2626" }} onClick={onConfirm}>
          {action}
        </button>
      </div>
    </Modal>
  );
}

function TextDialog(p: { title: string; label: string; placeholder?: string; initial: string; multiline?: boolean; extra?: string; onClose: () => void; onSave: (text: string, remove: boolean) => void }) {
  const [text, setText] = useState(p.initial);
  return (
    <Modal title={p.title} onClose={p.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) p.onSave(text, false);
        }}
      >
        {p.multiline ? (
          <textarea autoFocus aria-label={p.label} className="sx-input" style={{ width: "100%", minHeight: 90 }} value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <input autoFocus aria-label={p.label} className="sx-input" style={{ width: "100%" }} placeholder={p.placeholder} value={text} onChange={(e) => setText(e.target.value)} />
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {p.extra && (
            <button type="button" className="sx-btn" onClick={() => p.onSave("", true)}>
              {p.extra}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="sx-btn" onClick={p.onClose}>
            Cancel
          </button>
          <button className="sx-btn primary" disabled={!text.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FindDialog(p: { readOnly: boolean; onClose: () => void; onFind: (text: string, matchCase: boolean) => boolean | void; onReplaceAll: (find: string, replacement: string, matchCase: boolean, allSheets: boolean) => void }) {
  const [find, setFind] = useState("");
  const [rep, setRep] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [all, setAll] = useState(false);
  return (
    <Modal title="Find and replace" onClose={p.onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center" }}>
        <label htmlFor="sx-find">Find</label>
        <input id="sx-find" autoFocus className="sx-input" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === "Enter" && p.onFind(find, matchCase)} />
        <label htmlFor="sx-rep">Replace with</label>
        <input id="sx-rep" className="sx-input" value={rep} onChange={(e) => setRep(e.target.value)} disabled={p.readOnly} />
      </div>
      <label style={{ display: "flex", gap: 6, marginTop: 10, fontSize: 13 }}>
        <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
      </label>
      <label style={{ display: "flex", gap: 6, marginTop: 4, fontSize: 13 }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All sheets (replace)
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" className="sx-btn" onClick={p.onClose}>
          Done
        </button>
        <button type="button" className="sx-btn" disabled={!find} onClick={() => p.onFind(find, matchCase)}>
          Find
        </button>
        <button type="button" className="sx-btn primary" disabled={!find || p.readOnly} onClick={() => p.onReplaceAll(find, rep, matchCase, all)}>
          Replace all
        </button>
      </div>
    </Modal>
  );
}

function FilterMenu(p: { at: { x: number; y: number; c: number }; values: string[]; hidden: string[]; onSort: (asc: boolean) => void; onApply: (hidden: string[]) => void; onClose: () => void }) {
  const ref = useDismiss(true, p.onClose);
  const [hidden, setHidden] = useState(() => new Set(p.hidden));
  const [q, setQ] = useState("");
  const shownValues = p.values.filter((v) => v.toLowerCase().includes(q.toLowerCase()));
  return (
    <div ref={ref} className="sx-pop" role="dialog" aria-label={`Filter column ${colName(p.at.c)}`} style={{ position: "fixed", left: Math.min(p.at.x, window.innerWidth - 270), top: p.at.y + 8, width: 260, zIndex: 70 }}>
      <button type="button" className="sx-mi" onClick={() => p.onSort(true)}>
        Sort A to Z
      </button>
      <button type="button" className="sx-mi" onClick={() => p.onSort(false)}>
        Sort Z to A
      </button>
      <div className="sx-sep" />
      <b style={{ fontSize: 12.5 }}>Filter by values</b>
      <div style={{ display: "flex", gap: 10, fontSize: 12, margin: "6px 0" }}>
        <button type="button" style={{ color: "var(--ox-ink)", border: 0, background: "none", cursor: "pointer" }} onClick={() => setHidden(new Set())}>
          Select all
        </button>
        <button type="button" style={{ color: "var(--ox-ink)", border: 0, background: "none", cursor: "pointer" }} onClick={() => setHidden(new Set(p.values))}>
          Clear
        </button>
      </div>
      <input className="sx-input" style={{ width: "100%" }} placeholder="Search" aria-label="Search values" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ maxHeight: 200, overflowY: "auto", marginTop: 6 }}>
        {shownValues.map((v) => (
          <label key={v} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, padding: "2px 0" }}>
            <input
              type="checkbox"
              checked={!hidden.has(v)}
              onChange={(e) => {
                const n = new Set(hidden);
                if (e.target.checked) n.delete(v);
                else n.add(v);
                setHidden(n);
              }}
            />
            {v || <i style={{ color: "var(--ix-muted)" }}>(Blanks)</i>}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
        <button type="button" className="sx-btn" onClick={p.onClose}>
          Cancel
        </button>
        <button type="button" className="sx-btn primary" onClick={() => p.onApply([...hidden])}>
          OK
        </button>
      </div>
    </div>
  );
}

/** "Use as live data": link this sheet to an app built in the Builder, or build a new dashboard from it. */
function LiveData({ fileId, name, onClose, onMessage }: { fileId: string; name: string; onClose: () => void; onMessage: (t: string) => void }) {
  const perms = usePerms();
  const router = useRouter();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/google?view=projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]));
  }, []);
  async function linkTo(projectId: string) {
    setBusy(true);
    let pid = projectId;
    if (pid === "new") {
      const r = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${name} dashboard`.slice(0, 60), force: true }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.project) {
        setBusy(false);
        return onMessage(d.error ?? "Couldn't create the app.");
      }
      pid = d.project.id;
    }
    const r = await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "link", projectId: pid, spreadsheetId: fileId }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return onMessage(d.error ?? "Couldn't link the sheet.");
    if (projectId === "new") {
      try {
        sessionStorage.setItem(
          `seed:${pid}`,
          `Build a live dashboard from the Google Sheet "${name}" (id ${fileId}). It's already linked: read it with readSheetRows() from src/lib/live-sheets.ts and refresh every 60 seconds so changes in the sheet show up. Show the key totals as cards, a chart of the main numbers over time or by category, and a searchable table of the rows.`,
        );
      } catch {}
      router.push(`/projects/${pid}`);
      return;
    }
    onClose();
    onMessage(`Linked. The app can now read "${name}" live; ask the Builder to use it.`);
  }
  return (
    <Modal title={`Use "${name}" as live data`} onClose={onClose}>
      <p style={{ color: "var(--ix-muted)", fontSize: 13 }}>The app reads the sheet every minute, so changes in the sheet show up on its screens. Only this sheet is shared with the app.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {perms.builder && (
          <button type="button" className="sx-btn primary" disabled={busy} onClick={() => linkTo("new")}>
            {busy ? "Setting up…" : "Build a new dashboard from it"}
          </button>
        )}
        {projects === null ? (
          <span style={{ fontSize: 13, color: "var(--ix-muted)" }}>Loading your apps…</span>
        ) : projects.length > 0 ? (
          <select aria-label="Link to an existing app" className="sx-input" defaultValue="" disabled={busy} onChange={(e) => e.target.value && linkTo(e.target.value)}>
            <option value="">Link to an existing app…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <button type="button" className="sx-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
