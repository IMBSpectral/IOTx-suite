// The menu bar under the title (File Edit View Insert Format Data Tools Help), keyboard
// shortcuts that open menus and dialogs, and the wiring for the right-click and tab menus.
import "./menus.css";
import { colName, rangeA1 } from "../grid/axis";
import {
  activateSheet,
  activeCell,
  clampedSelection,
  clearContents,
  clipboard,
  colSpan,
  colsLabel,
  context,
  createFilter,
  deleteCells,
  deleteCols,
  deleteRows,
  downloadAs,
  downloadBlob,
  filterRange,
  freeze,
  insertCells,
  insertColsLeft,
  insertColsRight,
  insertRowsAbove,
  insertRowsBelow,
  linkDialog,
  type MenuContext,
  paste,
  pasteSpecialMenu,
  plural,
  removeFilter,
  rowSpan,
  rowsLabel,
  run,
  runSheets,
  selRef,
  setContext,
  sortRange,
  sortSheet,
} from "./menu-actions";
import { div, openDialog, textInput } from "./menu-dialog";
import { closeMenus, type MenuEntry, type MenuItem, menuOpen, openMenu, type PopupMenu } from "./menu-popup";
import { openFind, openReplace } from "./find";


export { showGridMenu } from "./contextmenu";
export { renderSheetTabs } from "./menu-tabs";

const mac = /Mac|iPhone|iPad/.test(navigator.platform);
/** Shortcut text the way Google prints it on this platform. */
export const key = (s: string) => (mac ? s.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : s);

/** Per-sheet "Show formulas" state (the engine toggles it but doesn't report it). */
const showingFormulas = new Map<string, boolean>();

interface MenuState {
  filter: boolean;
}

const activeName = () => {
  const i = context().info();
  return i?.sheets[i.active]?.name ?? "";
};

// ---------- menu contents ----------

function fileMenu(): MenuEntry[] {
  const click = (id: string) => () => document.getElementById(id)?.click();
  return [
    { label: "New", icon: "▤", submenu: () => [{ label: "Spreadsheet", id: "file-new", run: click("new") }] },
    { label: "Open", icon: "📂", shortcut: key("Ctrl+O"), id: "file-open", run: click("open-file") },
    "-",
    { label: "Share", icon: "👤", submenu: () => [{ label: "Share with others", id: "file-share", run: click("share") }] },
    {
      label: "Download",
      icon: "⤓",
      submenu: () => [
        { label: "Microsoft Excel (.xlsx)", id: "download-xlsx", run: click("download") },
        { label: "PDF (.pdf)", id: "download-pdf", run: downloadPdf },
        { label: "Web page (.html)", run: () => downloadAs("html") },
        { label: "Comma Separated Values (.csv)", id: "download-csv", run: () => downloadAs("csv") },
        { label: "Tab Separated Values (.tsv)", run: () => downloadAs("tsv") },
      ],
    },
    "-",
    {
      label: "Rename",
      icon: "✎",
      id: "file-rename",
      run: () => {
        const t = document.getElementById("title") as HTMLInputElement | null;
        t?.focus();
        t?.select();
      },
    },
    "-",
    { label: "Print", icon: "⎙", shortcut: key("Ctrl+P"), id: "file-print", run: printPdf },
  ];
}

async function pdfBytes(): Promise<Uint8Array | null> {
  const { engine, flash } = context();
  try {
    const r = await engine.execute("file.exportPdf", { sheets: "active" });
    const b64 = (r.result as { base64?: string } | null)?.base64;
    if (!b64) throw new Error("no PDF was produced");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    return bytes;
  } catch (e) {
    flash(`Couldn't make a PDF: ${e instanceof Error ? e.message : e}`, "error");
    return null;
  }
}

async function downloadPdf(): Promise<void> {
  const bytes = await pdfBytes();
  const title = (document.getElementById("title") as HTMLInputElement | null)?.value.trim() || "Untitled spreadsheet";
  if (bytes) downloadBlob(bytes as BlobPart, `${title}.pdf`, "application/pdf");
}

async function printPdf(): Promise<void> {
  const bytes = await pdfBytes();
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function editMenu(): MenuEntry[] {
  const { grid, info } = context();
  const s = grid.selection;
  const i = info();
  return [
    { label: "Undo", icon: "↶", shortcut: key("Ctrl+Z"), id: "edit-undo", disabled: i ? !i.can_undo : false, run: () => run("edit.undo", {}) },
    { label: "Redo", icon: "↷", shortcut: key("Ctrl+Y"), id: "edit-redo", disabled: i ? !i.can_redo : false, run: () => run("edit.redo", {}) },
    "-",
    { label: "Cut", icon: "✂", shortcut: key("Ctrl+X"), id: "edit-cut", run: () => clipboard("cut") },
    { label: "Copy", icon: "⧉", shortcut: key("Ctrl+C"), id: "edit-copy", run: () => clipboard("copy") },
    { label: "Paste", icon: "📋", shortcut: key("Ctrl+V"), id: "edit-paste", run: paste },
    { label: "Paste special", icon: "📋", submenu: pasteSpecialMenu },
    "-",
    {
      label: "Delete",
      icon: "🗑",
      submenu: () => [
        { label: "Values", id: "delete-values", run: clearContents },
        { label: rowsLabel(s).replace(/^r/, "R").replace(/^Row$/, `Row ${s.r0 + 1}`), id: "delete-rows", run: () => deleteRows() },
        { label: colsLabel(s).replace(/^c/, "C").replace(/^Column$/, `Column ${colName(s.c0)}`), id: "delete-cols", run: () => deleteCols() },
        { label: "Cells and shift up", run: () => deleteCells("up") },
        { label: "Cells and shift left", run: () => deleteCells("left") },
      ],
    },
    "-",
    { label: "Find and replace", icon: "🔍", shortcut: key("Ctrl+H"), id: "edit-replace", run: () => openReplace() },
  ];
}

function viewMenu(): MenuEntry[] {
  const { info } = context();
  const i = info();
  const [fr, fc] = i?.freeze ?? [0, 0];
  const at = activeCell();
  const hidden = (i?.sheets ?? []).map((s, idx) => ({ s, idx })).filter((x) => x.s.hidden);
  return [
    {
      label: "Show",
      icon: "👁",
      submenu: () => [
        { label: "Gridlines", id: "show-gridlines", checked: i?.gridlines ?? true, run: () => run("view.gridlines", { on: !(i?.gridlines ?? true) }) },
        { label: "Formulas", id: "show-formulas", shortcut: key("Ctrl+`"), checked: showingFormulas.get(activeName()) ?? false, run: toggleFormulas },
      ],
    },
    {
      label: "Freeze",
      icon: "❄",
      submenu: () => [
        { label: "No rows", id: "freeze-rows-0", checked: fr === 0, run: () => freeze(0, null) },
        { label: "1 row", id: "freeze-rows-1", checked: fr === 1, run: () => freeze(1, null) },
        { label: "2 rows", id: "freeze-rows-2", checked: fr === 2, run: () => freeze(2, null) },
        { label: `Up to row ${at.row + 1}`, id: "freeze-rows-active", checked: fr === at.row + 1 && fr > 2, disabled: at.row + 1 > 1000, run: () => freeze(at.row + 1, null) },
        "-",
        { label: "No columns", id: "freeze-cols-0", checked: fc === 0, run: () => freeze(null, 0) },
        { label: "1 column", id: "freeze-cols-1", checked: fc === 1, run: () => freeze(null, 1) },
        { label: "2 columns", id: "freeze-cols-2", checked: fc === 2, run: () => freeze(null, 2) },
        { label: `Up to column ${colName(at.col)}`, id: "freeze-cols-active", checked: fc === at.col + 1 && fc > 2, disabled: at.col + 1 > 100, run: () => freeze(null, at.col + 1) },
      ],
    },
    "-",
    {
      label: "Hidden sheets",
      icon: "▦",
      disabled: hidden.length === 0,
      hint: hidden.length ? `(${hidden.length})` : "",
      submenu: () =>
        hidden.map((h) => ({
          label: h.s.name,
          run: async () => {
            if (await runSheets("sheet.unhide", { sheet: h.idx })) await activateSheet(h.idx);
            context().grid.focus();
          },
        })),
    },
    "-",
    {
      label: "Full screen",
      icon: "⛶",
      id: "view-fullscreen",
      run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
    },
  ];
}

async function toggleFormulas(): Promise<void> {
  const name = activeName();
  const on = !(showingFormulas.get(name) ?? false);
  if (await run("formulas.showFormulas", { on })) showingFormulas.set(name, on);
}

function insertMenu(): MenuEntry[] {
  const s = context().grid.selection;
  const n = rowSpan(s);
  const m = colSpan(s);
  return [
    {
      label: "Cells",
      icon: "▦",
      submenu: () => [
        { label: "Insert cells and shift right", id: "insert-cells-right", run: () => insertCells("right") },
        { label: "Insert cells and shift down", id: "insert-cells-down", run: () => insertCells("down") },
      ],
    },
    {
      label: "Rows",
      icon: "☰",
      submenu: () => [
        { label: `Insert ${plural(n, "row", "rows")} above`, id: "insert-rows-above", run: () => insertRowsAbove() },
        { label: `Insert ${plural(n, "row", "rows")} below`, id: "insert-rows-below", run: () => insertRowsBelow() },
      ],
    },
    {
      label: "Columns",
      icon: "▥",
      submenu: () => [
        { label: `Insert ${plural(m, "column", "columns")} left`, id: "insert-cols-left", run: () => insertColsLeft() },
        { label: `Insert ${plural(m, "column", "columns")} right`, id: "insert-cols-right", run: () => insertColsRight() },
      ],
    },
    {
      label: "Sheet",
      icon: "⊞",
      shortcut: "Shift+F11",
      id: "insert-sheet",
      run: () => insertSheet(),
    },
    "-",
    { label: "Link", icon: "🔗", shortcut: key("Ctrl+K"), id: "insert-link", run: linkDialog },
    "-",
    { label: "Checkbox", icon: "☑", id: "insert-checkbox", run: () => run("insert.checkbox", { range: rangeA1(clampedSelection()) }) },
  ];
}

/** Insert › Sheet: a new sheet right after the active one, made active. */
export async function insertSheet(): Promise<void> {
  const i = context().info();
  const before = i ? i.active + 1 : undefined;
  if (await context().grid.run("home.insertSheet", before !== undefined && i && before < i.sheets.length ? { before } : {})) {
    context().grid.reset();
    await context().refreshInfo();
  }
  context().grid.focus();
}

const NUMBER_FORMATS: [string, string, string][] = [
  ["Automatic", "General", ""],
  ["Plain text", "@", ""],
  ["-", "", ""],
  ["Number", "#,##0.00", "1,000.12"],
  ["Percent", "0.00%", "10.12%"],
  ["Scientific", "0.00E+00", "1.01E+03"],
  ["-", "", ""],
  ["Accounting", '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', "$ (1,000.12)"],
  ["Financial", "#,##0.00;(#,##0.00)", "(1,000.12)"],
  ["Currency", '"$"#,##0.00', "$1,000.12"],
  ["Currency rounded", '"$"#,##0', "$1,000"],
  ["-", "", ""],
  ["Date", "m/d/yyyy", "9/26/2008"],
  ["Time", "h:mm:ss AM/PM", "3:59:00 PM"],
  ["Date time", "m/d/yyyy h:mm:ss", "9/26/2008 15:59:00"],
  ["Duration", "[h]:mm:ss", "24:01:00"],
];

function formatMenu(): MenuEntry[] {
  const range = () => rangeA1(clampedSelection());
  const fmt = (format: string) => run("home.numberFormat", { range: range(), format });
  return [
    {
      label: "Number",
      icon: "123",
      submenu: () =>
        NUMBER_FORMATS.map(([label, code, hint]): MenuEntry =>
          label === "-" ? "-" : { label, hint, id: `number-${label.toLowerCase().replace(/\s+/g, "-")}`, run: () => fmt(code) },
        ),
    },
    {
      label: "Text",
      icon: "B",
      submenu: () => [
        { label: "Bold", icon: "B", shortcut: key("Ctrl+B"), id: "text-bold", run: () => run("home.bold", { range: selRef() }) },
        { label: "Italic", icon: "I", shortcut: key("Ctrl+I"), id: "text-italic", run: () => run("home.italic", { range: selRef() }) },
        { label: "Underline", icon: "U", shortcut: key("Ctrl+U"), id: "text-underline", run: () => run("home.underline", { range: selRef() }) },
        { label: "Strikethrough", icon: "S", shortcut: key("Alt+Shift+5"), id: "text-strike", run: () => run("home.strikethrough", { range: selRef() }) },
      ],
    },
    {
      label: "Alignment",
      icon: "≡",
      submenu: () => [
        { label: "Left", shortcut: key("Ctrl+Shift+L"), id: "align-left", run: () => run("home.alignLeft", { range: selRef() }) },
        { label: "Center", shortcut: key("Ctrl+Shift+E"), id: "align-center", run: () => run("home.alignCenter", { range: selRef() }) },
        { label: "Right", shortcut: key("Ctrl+Shift+R"), id: "align-right", run: () => run("home.alignRight", { range: selRef() }) },
        "-",
        { label: "Top", id: "align-top", run: () => run("home.alignTop", { range: selRef() }) },
        { label: "Middle", id: "align-middle", run: () => run("home.alignMiddle", { range: selRef() }) },
        { label: "Bottom", id: "align-bottom", run: () => run("home.alignBottom", { range: selRef() }) },
      ],
    },
    {
      label: "Wrapping",
      icon: "↵",
      submenu: () => [
        { label: "Overflow", id: "wrap-overflow", run: () => run("home.wrapText", { range: selRef(), on: false }) },
        { label: "Wrap", id: "wrap-wrap", run: () => run("home.wrapText", { range: selRef(), on: true }) },
        { label: "Clip", id: "wrap-clip", run: () => run("home.wrapText", { range: selRef(), on: false }) },
      ],
    },
    {
      label: "Rotation",
      icon: "⟲",
      submenu: () =>
        (
          [
            ["None", 0],
            ["Tilt up", 45],
            ["Tilt down", -45],
            ["Stack vertically", "vertical"],
            ["Rotate up", 90],
            ["Rotate down", -90],
          ] as [string, number | string][]
        ).map(([label, angle]) => ({ label, run: () => run("home.orientation", { range: selRef(), angle }) })),
    },
    "-",
    {
      label: "Font size",
      icon: "TT",
      submenu: () => [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36].map((size) => ({ label: String(size), id: `font-size-${size}`, run: () => run("home.fontSize", { range: selRef(), size }) })),
    },
    {
      label: "Merge cells",
      icon: "⊟",
      submenu: () => {
        const s = clampedSelection();
        const multi = s.r0 !== s.r1 || s.c0 !== s.c1;
        return [
          { label: "Merge all", id: "merge-all", disabled: !multi, run: () => run("home.mergeCells", { range: rangeA1(s) }) },
          { label: "Merge horizontally", id: "merge-horizontal", disabled: s.c0 === s.c1, run: () => run("home.mergeAcross", { range: rangeA1(s) }) },
          { label: "Merge vertically", id: "merge-vertical", disabled: s.r0 === s.r1, run: () => mergeVertically() },
          { label: "Unmerge", id: "merge-unmerge", run: () => run("home.unmergeCells", { range: rangeA1(s) }) },
        ];
      },
    },
    "-",
    { label: "Clear formatting", icon: "⌧", shortcut: key("Ctrl+\\"), id: "format-clear", run: clearFormatting },
  ];
}

const clearFormatting = () => run("edit.clearFormats", { range: rangeA1(clampedSelection()) });

async function mergeVertically(): Promise<void> {
  const s = clampedSelection();
  for (let c = s.c0; c <= s.c1; c++) await run("home.mergeCells", { range: rangeA1({ r0: s.r0, c0: c, r1: s.r1, c1: c }) });
}

function dataMenu(state: MenuState): MenuEntry[] {
  const at = activeCell();
  const col = colName(at.col);
  const s = clampedSelection();
  return [
    {
      label: "Sort sheet",
      icon: "⇅",
      submenu: () => [
        { label: `Sort sheet by column ${col} (A to Z)`, id: "sort-sheet-asc", run: () => sortSheet(at.col, false) },
        { label: `Sort sheet by column ${col} (Z to A)`, id: "sort-sheet-desc", run: () => sortSheet(at.col, true) },
      ],
    },
    {
      label: "Sort range",
      icon: "⇅",
      disabled: s.r0 === s.r1 && s.c0 === s.c1,
      submenu: () => [
        { label: `Sort range by column ${col} (A to Z)`, id: "sort-range-asc", run: () => sortRange(at.col, false) },
        { label: `Sort range by column ${col} (Z to A)`, id: "sort-range-desc", run: () => sortRange(at.col, true) },
      ],
    },
    "-",
    state.filter
      ? { label: "Remove filter", icon: "⏷", shortcut: key("Ctrl+Alt+R"), id: "data-filter", run: removeFilter }
      : { label: "Create a filter", icon: "⏷", id: "data-filter", run: createFilter },
    "-",
    {
      label: "Data cleanup",
      icon: "✧",
      submenu: () => [{ label: "Remove duplicates", id: "remove-duplicates", run: removeDuplicates }],
    },
    { label: "Split text to columns", icon: "⫼", id: "split-text", run: splitText },
  ];
}

async function removeDuplicates(): Promise<void> {
  const { grid, info, flash } = context();
  let r = clampedSelection();
  const s = grid.selection;
  if (s.r0 === s.r1 && s.c0 === s.c1) {
    const end = info()?.used_end;
    if (!end) return flash("There is no data to clean up");
    r = { r0: 0, c0: 0, r1: end[0], c1: end[1] };
  }
  try {
    const res = await context().engine.execute("data.removeDuplicates", { range: rangeA1(r) });
    grid.markChanged(res.revision);
    const { removed = 0, remaining = 0 } = (res.result ?? {}) as { removed?: number; remaining?: number };
    const msg = removed ? `${removed} duplicate row${removed === 1 ? "" : "s"} found and removed. ${remaining} unique row${remaining === 1 ? "" : "s"} remain.` : "No duplicate rows found.";
    flash(msg);
    openDialog({ title: "Remove duplicates", body: msg, buttons: [{ label: "OK", primary: true }], onClose: () => grid.focus(), testid: "dedupe-result" });
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e), "error");
  }
}

/** Split text to columns with Google's "Detect automatically" separator. */
async function splitText(): Promise<void> {
  const { engine } = context();
  const r = clampedSelection();
  const vp = await engine.viewport(r.r0, r.c0, Math.min(r.r1, r.r0 + 200), r.c0);
  const sample = vp.cells.map((c) => c[2]).join("\n");
  const sep = [",", ";", "\t", "|", " "].find((d) => sample.includes(d)) ?? ",";
  await run("data.textToColumns", { range: rangeA1({ ...r, c1: r.c0 }), delimiters: [sep] });
}

function toolsMenu(): MenuEntry[] {
  return [{ label: "Recalculate now", icon: "⟳", hint: "F9", id: "tools-recalc", run: () => run("formulas.calculateNow", {}) }];
}

function helpMenu(): MenuEntry[] {
  return [
    { label: "Search the menus", icon: "🔍", shortcut: key("Alt+/"), id: "help-search", run: searchMenus },
    "-",
    { label: "Keyboard shortcuts", icon: "⌨", shortcut: key("Ctrl+/"), id: "help-shortcuts", run: shortcutsDialog },
  ];
}

// ---------- Help ----------

const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Common actions",
    [
      ["Select column", "Ctrl+Space"],
      ["Select all", "Ctrl+A"],
      ["Undo", "Ctrl+Z"],
      ["Redo", "Ctrl+Y"],
      ["Find", "Ctrl+F"],
      ["Find and replace", "Ctrl+H"],
      ["Fill range", "Ctrl+Enter"],
      ["Insert link", "Ctrl+K"],
      ["Show formulas", "Ctrl+`"],
      ["Search the menus", "Alt+/"],
      ["Show common keyboard shortcuts", "Ctrl+/"],
    ],
  ],
  [
    "Cell formatting",
    [
      ["Bold", "Ctrl+B"],
      ["Italic", "Ctrl+I"],
      ["Underline", "Ctrl+U"],
      ["Strikethrough", "Alt+Shift+5"],
      ["Clear formatting", "Ctrl+\\"],
    ],
  ],
  [
    "Navigating spreadsheets",
    [
      ["Move to beginning of row", "Home"],
      ["Move to beginning of sheet", "Ctrl+Home"],
      ["Move to next sheet", "Ctrl+PageDown"],
      ["Move to previous sheet", "Ctrl+PageUp"],
      ["Open the File menu", "Alt+F"],
      ["Open the Edit menu", "Alt+E"],
      ["Open the Data menu", "Alt+D"],
    ],
  ],
  [
    "Edit",
    [
      ["Copy", "Ctrl+C"],
      ["Cut", "Ctrl+X"],
      ["Paste", "Ctrl+V"],
      ["Paste values only", "Ctrl+Shift+V"],
      ["Edit the active cell", "F2"],
      ["Delete values", "Delete"],
      ["Insert new sheet", "Shift+F11"],
    ],
  ],
];

export function shortcutsDialog(): void {
  const filter = textInput("", "shortcuts-search", "Search keyboard shortcuts");
  filter.placeholder = "Search keyboard shortcuts";
  const list = div("kbd-list");
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren(
      ...SHORTCUTS.flatMap(([section, rows]) => {
        const hit = rows.filter(([what, k]) => !q || what.toLowerCase().includes(q) || k.toLowerCase().includes(q));
        if (!hit.length) return [];
        const h = document.createElement("h3");
        h.textContent = section;
        const table = div("kbd-section", ...hit.map(([what, k]) => div("kbd-row", div("kbd-what", what), div("kbd-keys", key(k)))));
        return [h, table];
      }),
    );
  };
  filter.addEventListener("input", draw);
  draw();
  openDialog({ title: "Keyboard shortcuts", body: div("dlg-stack", filter, list), testid: "shortcuts-dialog", width: 720, onClose: () => context().grid.focus() });
}

/** Help › Search the menus: type to find any menu item and run it. */
function searchMenus(): void {
  const input = textInput("", "menu-search", "Search the menus");
  input.placeholder = "Search the menus (Alt+/)";
  const list = div("menu-search-list");
  list.setAttribute("role", "listbox");
  let hits: { path: string; item: MenuItem }[] = [];
  let at = 0;
  const all = (): { path: string; item: MenuItem }[] => {
    const out: { path: string; item: MenuItem }[] = [];
    const walk = (entries: MenuEntry[], path: string) => {
      for (const e of entries) {
        if (e === "-" || !("label" in e)) continue;
        if (e.submenu) walk(e.submenu(), `${path}${e.label} › `);
        else if (e.run && !e.disabled) out.push({ path: `${path}${e.label}`, item: e });
      }
    };
    for (const m of MENUS) walk(m.build({ filter: lastFilter }), `${m.label} › `);
    return out;
  };
  const items = all();
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    hits = q ? items.filter((h) => h.path.toLowerCase().includes(q)).slice(0, 12) : [];
    at = Math.min(at, Math.max(0, hits.length - 1));
    list.replaceChildren(
      ...hits.map((h, k) => {
        const d = div(k === at ? "menu-search-hit on" : "menu-search-hit", h.path);
        d.setAttribute("role", "option");
        d.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(k);
        });
        return d;
      }),
    );
  };
  const choose = (k: number) => {
    const h = hits[k];
    if (!h) return;
    dlg.close();
    void Promise.resolve(h.item.run?.());
  };
  input.addEventListener("input", () => {
    at = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = Math.max(0, Math.min(hits.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(at);
    }
  });
  const dlg = openDialog({ title: "Search the menus", body: div("dlg-stack", input, list), testid: "menu-search-dialog", width: 480, onClose: () => context().grid.focus() });
}

// ---------- the bar ----------

const MENUS: { label: string; key: string; build: (s: MenuState) => MenuEntry[] }[] = [
  { label: "File", key: "f", build: fileMenu },
  { label: "Edit", key: "e", build: editMenu },
  { label: "View", key: "v", build: viewMenu },
  { label: "Insert", key: "i", build: insertMenu },
  { label: "Format", key: "o", build: formatMenu },
  { label: "Data", key: "d", build: dataMenu },
  { label: "Tools", key: "t", build: toolsMenu },
  { label: "Help", key: "h", build: helpMenu },
];

let lastFilter = false;
let bar: HTMLElement;
let buttons: HTMLButtonElement[] = [];
let openIndex = -1;
let current: PopupMenu | null = null;
let openToken = 0;

async function openTop(index: number, keyboard: boolean): Promise<void> {
  const n = MENUS.length;
  index = ((index % n) + n) % n;
  const token = ++openToken;
  if (context().grid.isEditing) await context().grid.commit();
  try {
    lastFilter = (await filterRange()) !== null;
  } catch {
    lastFilter = false;
  }
  if (token !== openToken) return; // a later open (fast hover across the bar) wins
  const m = MENUS[index];
  buttons.forEach((b, k) => {
    b.setAttribute("aria-expanded", String(k === index));
    b.classList.toggle("open", k === index);
    b.tabIndex = k === index ? 0 : -1;
  });
  openIndex = index;
  const me = openMenu(m.build({ filter: lastFilter }), { anchor: buttons[index], side: "below" }, {
    label: m.label,
    testid: `menu-${m.label.toLowerCase()}`,
    focusFirst: keyboard,
    keepOpenOn: [bar],
    onNavigate: (dir) => void openTop(index + dir, true),
    onClose: (reason) => {
      if (current !== me) return;
      current = null;
      openIndex = -1;
      buttons.forEach((b) => {
        b.setAttribute("aria-expanded", "false");
        b.classList.remove("open");
      });
      if (reason === "replaced") return;
      if (reason === "escape" && keyboard) buttons[index].focus();
      else context().grid.focus();
    },
  });
  current = me;
}

function buildBar(host: HTMLElement): void {
  bar = host;
  host.setAttribute("role", "menubar");
  host.setAttribute("aria-label", "Menu bar");
  buttons = MENUS.map((m, k) => {
    const b = document.createElement("button");
    b.className = "menubar-item";
    b.textContent = m.label;
    b.setAttribute("role", "menuitem");
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.dataset.testid = `menubar-${m.label.toLowerCase()}`;
    b.tabIndex = k === 0 ? 0 : -1;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      if (openIndex === k) {
        openToken++;
        closeMenus();
      }
      else void openTop(k, false);
    });
    b.addEventListener("mouseenter", () => {
      if (openIndex >= 0 && openIndex !== k) void openTop(k, false);
    });
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = buttons[(k + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
        buttons.forEach((x) => (x.tabIndex = -1));
        next.tabIndex = 0;
        next.focus();
      } else if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void openTop(k, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        context().grid.focus();
      }
    });
    return b;
  });
  host.replaceChildren(...buttons);
}

// ---------- keyboard ----------

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (t?.id === "title") return;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  const inDialog = !!t?.closest(".dialog");
  const take = (f: () => unknown) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenus();
    void f();
  };
  if (mod && !e.altKey && !e.shiftKey && k === "f") return take(() => openFind());
  if (mod && !e.altKey && !e.shiftKey && k === "h") return take(() => openReplace());
  if (inDialog) return;
  if (mod && !e.altKey && (k === "/" || e.code === "Slash")) return take(shortcutsDialog);
  if (e.altKey && !mod && (k === "/" || e.code === "Slash")) return take(searchMenus);
  // Alt+F (Chrome) or Alt+Shift+F (other browsers) opens a menu.
  if (e.altKey && !mod && !menuOpen()) {
    const letter = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : "";
    const i = MENUS.findIndex((m) => m.key === letter);
    if (i >= 0) return take(() => openTop(i, true));
  }
  // The rest act on the grid only.
  const onGrid = t === context().grid.input || t === document.body;
  if (!onGrid || context().grid.isEditing) return;
  if (mod && !e.altKey && (e.key === "\\" || e.code === "Backslash")) return take(clearFormatting);
  if (mod && !e.altKey && (e.key === "`" || e.code === "Backquote")) return take(toggleFormulas);
  if (mod && !e.altKey && !e.shiftKey && k === "k") return take(linkDialog);
  if (mod && e.altKey && !e.shiftKey && k === "r" && lastFilter) return take(removeFilter);
  // Alt+Shift+5 (strikethrough) is the toolbar's: it knows the cell's state and sends an explicit on/off.
  if (e.shiftKey && !mod && !e.altKey && e.key === "F11") return take(insertSheet);
  if (mod && e.altKey && (e.key === "=" || e.code === "Equal")) {
    const s = context().grid.selection;
    return take(() => insertRowsAbove(s));
  }
  if (mod && e.altKey && (e.key === "-" || e.code === "Minus")) {
    const s = context().grid.selection;
    return take(() => (s.c0 === 0 && s.c1 > 16000 ? deleteRows(s) : s.r0 === 0 && s.r1 > 1_000_000 ? deleteCols(s) : deleteCells("up")));
  }
}

// ---------- entry point ----------

export function initMenus(c: MenuContext): void {
  setContext(c);
  const host = document.getElementById("menubar");
  if (host) buildBar(host);
  document.addEventListener("keydown", onKey, true);
}
