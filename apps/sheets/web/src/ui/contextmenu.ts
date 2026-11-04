// Right-click menus on the grid: the cell menu, the column-header menu and the row-header menu,
// with Google's labels ("Insert 1 row above", "Delete columns B - D", "Resize column").
import { colName } from "../grid/axis";
import {
  clearContents,
  clipboard,
  colSpan,
  colsLabel,
  context,
  createFilter,
  deleteCells,
  deleteCols,
  deleteRows,
  filterRange,
  hiddenNear,
  hideCols,
  hideRows,
  insertCells,
  insertColsLeft,
  insertColsRight,
  insertRowsAbove,
  insertRowsBelow,
  isWholeCols,
  isWholeRows,
  linkDialog,
  paste,
  pasteSpecialMenu,
  plural,
  removeFilter,
  resizeDialog,
  rowSpan,
  rowsLabel,
  sortSheet,
  unhide,
} from "./menu-actions";
import { type MenuEntry, openMenu } from "./menu-popup";

const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const key = (s: string) => (mac ? s.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : s);

function clipboardItems(): MenuEntry[] {
  return [
    { label: "Cut", icon: "✂", shortcut: key("Ctrl+X"), id: "ctx-cut", run: () => clipboard("cut") },
    { label: "Copy", icon: "⧉", shortcut: key("Ctrl+C"), id: "ctx-copy", run: () => clipboard("copy") },
    { label: "Paste", icon: "📋", shortcut: key("Ctrl+V"), id: "ctx-paste", run: paste },
    { label: "Paste special", icon: "📋", submenu: pasteSpecialMenu },
  ];
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Called by the grid on right-click (row/col -1 = a column/row header). */
export async function showGridMenu(at: { x: number; y: number; row: number; col: number }): Promise<void> {
  const { grid } = context();
  const s = grid.selection;
  const [filter, hidCols, hidRows] = await Promise.all([
    filterRange().catch(() => null),
    isWholeCols(s) ? hiddenNear("col", s).catch(() => null) : Promise.resolve(null),
    isWholeRows(s) ? hiddenNear("row", s).catch(() => null) : Promise.resolve(null),
  ]);
  const n = rowSpan(s);
  const m = colSpan(s);
  let entries: MenuEntry[];
  let testid: string;
  const filterItem: MenuEntry = filter
    ? { label: "Remove filter", icon: "⏷", id: "ctx-filter", run: removeFilter }
    : { label: "Create a filter", icon: "⏷", id: "ctx-filter", run: createFilter };

  if (isWholeCols(s) && !isWholeRows(s)) {
    // Column header.
    testid = "col-menu";
    const noun = colsLabel(s);
    entries = [
      ...clipboardItems(),
      "-",
      { label: `Insert ${plural(m, "column", "columns")} left`, icon: "+", id: "ctx-insert-cols-left", run: () => insertColsLeft(s) },
      { label: `Insert ${plural(m, "column", "columns")} right`, icon: "+", id: "ctx-insert-cols-right", run: () => insertColsRight(s) },
      { label: `Delete ${noun}`, icon: "🗑", id: "ctx-delete-cols", run: () => deleteCols(s) },
      { label: `Clear ${noun}`, icon: "✕", id: "ctx-clear-cols", run: clearContents },
      { label: `Hide ${noun}`, icon: "◌", id: "ctx-hide-cols", run: () => hideCols(s) },
      ...(hidCols
        ? [{ label: `Unhide ${hidCols[0] === hidCols[1] ? "column" : "columns"}`, icon: "◉", id: "ctx-unhide-cols", run: () => unhide("col", hidCols) }]
        : []),
      { label: `Resize ${noun}`, icon: "↔", id: "ctx-resize-cols", run: () => resizeDialog("col", s) },
      "-",
      filterItem,
      "-",
      { label: "Sort sheet A to Z", icon: "⇅", id: "ctx-sort-asc", run: () => sortSheet(s.c0, false) },
      { label: "Sort sheet Z to A", icon: "⇅", id: "ctx-sort-desc", run: () => sortSheet(s.c0, true) },
    ];
  } else if (isWholeRows(s) && !isWholeCols(s)) {
    // Row header.
    testid = "row-menu";
    const noun = rowsLabel(s);
    entries = [
      ...clipboardItems(),
      "-",
      { label: `Insert ${plural(n, "row", "rows")} above`, icon: "+", id: "ctx-insert-rows-above", run: () => insertRowsAbove(s) },
      { label: `Insert ${plural(n, "row", "rows")} below`, icon: "+", id: "ctx-insert-rows-below", run: () => insertRowsBelow(s) },
      { label: `Delete ${noun}`, icon: "🗑", id: "ctx-delete-rows", run: () => deleteRows(s) },
      { label: `Clear ${noun}`, icon: "✕", id: "ctx-clear-rows", run: clearContents },
      { label: `Hide ${noun}`, icon: "◌", id: "ctx-hide-rows", run: () => hideRows(s) },
      ...(hidRows ? [{ label: `Unhide ${hidRows[0] === hidRows[1] ? "row" : "rows"}`, icon: "◉", id: "ctx-unhide-rows", run: () => unhide("row", hidRows) }] : []),
      { label: `Resize ${noun}`, icon: "↕", id: "ctx-resize-rows", run: () => resizeDialog("row", s) },
    ];
  } else {
    // A cell or range.
    testid = "cell-menu";
    entries = [
      ...clipboardItems(),
      "-",
      { label: `Insert ${plural(n, "row", "rows")} above`, icon: "+", id: "ctx-insert-rows-above", run: () => insertRowsAbove(s) },
      { label: `Insert ${plural(n, "row", "rows")} below`, icon: "+", id: "ctx-insert-rows-below", run: () => insertRowsBelow(s) },
      { label: `Insert ${plural(m, "column", "columns")} left`, icon: "+", id: "ctx-insert-cols-left", run: () => insertColsLeft(s) },
      { label: `Insert ${plural(m, "column", "columns")} right`, icon: "+", id: "ctx-insert-cols-right", run: () => insertColsRight(s) },
      {
        label: "Insert cells",
        icon: "+",
        submenu: () => [
          { label: "Shift right", id: "ctx-insert-cells-right", run: () => insertCells("right") },
          { label: "Shift down", id: "ctx-insert-cells-down", run: () => insertCells("down") },
        ],
      },
      "-",
      { label: `Delete ${n === 1 ? "row" : `rows ${s.r0 + 1} - ${s.r1 + 1}`}`, icon: "🗑", id: "ctx-delete-rows", run: () => deleteRows(s) },
      { label: `Delete ${m === 1 ? "column" : `columns ${colName(s.c0)} - ${colName(s.c1)}`}`, icon: "🗑", id: "ctx-delete-cols", run: () => deleteCols(s) },
      {
        label: "Delete cells",
        icon: "🗑",
        submenu: () => [
          { label: "Shift left", id: "ctx-delete-cells-left", run: () => deleteCells("left") },
          { label: "Shift up", id: "ctx-delete-cells-up", run: () => deleteCells("up") },
        ],
      },
      "-",
      filterItem,
      "-",
      { label: "Insert link", icon: "🔗", shortcut: key("Ctrl+K"), id: "ctx-link", run: linkDialog },
      "-",
      { label: "Clear", icon: "✕", hint: "Delete", id: "ctx-clear", run: clearContents },
    ];
  }
  openMenu(entries, { x: at.x, y: at.y }, {
    testid,
    label: cap(testid.replace("-", " ")),
    focusFirst: false,
    onClose: () => grid.focus(),
  });
}
