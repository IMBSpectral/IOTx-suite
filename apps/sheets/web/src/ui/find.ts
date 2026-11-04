// Ctrl+F: the small "Find in sheet" box at the top right of the grid (highlights every match,
// Enter / Shift+Enter step through them, "n of m"). Ctrl+H: the Find and replace dialog.
import { a1 } from "../grid/axis";
import { activateSheet, context } from "./menu-actions";
import { check, div, type Dialog, field, openDialog, textInput } from "./menu-dialog";

const HEADER_W = 46;
const HEADER_H = 24;

interface Match {
  sheet: number;
  row: number;
  col: number;
}

interface Query {
  what: string;
  matchCase: boolean;
  wholeCell: boolean;
  formulas: boolean;
  within: "sheet" | "workbook";
}

function parseCell(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
  if (!m) return null;
  const col = [...m[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(m[2]) - 1, col };
}

/** Every match, in sheet order then row by row. */
async function search(q: Query): Promise<Match[]> {
  if (!q.what) return [];
  const { engine, info } = context();
  const r = await engine.execute("edit.find", {
    what: q.what,
    matchCase: q.matchCase,
    wholeCell: q.wholeCell,
    lookIn: q.formulas ? "formulas" : "values",
    all: true,
    within: q.within,
  });
  const res = (r.result ?? {}) as { results?: { cell: string; sheet: string | number }[] };
  const sheets = info()?.sheets ?? [];
  const active = info()?.active ?? 0;
  const out: Match[] = [];
  for (const x of res.results ?? []) {
    const cell = parseCell(x.cell);
    if (!cell) continue;
    const sheet = typeof x.sheet === "number" ? x.sheet : sheets.findIndex((s) => s.name === x.sheet);
    out.push({ sheet: sheet < 0 ? active : sheet, ...cell });
  }
  out.sort((a, b) => a.sheet - b.sheet || a.row - b.row || a.col - b.col);
  return out;
}

const cmp = (a: Match, b: Match) => a.sheet - b.sheet || a.row - b.row || a.col - b.col;
const here = (): Match => {
  const { grid, info } = context();
  return { sheet: info()?.active ?? 0, row: grid.active.row, col: grid.active.col };
};

/** Index of the next (dir 1) or previous (dir -1) match from the active cell, wrapping. */
function stepFrom(matches: Match[], dir: 1 | -1, inclusive: boolean): number {
  if (!matches.length) return -1;
  const cur = here();
  if (dir > 0) {
    const k = matches.findIndex((m) => (inclusive ? cmp(m, cur) >= 0 : cmp(m, cur) > 0));
    return k < 0 ? 0 : k;
  }
  for (let k = matches.length - 1; k >= 0; k--) if (cmp(matches[k], cur) < 0) return k;
  return matches.length - 1;
}

async function jump(m: Match): Promise<void> {
  const { grid, info } = context();
  if ((info()?.active ?? 0) !== m.sheet) await activateSheet(m.sheet);
  grid.select({ row: m.row, col: m.col }, false);
}

// ---------- highlights ----------

let overlay: HTMLDivElement | null = null;
let highlighted: Match[] = [];
let currentMatch: Match | null = null;
let scrollHooked = false;

function drawHighlights(): void {
  const host = document.getElementById("grid");
  if (!host) return;
  const scroller = host.querySelector<HTMLElement>(".grid-scroller");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "find-overlay";
    overlay.dataset.testid = "find-overlay";
    host.append(overlay);
  }
  if (scroller && !scrollHooked) {
    scrollHooked = true;
    scroller.addEventListener("scroll", () => requestAnimationFrame(drawHighlights), { passive: true });
    new ResizeObserver(() => drawHighlights()).observe(host);
  }
  const { grid, info } = context();
  const i = info();
  const active = i?.active ?? 0;
  const [fr, fc] = i?.freeze ?? [0, 0];
  const sl = scroller?.scrollLeft ?? 0;
  const st = scroller?.scrollTop ?? 0;
  const W = (scroller?.clientWidth ?? host.clientWidth) - HEADER_W;
  const H = (scroller?.clientHeight ?? host.clientHeight) - HEADER_H;
  overlay.style.width = `${Math.max(0, W)}px`;
  overlay.style.height = `${Math.max(0, H)}px`;
  const frozenW = grid.cols.offset(fc);
  const frozenH = grid.rows.offset(fr);
  const boxes: HTMLElement[] = [];
  for (const m of highlighted) {
    if (m.sheet !== active) continue;
    const w = grid.cols.size(m.col);
    const h = grid.rows.size(m.row);
    if (!w || !h) continue;
    const x = grid.cols.offset(m.col) - (m.col < fc ? 0 : sl);
    const y = grid.rows.offset(m.row) - (m.row < fr ? 0 : st);
    if (x + w < 0 || y + h < 0 || x > W || y > H) continue;
    if ((m.col >= fc && x < frozenW) || (m.row >= fr && y < frozenH)) continue; // under a frozen pane
    const b = document.createElement("div");
    const isCur = currentMatch && cmp(m, currentMatch) === 0;
    b.className = isCur ? "find-hit current" : "find-hit";
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    b.style.width = `${w}px`;
    b.style.height = `${h}px`;
    boxes.push(b);
    if (boxes.length > 1500) break;
  }
  overlay.replaceChildren(...boxes);
}

function setHighlights(matches: Match[], cur: Match | null): void {
  highlighted = matches;
  currentMatch = cur;
  drawHighlights();
}

// ---------- the find box (Ctrl+F) ----------

let box: HTMLDivElement | null = null;
let boxInput: HTMLInputElement;
let boxCount: HTMLSpanElement;
let boxMatches: Match[] = [];
let boxIndex = -1;
let boxRevision = -1;
let boxQuery = "";
let timer = 0;

function buildBox(): HTMLDivElement {
  const b = document.createElement("div");
  b.className = "find-box";
  b.setAttribute("role", "search");
  b.dataset.testid = "find-box";
  boxInput = document.createElement("input");
  boxInput.className = "find-input";
  boxInput.placeholder = "Find in sheet";
  boxInput.setAttribute("aria-label", "Find in sheet");
  boxInput.dataset.testid = "find-input";
  boxInput.spellcheck = false;
  boxCount = document.createElement("span");
  boxCount.className = "find-count";
  boxCount.dataset.testid = "find-count";
  boxCount.setAttribute("aria-live", "polite");
  const btn = (label: string, text: string, testid: string, f: () => void) => {
    const x = document.createElement("button");
    x.className = "find-btn";
    x.title = label;
    x.setAttribute("aria-label", label);
    x.textContent = text;
    x.dataset.testid = testid;
    x.addEventListener("mousedown", (e) => e.preventDefault());
    x.addEventListener("click", f);
    return x;
  };
  const sep = document.createElement("span");
  sep.className = "find-sep";
  b.append(
    boxInput,
    boxCount,
    sep,
    btn("Previous", "⌃", "find-prev", () => void step(-1)),
    btn("Next", "⌄", "find-next", () => void step(1)),
    btn("More options", "⋮", "find-more", () => {
      const q = boxInput.value;
      closeFind();
      openReplace(q);
    }),
    btn("Close", "✕", "find-close", () => closeFind(true)),
  );
  boxInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(true), 120);
  });
  boxInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind(true);
    }
  });
  return b;
}

/** Re-runs the search; `jumpFirst` moves to the first match at or after the active cell. */
async function refresh(jumpFirst: boolean): Promise<void> {
  const what = boxInput.value;
  boxQuery = what;
  boxRevision = context().info()?.revision ?? -1;
  const found = what ? await search({ what, matchCase: false, wholeCell: false, formulas: false, within: "sheet" }).catch(() => []) : [];
  if (boxInput.value !== what) return; // typed on
  boxMatches = found;
  boxIndex = jumpFirst && found.length ? stepFrom(found, 1, true) : -1;
  if (boxIndex >= 0) await jump(found[boxIndex]);
  showCount();
}

function showCount(): void {
  const n = boxMatches.length;
  boxCount.textContent = !boxQuery ? "" : n === 0 ? "0 of 0" : boxIndex < 0 ? `${n} found` : `${boxIndex + 1} of ${n}`;
  setHighlights(boxMatches, boxIndex >= 0 ? boxMatches[boxIndex] : null);
}

async function step(dir: 1 | -1): Promise<void> {
  if (boxInput.value !== boxQuery || (context().info()?.revision ?? -1) !== boxRevision) await refresh(false);
  if (!boxMatches.length) return showCount();
  const cur = boxIndex >= 0 ? boxMatches[boxIndex] : null;
  const at = here();
  if (cur && cmp(cur, at) === 0) boxIndex = (boxIndex + dir + boxMatches.length) % boxMatches.length;
  else boxIndex = stepFrom(boxMatches, dir, false);
  await jump(boxMatches[boxIndex]);
  showCount();
  boxInput.focus();
}

export function openFind(): void {
  const host = document.getElementById("grid");
  if (!host) return;
  replaceDialog?.close();
  if (!box) {
    box = buildBox();
    host.append(box);
  }
  box.hidden = false;
  boxInput.focus();
  boxInput.select();
  if (boxInput.value) void refresh(false);
}

export function closeFind(focusGrid = false): void {
  if (box) box.hidden = true;
  boxMatches = [];
  boxIndex = -1;
  setHighlights([], null);
  if (focusGrid) context().grid.focus();
}

// ---------- Find and replace (Ctrl+H) ----------

let replaceDialog: Dialog | null = null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function openReplace(initial?: string): void {
  if (replaceDialog) {
    replaceDialog.el.querySelector<HTMLInputElement>("[data-testid=replace-find]")?.focus();
    return;
  }
  if (box && !box.hidden) {
    initial ??= boxInput.value;
    closeFind();
  }
  const find = textInput(initial ?? "", "replace-find", "Find");
  const repl = textInput("", "replace-with", "Replace with");
  const within = document.createElement("select");
  within.className = "dlg-select";
  within.dataset.testid = "replace-within";
  within.setAttribute("aria-label", "Search");
  for (const [v, l] of [
    ["workbook", "All sheets"],
    ["sheet", "This sheet"],
  ]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    within.append(o);
  }
  const matchCase = check("Match case", false, "replace-case");
  const whole = check("Match entire cell contents", false, "replace-whole");
  const formulas = check("Also search within formulas", false, "replace-formulas");
  const status = div("dlg-status");
  status.dataset.testid = "replace-status";
  status.setAttribute("aria-live", "polite");
  const body = div(
    "dlg-grid",
    field("Find", find),
    field("Replace with", repl),
    field("Search", within),
    div("dlg-checks", matchCase.el, whole.el, formulas.el),
    status,
  );

  let matches: Match[] = [];
  let key = "";
  let index = -1;
  const query = (): Query => ({
    what: find.value,
    matchCase: matchCase.input.checked,
    wholeCell: whole.input.checked,
    formulas: formulas.input.checked,
    within: within.value as "sheet" | "workbook",
  });
  const fresh = async () => {
    const q = query();
    const k = JSON.stringify(q) + (context().info()?.revision ?? 0);
    if (k !== key) {
      matches = await search(q).catch(() => []);
      key = k;
      index = -1;
    }
    return q;
  };
  const say = (t: string) => (status.textContent = t);

  const doFind = async (): Promise<Match | null> => {
    const q = await fresh();
    if (!q.what) return null;
    if (!matches.length) {
      say(`No results found for "${q.what}"`);
      setHighlights([], null);
      return null;
    }
    const cur = index >= 0 ? matches[index] : null;
    const next = cur && cmp(cur, here()) === 0 ? (index + 1) % matches.length : stepFrom(matches, 1, false);
    const looped = index >= 0 && next <= index;
    index = next;
    await jump(matches[index]);
    setHighlights(matches, matches[index]);
    say(looped ? "No other results found, looping around" : `${index + 1} of ${matches.length}`);
    return matches[index];
  };

  const doReplace = async () => {
    const q = await fresh();
    if (!q.what) return;
    const cur = index >= 0 ? matches[index] : null;
    if (!cur || cmp(cur, here()) !== 0) {
      await doFind();
      return;
    }
    const { engine, grid } = context();
    const text = await engine.editText(cur.row, cur.col);
    let next = text;
    if (text.startsWith("=") && !q.formulas) next = text;
    else if (q.wholeCell) next = repl.value;
    else next = text.replace(new RegExp(escapeRe(q.what), q.matchCase ? "g" : "gi"), () => repl.value);
    if (next !== text) await grid.run("cell.set", { cell: a1(cur.row, cur.col), input: next });
    key = ""; // the matches changed
    await fresh();
    if (!matches.length) {
      setHighlights([], null);
      say(`Replaced 1 instance of ${q.what} with ${repl.value}`);
      return;
    }
    // Continue from the replaced cell.
    index = -1;
    await doFind();
  };

  const doReplaceAll = async () => {
    const q = query();
    if (!q.what) return;
    const { engine, grid } = context();
    try {
      const r = await engine.execute("edit.replace", { what: q.what, with: repl.value, matchCase: q.matchCase, wholeCell: q.wholeCell, all: true, within: q.within });
      grid.markChanged(r.revision);
      const n = (r.result as { replaced?: number } | null)?.replaced ?? 0;
      say(n ? `Replaced ${n} instance${n === 1 ? "" : "s"} of ${q.what} with ${repl.value}` : `No results found for "${q.what}"`);
      key = "";
      matches = [];
      setHighlights([], null);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };

  replaceDialog = openDialog({
    title: "Find and replace",
    body,
    modeless: true,
    width: 440,
    testid: "replace-dialog",
    onClose: () => {
      replaceDialog = null;
      setHighlights([], null);
      context().grid.focus();
    },
    buttons: [
      {
        label: "Find",
        id: "replace-find-btn",
        run: async () => {
          await doFind();
          return false;
        },
      },
      {
        label: "Replace",
        id: "replace-one-btn",
        run: async () => {
          await doReplace();
          return false;
        },
      },
      {
        label: "Replace all",
        id: "replace-all-btn",
        run: async () => {
          await doReplaceAll();
          return false;
        },
      },
      { label: "Done", primary: true, id: "replace-done" },
    ],
  });
  // Enter in the Find box finds (rather than closing via the primary button).
  find.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      void doFind();
    }
  });
  find.focus();
  find.select();
}

