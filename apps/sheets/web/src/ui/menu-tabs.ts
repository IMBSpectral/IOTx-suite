// Sheet tabs: click to switch, double-click to rename in place, right-click (or the ▾ on the
// active tab) for Google's tab menu, a coloured stripe for the tab colour, and the "All sheets"
// list (≡) that also reaches hidden sheets.
import type { Info } from "../engine/protocol";
import { activateSheet, context, runSheets } from "./menu-actions";
import { type MenuEntry, openMenu } from "./menu-popup";

const PALETTE = [
  ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff"],
  ["#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff"],
  ["#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc"],
  ["#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4", "#9fc5e8", "#b4a7d6", "#d5a6bd"],
  ["#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0"],
  ["#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#3d85c6", "#674ea7", "#a64d79"],
];

let renaming: number | null = null;
let lastInfo: Info | null = null;
let allButton: HTMLButtonElement | null = null;

const visibleCount = (i: Info) => i.sheets.filter((s) => !s.hidden).length;

function ensureAllSheetsButton(container: HTMLElement): void {
  if (allButton) return;
  const b = document.createElement("button");
  b.className = "all-sheets";
  b.textContent = "≡";
  b.title = "All sheets";
  b.setAttribute("aria-label", "All sheets");
  b.setAttribute("aria-haspopup", "menu");
  b.dataset.testid = "all-sheets";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    const i = lastInfo;
    if (!i) return;
    const entries: MenuEntry[] = i.sheets.map((s, idx) => ({
      label: s.name,
      icon: idx === i.active ? "✓" : "",
      hint: s.hidden ? "Hidden" : "",
      id: `all-sheets-${idx}`,
      run: async () => {
        if (s.hidden) await runSheets("sheet.unhide", { sheet: idx });
        await activateSheet(idx);
        context().grid.focus();
      },
    }));
    openMenu(entries, { anchor: b, side: "below" }, { testid: "all-sheets-menu", label: "All sheets", focusFirst: false, onClose: () => context().grid.focus() });
    // Open upward: the tab bar sits at the bottom of the window.
  });
  container.before(b);
  allButton = b;
}

/** Replaces main.ts's tab rendering. */
export function renderSheetTabs(container: HTMLElement, i: Info): void {
  lastInfo = i;
  ensureAllSheetsButton(container);
  if (renaming !== null) return; // don't tear down the rename box; re-rendered when it closes
  container.replaceChildren(...i.sheets.map((_, idx) => tab(container, i, idx)));
  container.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function tab(container: HTMLElement, i: Info, idx: number): HTMLElement {
  const s = i.sheets[idx];
  const b = document.createElement("button");
  b.className = "tab";
  b.role = "tab";
  b.hidden = s.hidden;
  b.setAttribute("aria-selected", String(idx === i.active));
  b.setAttribute("aria-label", s.name);
  b.dataset.testid = `tab-${idx}`;
  b.dataset.index = String(idx);
  if (s.color) {
    b.style.setProperty("--tab-color", s.color);
    b.classList.add("colored");
  }
  const name = document.createElement("span");
  name.className = "tab-name";
  name.textContent = s.name;
  b.append(name);
  if (idx === i.active) {
    const arrow = document.createElement("span");
    arrow.className = "tab-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.dataset.testid = "tab-arrow";
    arrow.textContent = "▾";
    arrow.addEventListener("click", (e) => {
      e.stopPropagation();
      tabMenu(idx, { anchor: b });
    });
    b.append(arrow);
  }
  b.onclick = async () => {
    if (renaming !== null) return;
    if (idx !== i.active) await activateSheet(idx);
    context().grid.focus();
  };
  b.addEventListener("dblclick", (e) => {
    e.preventDefault();
    startRename(container, idx);
  });
  b.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    if (idx !== lastInfo?.active) await activateSheet(idx);
    tabMenu(idx, at);
  });
  b.addEventListener("keydown", (e) => {
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      tabMenu(idx, { anchor: b });
    }
  });
  return b;
}

function tabMenu(idx: number, at: { x: number; y: number } | { anchor: HTMLElement }): void {
  const i = lastInfo;
  if (!i) return;
  const s = i.sheets[idx];
  const lone = visibleCount(i) <= 1;
  let prevVisible = -1;
  for (let k = idx - 1; k >= 0 && prevVisible < 0; k--) if (!i.sheets[k].hidden) prevVisible = k;
  const nextVisible = i.sheets.findIndex((x, k) => k > idx && !x.hidden);
  const container = document.getElementById("sheet-tabs") as HTMLElement;
  const entries: MenuEntry[] = [
    { label: "Delete", id: "tab-delete", disabled: lone, run: () => runSheets("home.deleteSheet", { sheet: idx }) },
    { label: "Duplicate", id: "tab-duplicate", run: () => duplicate(idx) },
    { label: "Rename", id: "tab-rename", run: () => startRename(container, idx) },
    {
      label: "Change color",
      id: "tab-color",
      submenu: () => [
        { label: "Reset", icon: "⊘", id: "tab-color-reset", run: () => runSheets("sheet.tabColor", { sheet: idx, color: "none" }) },
        { custom: (close) => palette(idx, s.color, close) },
      ],
    },
    { label: "Hide sheet", id: "tab-hide", disabled: lone, run: () => runSheets("sheet.hide", { sheet: idx }) },
    "-",
    { label: "Move right", id: "tab-move-right", disabled: nextVisible < 0, run: () => runSheets("sheet.move", { sheet: idx, to: nextVisible }) },
    { label: "Move left", id: "tab-move-left", disabled: prevVisible < 0, run: () => runSheets("sheet.move", { sheet: idx, to: prevVisible }) },
  ];
  const place = "anchor" in at ? { anchor: at.anchor, side: "below" as const } : at;
  openMenu(entries, place, { testid: "tab-menu", label: `${s.name} menu`, focusFirst: !("x" in at), onClose: () => context().grid.focus() });
}

function palette(idx: number, current: string | undefined, close: () => void): HTMLElement {
  const box = document.createElement("div");
  box.className = "palette";
  for (const row of PALETTE) {
    const r = document.createElement("div");
    r.className = "palette-row";
    for (const color of row) {
      const sw = document.createElement("button");
      sw.className = "swatch";
      sw.tabIndex = -1;
      sw.dataset.menuItem = "";
      sw.setAttribute("role", "menuitemradio");
      sw.setAttribute("aria-checked", String(current?.toLowerCase() === color));
      sw.setAttribute("aria-label", color);
      sw.dataset.testid = `swatch-${color.slice(1)}`;
      sw.style.background = color;
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        void runSheets("sheet.tabColor", { sheet: idx, color });
      });
      sw.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          sw.click();
        }
      });
      sw.addEventListener("mouseenter", () => sw.focus({ preventScroll: true }));
      r.append(sw);
    }
    box.append(r);
  }
  return box;
}

/** Duplicate: Google puts "Copy of <name>" right after the sheet and switches to it. */
async function duplicate(idx: number): Promise<void> {
  const i = lastInfo;
  if (!i) return;
  const name = i.sheets[idx].name;
  const { grid, engine } = context();
  if (!(await grid.run("sheet.move", { sheet: idx, to: idx + 1, copy: true }))) return;
  const after = await engine.info();
  const taken = new Set(after.sheets.map((s) => s.name.toLowerCase()));
  let want = `Copy of ${name}`;
  for (let k = 2; taken.has(want.toLowerCase()); k++) want = `Copy of ${name} ${k}`;
  if (want.length <= 31) await grid.run("sheet.rename", { sheet: idx + 1, name: want });
  await activateSheet(idx + 1);
  await context().refreshInfo();
  grid.focus();
}

function startRename(container: HTMLElement, idx: number): void {
  const b = container.querySelector<HTMLElement>(`.tab[data-index="${idx}"]`);
  const i = lastInfo;
  if (!b || !i || renaming !== null) return;
  renaming = idx;
  const old = i.sheets[idx].name;
  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = old;
  input.dataset.testid = "tab-rename";
  input.setAttribute("aria-label", "Sheet name");
  input.spellcheck = false;
  input.size = Math.max(4, old.length + 1);
  // An input can't live inside a <button>: swap the tab for a plain box while renaming.
  const box = document.createElement("div");
  box.className = `${b.className} renaming`;
  box.setAttribute("role", "tab");
  box.setAttribute("aria-selected", b.getAttribute("aria-selected") ?? "false");
  box.style.cssText = b.style.cssText;
  box.append(input);
  b.replaceWith(box);
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    renaming = null;
    const name = input.value.trim();
    if (save && name && name !== old) {
      await runSheets("sheet.rename", { sheet: idx, name });
    } else if (lastInfo) renderSheetTabs(container, lastInfo);
    // Errors (duplicate names, bad characters) come back from the engine via grid.run.
    if (lastInfo) renderSheetTabs(container, lastInfo);
    context().grid.focus();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener("input", () => (input.size = Math.max(4, input.value.length + 1)));
  input.addEventListener("blur", () => void finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  input.focus();
  input.select();
}
