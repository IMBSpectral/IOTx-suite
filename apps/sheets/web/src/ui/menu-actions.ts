// What the menus do: each action reads the grid's selection and runs engine commands with
// explicit ranges (the engine's own selection is not shared in collaboration mode).
import type { EngineClient } from "../engine/client";
import type { Info } from "../engine/protocol";
import { a1, colName, type Range, rangeA1 } from "../grid/axis";
import { type Grid, MAX_COLS, MAX_ROWS } from "../grid/grid";
import { div, field, openDialog, textInput } from "./menu-dialog";
import type { MenuEntry } from "./menu-popup";

export interface MenuContext {
  grid: Grid;
  engine: EngineClient;
  info(): Info | null;
  refreshInfo(): Promise<void>;
  flash(message: string, kind?: "info" | "error"): void;
}

let ctx!: MenuContext;
export function setContext(c: MenuContext): void {
  ctx = c;
}
export function context(): MenuContext {
  return ctx;
}

// ---------- selection helpers ----------

export const isWholeCols = (s: Range) => s.r0 === 0 && s.r1 >= MAX_ROWS - 1;
export const isWholeRows = (s: Range) => s.c0 === 0 && s.c1 >= MAX_COLS - 1;
export const rowSpan = (s: Range) => s.r1 - s.r0 + 1;
export const colSpan = (s: Range) => s.c1 - s.c0 + 1;
export const rowsRef = (a: number, b: number) => `${a + 1}:${b + 1}`;
export const colsRef = (a: number, b: number) => `${colName(a)}:${colName(b)}`;

/** Google's wording: "Insert 1 row above", "Insert 3 rows above". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "row" / "rows 2 - 5", "column" / "columns B - D". */
export function rowsLabel(s: Range): string {
  return s.r0 === s.r1 ? "row" : `rows ${s.r0 + 1} - ${s.r1 + 1}`;
}
export function colsLabel(s: Range): string {
  return s.c0 === s.c1 ? "column" : `columns ${colName(s.c0)} - ${colName(s.c1)}`;
}

/** The selection clamped to the used area (whole columns/rows stay cheap). */
export function clampedSelection(): Range {
  const s = ctx.grid.selection;
  const [ur, uc] = ctx.info()?.used_end ?? [0, 0];
  return { r0: s.r0, c0: s.c0, r1: Math.max(s.r0, Math.min(s.r1, ur)), c1: Math.max(s.c0, Math.min(s.c1, uc)) };
}
export const selRef = () => rangeA1(ctx.grid.selection);
/** The active cell; for header selections the first cell of the selection. */
export function activeCell(): { row: number; col: number } {
  const s = ctx.grid.selection;
  const a = ctx.grid.active;
  return { row: isWholeCols(s) ? s.r0 : a.row, col: isWholeRows(s) ? s.c0 : a.col };
}

// ---------- running commands ----------

async function ready(): Promise<void> {
  if (ctx.grid.isEditing) await ctx.grid.commit();
}

/** Runs one engine command, then returns focus to the grid. */
export async function run(id: string, params: unknown = {}): Promise<boolean> {
  await ready();
  const ok = await ctx.grid.run(id, params);
  ctx.grid.focus();
  return ok;
}

/** Runs a command that may change the sheet list or the active sheet, then refreshes tabs. */
export async function runSheets(id: string, params: unknown = {}): Promise<boolean> {
  await ready();
  const ok = await ctx.grid.run(id, params);
  if (ok) await afterSheetChange();
  ctx.grid.focus();
  return ok;
}

/** Resets the grid when the visible sheet changed, then refreshes info and tabs. */
export async function afterSheetChange(beforeName = activeSheetName()): Promise<void> {
  const next = await ctx.engine.info();
  if (next.sheets[next.active]?.name !== beforeName || next.active !== ctx.info()?.active) ctx.grid.reset();
  await ctx.refreshInfo();
}

export function activeSheetName(): string | undefined {
  const i = ctx.info();
  return i?.sheets[i.active]?.name;
}

/** Activates sheet `idx` (index into info.sheets). */
export async function activateSheet(idx: number): Promise<boolean> {
  const i = ctx.info();
  if (i && i.active === idx) return true;
  const ok = await ctx.grid.run("sheet.activate", { sheet: idx });
  if (ok) {
    ctx.grid.reset();
    await ctx.refreshInfo();
  }
  return ok;
}

// ---------- clipboard ----------

/** Menu Copy/Cut go through the grid's own clipboard handlers (a trusted copy event). */
export async function clipboard(kind: "copy" | "cut"): Promise<void> {
  await ready();
  ctx.grid.focus();
  let ok = false;
  try {
    ok = document.execCommand(kind);
  } catch {
    ok = false;
  }
  if (!ok) clipboardHint();
}

/** Paste reads the system clipboard when the browser allows it; otherwise explains Ctrl+V. */
export async function paste(): Promise<void> {
  await ready();
  const s = ctx.grid.selection;
  try {
    const text = await navigator.clipboard.readText();
    await run("edit.paste", { at: a1(s.r0, s.c0), text });
  } catch {
    clipboardHint();
  }
}

export async function pasteSpecial(what: string, extra: Record<string, unknown> = {}): Promise<void> {
  const s = ctx.grid.selection;
  await run("edit.pasteSpecial", { what, at: a1(s.r0, s.c0), ...extra });
}

export function clipboardHint(): void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const k = mac ? "⌘" : "Ctrl+";
  const body = div(
    "dlg-text",
    "These actions are unavailable via the Edit menu, but you can still use:",
    div("dlg-keys", div("", `${k}C`, " for copy"), div("", `${k}X`, " for cut"), div("", `${k}V`, " for paste")),
  );
  openDialog({ title: "Copying and pasting in this browser", body, buttons: [{ label: "OK", primary: true }], onClose: () => ctx.grid.focus(), testid: "clipboard-hint" });
}

// ---------- rows, columns, cells ----------

export const insertRowsAbove = (s = ctx.grid.selection) => run("home.insertRows", { rows: rowsRef(s.r0, s.r1) });
export const insertRowsBelow = (s = ctx.grid.selection) => run("home.insertRows", { rows: rowsRef(s.r1 + 1, s.r1 + rowSpan(s)) });
export const insertColsLeft = (s = ctx.grid.selection) => run("home.insertColumns", { cols: colsRef(s.c0, s.c1) });
export const insertColsRight = (s = ctx.grid.selection) => run("home.insertColumns", { cols: colsRef(s.c1 + 1, s.c1 + colSpan(s)) });
export const deleteRows = (s = ctx.grid.selection) => run("home.deleteRows", { rows: rowsRef(s.r0, s.r1) });
export const deleteCols = (s = ctx.grid.selection) => run("home.deleteColumns", { cols: colsRef(s.c0, s.c1) });
export const insertCells = (shift: "right" | "down") => run("home.insertCells", { range: rangeA1(clampedSelection()), shift });
export const deleteCells = (shift: "left" | "up") => run("home.deleteCells", { range: rangeA1(clampedSelection()), shift });
export const clearContents = () => run("edit.clearContents", { range: selRef() });
export const hideRows = (s = ctx.grid.selection) => run("home.hideRows", { rows: rowsRef(s.r0, s.r1) });
export const hideCols = (s = ctx.grid.selection) => run("home.hideColumns", { cols: colsRef(s.c0, s.c1) });

/** Hidden lines inside or next to the selection: `[first, last]` to unhide, or null. */
export async function hiddenNear(axis: "row" | "col", s: Range): Promise<[number, number] | null> {
  const a = Math.max(0, (axis === "row" ? s.r0 : s.c0) - 1);
  const raw = axis === "row" ? s.r1 : s.c1;
  const b = Math.min(raw + 1, a + 2000, (axis === "row" ? MAX_ROWS : MAX_COLS) - 1);
  const vp = axis === "row" ? await ctx.engine.viewport(a, 0, b, 0) : await ctx.engine.viewport(0, a, 0, b);
  const sizes = axis === "row" ? vp.row_heights : vp.col_widths;
  let lo = -1;
  let hi = -1;
  sizes.forEach((w, k) => {
    if (w === 0) {
      if (lo < 0) lo = a + k;
      hi = a + k;
    }
  });
  if (lo < 0) return null;
  // Extend through a hidden run that continues past the window's edges.
  return [lo, hi];
}

export function unhide(axis: "row" | "col", span: [number, number]): Promise<boolean> {
  return axis === "row"
    ? run("home.unhideRows", { rows: rowsRef(span[0], span[1]) })
    : run("home.unhideColumns", { cols: colsRef(span[0], span[1]) });
}

/** Google's "Resize column" / "Resize row" dialog. */
export function resizeDialog(axis: "row" | "col", s = ctx.grid.selection): void {
  const isCol = axis === "col";
  const noun = isCol ? colsLabel(s) : rowsLabel(s);
  const def = isCol ? (ctx.info()?.default_col_width ?? 100) : (ctx.info()?.default_row_height ?? 21);
  const current = isCol ? ctx.grid.cols.size(s.c0) : ctx.grid.rows.size(s.r0);
  const name = `resize-${Math.random().toString(36).slice(2)}`;
  const radio = (checked: boolean, testid: string) => {
    const r = document.createElement("input");
    r.type = "radio";
    r.name = name;
    r.checked = checked;
    r.dataset.testid = testid;
    return r;
  };
  const px = radio(true, "resize-pixels");
  const fit = radio(false, "resize-fit");
  const size = textInput(String(current || def), "resize-size", isCol ? "Column width in pixels" : "Row height in pixels");
  size.type = "number";
  size.min = "2";
  size.addEventListener("focus", () => (px.checked = true));
  const l1 = document.createElement("label");
  l1.className = "dlg-radio";
  l1.append(px, ` Enter new ${isCol ? "column width" : "row height"} in pixels. (Default: ${def})`);
  const l2 = document.createElement("label");
  l2.className = "dlg-radio";
  l2.append(fit, " Fit to data");
  const body = div("dlg-stack", l1, div("dlg-indent", size), l2);
  const ref = isCol ? colsRef(s.c0, s.c1) : rowsRef(s.r0, s.r1);
  openDialog({
    title: `Resize ${noun.replace(/^(row|column)$/, isCol ? `column ${colName(s.c0)}` : `row ${s.r0 + 1}`)}`,
    body,
    testid: "resize-dialog",
    onClose: () => ctx.grid.focus(),
    buttons: [
      { label: "Cancel" },
      {
        label: "OK",
        primary: true,
        id: "resize-ok",
        run: async () => {
          if (fit.checked) await run(isCol ? "home.autofitColumnWidth" : "home.autofitRowHeight", isCol ? { cols: ref } : { rows: ref });
          else {
            const n = Math.round(Number(size.value));
            if (!Number.isFinite(n) || n < 2) {
              size.focus();
              return false;
            }
            await run(isCol ? "home.columnWidth" : "home.rowHeight", isCol ? { cols: ref, width: n } : { rows: ref, height: n });
          }
        },
      },
    ],
  });
  size.focus();
  size.select();
}

// ---------- sort and filter ----------

/** The sheet's data below the frozen rows (Google's "Sort sheet"). */
export function sheetDataRange(): Range | null {
  const i = ctx.info();
  if (!i?.used_end) return null;
  const top = i.freeze[0];
  if (top > i.used_end[0]) return null;
  return { r0: top, c0: 0, r1: i.used_end[0], c1: i.used_end[1] };
}

export async function sortSheet(col: number, desc: boolean): Promise<void> {
  const r = sheetDataRange();
  if (!r) return ctx.flash("There is nothing to sort");
  await run(desc ? "data.sortDescending" : "data.sortAscending", { range: rangeA1({ ...r, c1: Math.max(r.c1, col) }), column: colName(col) });
}

export async function sortRange(col: number, desc: boolean): Promise<void> {
  const r = clampedSelection();
  await run(desc ? "data.sortDescending" : "data.sortAscending", { range: rangeA1(r), column: colName(col) });
}

export async function filterRange(): Promise<[number, number, number, number] | null> {
  const vp = await ctx.engine.viewport(0, 0, 0, 0);
  return vp.filter?.range ?? null;
}

/** Create a filter over the selection (several cells) or the sheet's data (one cell). */
export async function createFilter(): Promise<void> {
  const s = ctx.grid.selection;
  let r: Range;
  if (s.r0 === s.r1 && s.c0 === s.c1) {
    const end = ctx.info()?.used_end ?? [0, 0];
    r = { r0: 0, c0: 0, r1: Math.max(end[0], s.r0), c1: Math.max(end[1], s.c0) };
  } else r = clampedSelection();
  await run("data.filter", { range: rangeA1(r) });
}

export async function removeFilter(): Promise<void> {
  const f = await filterRange();
  if (!f) return;
  await run("data.filter", { range: rangeA1({ r0: f[0], c0: f[1], r1: f[2], c1: f[3] }) });
}

// ---------- freeze ----------

export async function freeze(rows: number | null, cols: number | null): Promise<void> {
  const [fr, fc] = ctx.info()?.freeze ?? [0, 0];
  const r = rows ?? fr;
  const c = cols ?? fc;
  if (r === 0 && c === 0) await run("view.unfreezePanes", {});
  else await run("view.freezePanes", { cell: a1(r, c) });
  await ctx.refreshInfo();
}

// ---------- link ----------

export function linkDialog(): void {
  const { row, col } = activeCell();
  const cell = a1(row, col);
  void ctx.engine.editText(row, col).then((current) => {
    const text = textInput(current.startsWith("=") ? "" : current, "link-text", "Text");
    const target = textInput("", "link-url", "Link");
    target.placeholder = "Search or paste a link";
    const body = div("dlg-stack", field("Text", text), field("Link", target));
    openDialog({
      title: "Insert link",
      body,
      testid: "link-dialog",
      width: 360,
      onClose: () => ctx.grid.focus(),
      buttons: [
        {
          label: "Apply",
          primary: true,
          id: "link-apply",
          run: async () => {
            let url = target.value.trim();
            if (!url) return false;
            if (!/^([a-z][a-z0-9+.-]*:|#|[A-Za-z0-9_' ]+!)/i.test(url) && /\./.test(url)) url = `https://${url}`;
            await run("insert.link", { cell, target: url, text: text.value || url });
          },
        },
      ],
    });
    target.focus();
  });
}

// ---------- downloads ----------

export function downloadBlob(bytes: BlobPart, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadAs(format: "csv" | "tsv" | "html" | "json"): Promise<void> {
  try {
    const r = await ctx.engine.execute("file.saveBytes", { format });
    const b64 = (r.result as { base64?: string } | null)?.base64 ?? "";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const title = (document.getElementById("title") as HTMLInputElement | null)?.value.trim() || "Untitled spreadsheet";
    const sheet = activeSheetName() ?? "Sheet1";
    const types = { csv: "text/csv", tsv: "text/tab-separated-values", html: "text/html", json: "application/json" };
    const name = format === "csv" || format === "tsv" ? `${title} - ${sheet}.${format}` : `${title}.${format}`;
    downloadBlob(bytes, name, types[format]);
  } catch (e) {
    ctx.flash(`Couldn't download: ${e instanceof Error ? e.message : e}`, "error");
  }
}

/** Shared "Paste special" submenu. */
export function pasteSpecialMenu(): MenuEntry[] {
  return [
    { label: "Values only", shortcut: "Ctrl+Shift+V", id: "paste-values", run: () => pasteSpecial("values") },
    { label: "Format only", shortcut: "Ctrl+Alt+V", id: "paste-formats", run: () => pasteSpecial("formats") },
    { label: "All except borders", run: () => pasteSpecial("allExceptBorders") },
    { label: "Column widths only", run: () => pasteSpecial("columnWidths") },
    { label: "Formula only", run: () => pasteSpecial("formulas") },
    "-",
    { label: "Transposed", run: () => pasteSpecial("all", { transpose: true }) },
  ];
}
