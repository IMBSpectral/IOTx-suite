// The formatting toolbar, laid out like Google Sheets': undo, paint format, number formats,
// font, size, emphasis, colours, borders, merge, alignment, wrapping, rotation, link, clear.
// Every button runs an engine command on the grid's own selection (an explicit `range`: the
// engine's selection is not shared in collaboration), and the toolbar reflects the active cell.
import "./toolbar.css";
import type { EngineClient } from "../engine/client";
import type { ViewStyle } from "../engine/protocol";
import { a1, type Range, rangeA1 } from "../grid/axis";
import type { Grid } from "../grid/grid";

export interface Toolbar {
  /** Re-reads the active cell's format (call on selection changes and edits). Debounced. */
  refresh(): void;
}

const DEFAULT_FONT = "Calibri";
const DEFAULT_SIZE = 11;

// ---------------------------------------------------------------- icons

const svg = (body: string, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false">${body}</svg>`;
const p = (d: string) => `<path d="${d}"/>`;

const ICON = {
  undo: p("M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"),
  redo: p("M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z"),
  paint: p("M18 4V3c0-.55-.45-1-1-1H5c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h12c.55 0 1-.45 1-1V6h1v4H9v11c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-9h8V4h-3z"),
  decDecimal:
    `<text x="12" y="12" text-anchor="middle" font-size="11" font-family="Arial, sans-serif" font-weight="bold">.0</text>` +
    p("M9 14.75 5.5 17.5 9 20.25V18.3h9.5v-1.6H9z"),
  incDecimal:
    `<text x="12" y="12" text-anchor="middle" font-size="11" font-family="Arial, sans-serif" font-weight="bold">.00</text>` +
    p("M15 14.75l3.5 2.75-3.5 2.75V18.3H5.5v-1.6H15z"),
  minus: p("M19 13H5v-2h14v2z"),
  plus: p("M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"),
  bold: p("M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z"),
  italic: p("M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z"),
  strike:
    p("M3 11h18v2H3z") +
    p("M12.2 4c-2.7 0-4.7 1.45-4.7 3.6 0 .93.33 1.74 1 2.4h3.9c-1.5-.48-2.3-1.04-2.3-2.15 0-1.02.95-1.75 2.25-1.75 1.45 0 2.3.78 2.4 2h2.4C17.05 5.6 15.05 4 12.2 4zM14.6 14c.33.36.5.77.5 1.3 0 1.1-1.05 1.85-2.6 1.85-1.75 0-2.75-.85-2.85-2.35H7.2c.1 2.75 2.2 4.2 5.3 4.2 3.05 0 5.05-1.5 5.05-3.9 0-.4-.05-.77-.15-1.1h-2.8z"),
  textColor: p("M5.5 17h2.25l1.12-3h6.25l1.12 3h2.25L13 4h-2L5.5 17zm4.12-5L12 5.67 14.38 12H9.62z"),
  fill: p("M16.56 8.94 7.62 0 6.21 1.41l2.38 2.38-5.15 5.15c-.59.59-.59 1.54 0 2.12l5.5 5.5c.29.29.68.44 1.06.44s.77-.15 1.06-.44l5.5-5.5c.59-.58.59-1.53 0-2.12zM5.21 10 10 5.21 14.79 10H5.21zM19 11.5s-2 2.17-2 3.5c0 1.1.9 2 2 2s2-.9 2-2c0-1.33-2-3.5-2-3.5z"),
  borders: p("M3 3v18h18V3H3zm8 16H5v-6h6v6zm0-8H5V5h6v6zm8 8h-6v-6h6v6zm0-8h-6V5h6v6z"),
  merge: p("M3 4h2v16H3zM19 4h2v16h-2zM6.5 11H10V8.5l3 3.5-3 3.5V13H6.5zM17.5 13H14v2.5L11 12l3-3.5V11h3.5z"),
  alignLeft: p("M15 15H3v2h12v-2zm0-8H3v2h12V7zM3 13h18v-2H3v2zm0 8h18v-2H3v2zM3 3v2h18V3H3z"),
  alignCenter: p("M7 15v2h10v-2H7zm-4 6h18v-2H3v2zm0-8h18v-2H3v2zm4-6v2h10V7H7zM3 3v2h18V3H3z"),
  alignRight: p("M3 21h18v-2H3v2zm6-4h12v-2H9v2zm-6-4h18v-2H3v2zm6-4h12V7H9v2zM3 3v2h18V3H3z"),
  alignTop: p("M8 11h3v10h2V11h3l-4-4-4 4zM4 3v2h16V3H4z"),
  alignMiddle: p("M8 19h3v4h2v-4h3l-4-4-4 4zm8-14h-3V1h-2v4H8l4 4 4-4zM4 11v2h16v-2H4z"),
  alignBottom: p("M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z"),
  overflow: p("M13 3h2v5h-2zM13 16h2v5h-2zM3 11h14V8l4 4-4 4v-3H3z"),
  wrap: p("M4 19h6v-2H4v2zM20 5H4v2h16V5zm-3 6H4v2h13.25c1.1 0 2 .9 2 2s-.9 2-2 2H15v-2l-3 3 3 3v-2h2c2.21 0 4-1.79 4-4s-1.79-4-4-4z"),
  clip: p("M18 3h2v18h-2zM3 11h9V8l4 4-4 4v-3H3z"),
  link: p("M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"),
  clear: p("M3.27 5 2 6.27l6.97 6.97L6.5 19h3l1.57-3.66L16.73 21 18 19.73 3.55 5.27 3.27 5zM6 5v.18L8.82 8h2.4l-.72 1.68 2.1 2.1L14.21 8H20V5H6z"),
  caret: p("M7 10l5 5 5-5z"),
  check: p("M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"),
  pencil: p("M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"),
  reset: p("M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"),
};

/** A text-rotation icon: "ab" on a baseline arrow, turned by `angle` (or stacked letters). */
function rotationIcon(angle: number | "vertical"): string {
  if (angle === "vertical") {
    return (
      `<text x="9" y="10" text-anchor="middle" font-size="9" font-family="Arial, sans-serif" font-weight="bold">a</text>` +
      `<text x="9" y="19" text-anchor="middle" font-size="9" font-family="Arial, sans-serif" font-weight="bold">b</text>` +
      p("M16 4h1.6v13H20l-3.2 4-3.2-4H16z")
    );
  }
  return (
    `<g transform="rotate(${-angle} 12 12)">` +
    `<text x="12" y="13" text-anchor="middle" font-size="10" font-family="Arial, sans-serif" font-weight="bold">ab</text>` +
    p("M4 16.2h13v-1.7l3 2.5-3 2.5v-1.7H4z") +
    `</g>`
  );
}

type Edge = "top" | "midH" | "bottom" | "left" | "midV" | "right";

/** A 3x3 cell diagram: every grid line dotted, the edges `on` solid (as Google's border menu). */
function borderIcon(on: Edge[]): string {
  const lines: Record<Edge, [number, number, number, number]> = {
    top: [4, 4, 20, 4],
    midH: [4, 12, 20, 12],
    bottom: [4, 20, 20, 20],
    left: [4, 4, 4, 20],
    midV: [12, 4, 12, 20],
    right: [20, 4, 20, 20],
  };
  return (Object.keys(lines) as Edge[])
    .map((k) => {
      const [x1, y1, x2, y2] = lines[k];
      const solid = on.includes(k);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="${solid ? 2 : 1}" ${
        solid ? 'stroke-linecap="square"' : 'stroke-dasharray="1 2" opacity="0.6"'
      }/>`;
    })
    .join("");
}

// ---------------------------------------------------------------- data

/** Google Sheets' standard palette: names and colours, row by row. */
const BASE_NAMES = ["red berry", "red", "orange", "yellow", "green", "cyan", "cornflower blue", "blue", "purple", "magenta"];
const GRAYS: [string, string][] = [
  ["black", "#000000"],
  ["dark gray 4", "#434343"],
  ["dark gray 3", "#666666"],
  ["dark gray 2", "#999999"],
  ["dark gray 1", "#b7b7b7"],
  ["gray", "#cccccc"],
  ["light gray 1", "#d9d9d9"],
  ["light gray 2", "#efefef"],
  ["light gray 3", "#f3f3f3"],
  ["white", "#ffffff"],
];
const TINTS: [string, string[]][] = [
  ["", ["#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff"]],
  ["light # 3", ["#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc"]],
  ["light # 2", ["#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4", "#9fc5e8", "#b4a7d6", "#d5a6bd"]],
  ["light # 1", ["#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0"]],
  ["dark # 1", ["#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#3d85c6", "#674ea7", "#a64d79"]],
  ["dark # 2", ["#85200c", "#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#1155cc", "#0b5394", "#351c75", "#741b47"]],
  ["dark # 3", ["#5b0f00", "#660000", "#783f04", "#7f6000", "#274e13", "#0c343d", "#1c4587", "#073763", "#20124d", "#4c1130"]],
];
const PALETTE: [string, string][][] = [
  GRAYS,
  ...TINTS.map(([pattern, colors]) =>
    colors.map((c, i): [string, string] => [pattern ? pattern.replace("#", BASE_NAMES[i]) : BASE_NAMES[i], c]),
  ),
];

const FONTS = [
  "Arial",
  "Calibri",
  "Cambria",
  "Comic Sans MS",
  "Consolas",
  "Courier New",
  "Georgia",
  "Impact",
  "Roboto",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];

/** The "123" menu: label, format code, sample (as Google shows them). `null` = separator. */
const FORMATS: ([string, string, string] | null)[] = [
  ["Automatic", "General", ""],
  ["Plain text", "@", ""],
  null,
  ["Number", "#,##0.00", "1,000.12"],
  ["Percent", "0.00%", "10.12%"],
  ["Scientific", "0.00E+00", "1.01E+03"],
  null,
  ["Accounting", "Accounting", "$ (1,000.12)"],
  ["Financial", "#,##0.00;(#,##0.00)", "(1,000.12)"],
  ["Currency", "$#,##0.00", "$1,000.12"],
  ["Currency rounded", "$#,##0", "$1,000"],
  null,
  ["Date", "m/d/yyyy", "9/26/2008"],
  ["Time", "h:mm:ss AM/PM", "3:59:00 PM"],
  ["Date time", "m/d/yyyy h:mm:ss", "9/26/2008 15:59:00"],
  ["Duration", "[h]:mm:ss", "24:01:00"],
];

const BORDER_PRESETS: [string, string, Edge[]][] = [
  ["All borders", "all", ["top", "midH", "bottom", "left", "midV", "right"]],
  ["Inner borders", "inside", ["midH", "midV"]],
  ["Horizontal borders", "insideHorizontal", ["midH"]],
  ["Vertical borders", "insideVertical", ["midV"]],
  ["Outer borders", "outside", ["top", "bottom", "left", "right"]],
  ["Left border", "left", ["left"]],
  ["Top border", "top", ["top"]],
  ["Right border", "right", ["right"]],
  ["Bottom border", "bottom", ["bottom"]],
  ["Clear borders", "none", []],
];

const BORDER_STYLES: [string, string][] = [
  ["Thin", "thin"],
  ["Medium", "medium"],
  ["Thick", "thick"],
  ["Dashed", "dashed"],
  ["Dotted", "dotted"],
  ["Double", "double"],
];

/**
 * Adds or removes one decimal place in a number format code (the engine's own rule, run here
 * so the result does not depend on the engine's selection, which collaboration doesn't share).
 * `display` is the cell's shown text, used to count decimals under General.
 */
export function adjustDecimals(code: string, display: string, delta: number): string {
  if (!code || code.toLowerCase() === "general") {
    const m = /^[^eE]*?\.(\d+)/.exec(display.trim());
    const n = Math.max(0, (m ? m[1].length : 0) + delta);
    return n === 0 ? "0" : `0.${"0".repeat(n)}`;
  }
  return code
    .split(";")
    .map((sec) => {
      const chars = [...sec];
      let inQuote = false;
      let inBracket = false;
      let last = -1;
      let point = -1;
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (c === '"') inQuote = !inQuote;
        if (c === "[" && !inQuote) inBracket = true;
        if (c === "]" && !inQuote) {
          inBracket = false;
          continue;
        }
        if (inQuote || inBracket) continue;
        if (c === "0" || c === "#" || c === "?") last = i;
        if (c === "." && point < 0) point = i;
        if (c === "E" || c === "e") break;
      }
      if (last < 0) return sec;
      const out = [...chars];
      if (delta > 0) {
        if (point >= 0) out.splice(last + 1, 0, "0");
        else out.splice(last + 1, 0, ".", "0");
      } else if (point >= 0 && last > point) {
        out.splice(last, 1);
        if (last === point + 1) out.splice(point, 1);
      }
      return out.join("");
    })
    .join(";");
}

// ---------------------------------------------------------------- DOM helpers

type Attrs = Record<string, string | boolean | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "html") e.innerHTML = String(v);
    else if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids);
  return e;
}

/** Keeps keyboard focus in the grid when a button is pressed with the mouse. */
function noFocus(e: Element): void {
  e.addEventListener("mousedown", (ev) => ev.preventDefault());
}

// ---------------------------------------------------------------- toolbar

interface Active {
  style: ViewStyle;
  merged: boolean;
  text: string;
}

export function initToolbar(root: HTMLElement, grid: Grid, engine: EngineClient): Toolbar {
  root.replaceChildren();
  root.setAttribute("role", "toolbar");
  const gridHost = document.getElementById("grid") ?? document.body;

  // -------- state

  let state: Active = { style: { size: DEFAULT_SIZE }, merged: false, text: "" };
  let canUndo = false;
  let canRedo = false;
  let painter: "off" | "once" | "sticky" = "off";
  let borderStyle = "thin";
  let borderColor = "#000000";

  const sel = (): Range => grid.selection;
  const range = () => rangeA1(sel());
  /** The cell the toolbar describes: the selection's first cell. */
  const first = () => ({ row: sel().r0, col: sel().c0 });

  async function readActive(): Promise<Active> {
    const { row, col } = first();
    const vp = await engine.viewport(row, col, row, col);
    const cell = vp.cells.find((c) => c[0] === row && c[1] === col) ?? vp.cells[0];
    const style = (cell && vp.styles[String(cell[4])]) || { size: DEFAULT_SIZE };
    const merged = vp.merges.some(([r0, c0, r1, c1]) => row >= r0 && row <= r1 && col >= c0 && col <= c1 && (r1 > r0 || c1 > c0));
    return { style, merged, text: cell?.[2] ?? "" };
  }

  /** Runs one engine command (committing an open edit first) and gives focus back to the grid. */
  async function run(id: string, params: unknown = {}): Promise<boolean> {
    if (grid.isEditing) await grid.commit();
    const ok = await grid.run(id, params);
    grid.focus();
    return ok;
  }

  /** A command on the selection; `extra` may depend on the active cell's current format. */
  async function onRange(id: string, extra: Record<string, unknown> | ((a: Active) => Record<string, unknown>) = {}): Promise<boolean> {
    if (grid.isEditing) await grid.commit();
    const params = typeof extra === "function" ? extra(await readActive()) : extra;
    return run(id, { range: range(), ...params });
  }

  // -------- popovers

  let pop: { el: HTMLElement; anchor: HTMLElement } | null = null;

  function closePopover(refocus = true): void {
    if (!pop) return;
    pop.el.remove();
    pop.anchor.setAttribute("aria-expanded", "false");
    pop = null;
    if (refocus) grid.focus();
  }

  function openPopover(anchor: HTMLElement, content: HTMLElement, label: string): HTMLElement {
    closePopover(false);
    const box = el("div", { class: "tb-popover", role: "menu", "aria-label": label, "data-testid": "toolbar-popover" }, content);
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8));
    box.style.left = `${left}px`;
    box.style.top = `${r.bottom + 4}px`;
    anchor.setAttribute("aria-expanded", "true");
    pop = { el: box, anchor };
    return box;
  }

  function togglePopover(anchor: HTMLElement, build: () => HTMLElement, label: string): void {
    if (pop?.anchor === anchor) closePopover();
    else openPopover(anchor, build(), label);
  }

  // pointerdown, not mousedown: the grid cancels pointerdown, which suppresses the mouse events.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!pop) return;
      const t = e.target as Node;
      if (pop.el.contains(t) || pop.anchor.contains(t)) return;
      closePopover(false);
    },
    true,
  );
  window.addEventListener("resize", () => closePopover(false));
  root.addEventListener("scroll", () => closePopover(false));
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (pop) {
        e.preventDefault();
        e.stopPropagation();
        closePopover();
        render();
      } else if (painter !== "off") {
        e.preventDefault();
        e.stopPropagation();
        setPainter("off");
      }
    },
    true,
  );

  /** A menu row: optional check mark or icon, label, optional hint on the right. */
  function menuItem(label: string, pick: () => void, opts: { checked?: boolean; icon?: string; hint?: string; style?: string } = {}) {
    const b = el(
      "button",
      { type: "button", class: "tb-item", role: "menuitemcheckbox", "aria-checked": String(!!opts.checked), "aria-label": label },
      el("span", { class: "tb-item-check", html: opts.checked ? svg(ICON.check, 18) : opts.icon ? svg(opts.icon, 18) : "" }),
      el("span", { class: "tb-item-label", ...(opts.style ? { style: opts.style } : {}) }, label),
      el("span", { class: "tb-item-hint" }, opts.hint ?? ""),
    );
    noFocus(b);
    b.addEventListener("click", () => {
      closePopover(false);
      pick();
    });
    return b;
  }

  /** A square icon button inside a popover (alignment, rotation, border presets). */
  function iconChoice(label: string, icon: string, pick: () => void, pressed = false) {
    const b = el("button", { type: "button", class: "tb-choice", role: "menuitem", title: label, "aria-label": label, "aria-pressed": String(pressed), html: svg(icon) });
    noFocus(b);
    b.addEventListener("click", () => {
      closePopover(false);
      pick();
    });
    return b;
  }

  // -------- toolbar controls

  const groups: HTMLElement[] = [];
  let group: HTMLElement = el("div", { class: "tb-group" });
  const sep = () => {
    groups.push(group);
    group = el("div", { class: "tb-group" });
  };
  const add = <T extends HTMLElement>(e: T): T => {
    group.append(e);
    return e;
  };

  function button(label: string, title: string, icon: string, onClick: () => void, opts: { toggle?: boolean; cls?: string; text?: string } = {}) {
    const b = el("button", {
      type: "button",
      class: `tb-btn ${opts.cls ?? ""}`.trim(),
      title,
      "aria-label": label,
      "aria-pressed": opts.toggle ? "false" : undefined,
      html: opts.text !== undefined ? `<span class="tb-text">${opts.text}</span>` : svg(icon),
    });
    noFocus(b);
    b.addEventListener("click", onClick);
    return add(b);
  }

  /** A button that opens a popover: its icon (or text) and a small caret. */
  function dropdown(label: string, title: string, body: string, build: () => HTMLElement, cls = "") {
    const b = el("button", {
      type: "button",
      class: `tb-btn tb-drop ${cls}`.trim(),
      title,
      "aria-label": label,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      html: `<span class="tb-drop-body">${body}</span>${svg(ICON.caret, 18)}`,
    });
    noFocus(b);
    b.addEventListener("click", () => togglePopover(b, build, label));
    return add(b);
  }
  const setBody = (b: HTMLElement, body: string) => {
    const s = b.querySelector(".tb-drop-body");
    if (s && s.innerHTML !== body) s.innerHTML = body;
  };

  // Undo, redo, paint format.
  const undo = button("Undo", "Undo (Ctrl+Z)", ICON.undo, () => void run("edit.undo"));
  const redo = button("Redo", "Redo (Ctrl+Y)", ICON.redo, () => void run("edit.redo"));
  const paint = button("Paint format", "Paint format (double-click to keep painting)", ICON.paint, () => {
    if (painter !== "off") setPainter("off");
    else void pickUp(false);
  }, { toggle: true });
  paint.addEventListener("dblclick", () => void pickUp(true));
  sep();

  // Number formats.
  button("Format as currency", "Format as currency", "", () => void onRange("home.numberFormat", { code: "$#,##0.00" }), { text: "$", cls: "tb-glyph" });
  button("Format as percent", "Format as percent", "", () => void onRange("home.numberFormat", { code: "0.00%" }), { text: "%", cls: "tb-glyph" });
  button("Decrease decimal places", "Decrease decimal places", ICON.decDecimal, () =>
    void onRange("home.numberFormat", (a) => ({ code: adjustDecimals(a.style.fmt ?? "General", a.text, -1) })),
  );
  button("Increase decimal places", "Increase decimal places", ICON.incDecimal, () =>
    void onRange("home.numberFormat", (a) => ({ code: adjustDecimals(a.style.fmt ?? "General", a.text, 1) })),
  );
  dropdown("More formats", "More formats", `<span class="tb-text tb-123">123</span>`, buildFormats);
  sep();

  // Font family.
  const font = dropdown("Font", "Font", `<span class="tb-font-name" data-testid="toolbar-font">Default (${DEFAULT_FONT})</span>`, buildFonts, "tb-font");
  sep();

  // Font size: − [11] +.
  button("Decrease font size", "Decrease font size", ICON.minus, () =>
    void onRange("home.fontSize", (a) => ({ size: Math.max(1, Math.ceil(a.style.size) - 1) })),
  );
  const size = add(
    el("input", {
      class: "tb-size",
      type: "text",
      inputmode: "decimal",
      "aria-label": "Font size",
      title: "Font size",
      "data-testid": "toolbar-size",
      value: String(DEFAULT_SIZE),
      autocomplete: "off",
    }),
  );
  button("Increase font size", "Increase font size", ICON.plus, () =>
    void onRange("home.fontSize", (a) => ({ size: Math.min(409, Math.floor(a.style.size) + 1) })),
  );
  size.addEventListener("focus", () => {
    size.select();
    if (pop?.anchor !== size) openPopover(size, buildSizes(), "Font size");
  });
  size.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const n = Number(size.value);
      closePopover(false);
      if (Number.isFinite(n) && n >= 1 && n <= 409) void onRange("home.fontSize", { size: n });
      else {
        size.value = String(state.style.size);
        grid.focus();
      }
    } else if (e.key === "Escape") {
      size.value = String(state.style.size);
      grid.focus();
    }
  });
  size.addEventListener("blur", () => {
    size.value = String(state.style.size);
    if (pop?.anchor === size) closePopover(false);
  });
  sep();

  // Bold, italic, strikethrough, text colour.
  const bold = button("Bold", "Bold (Ctrl+B)", ICON.bold, () => void onRange("home.bold", (a) => ({ on: !a.style.b })), { toggle: true });
  const italic = button("Italic", "Italic (Ctrl+I)", ICON.italic, () => void onRange("home.italic", (a) => ({ on: !a.style.i })), { toggle: true });
  const strike = button("Strikethrough", "Strikethrough (Alt+Shift+5)", ICON.strike, () => void onRange("home.strikethrough", (a) => ({ on: !a.style.s })), {
    toggle: true,
  });
  const textColor = dropdown("Text color", "Text color", `${svg(ICON.textColor)}<span class="tb-bar"></span>`, () => buildPalette("text"), "tb-color");
  sep();

  // Fill colour, borders, merge.
  const fillColor = dropdown("Fill color", "Fill color", `${svg(ICON.fill)}<span class="tb-bar"></span>`, () => buildPalette("fill"), "tb-color");
  dropdown("Borders", "Borders", svg(ICON.borders), buildBorders);
  const merge = button("Merge cells", "Merge cells", ICON.merge, () => {
    void onRange(state.merged ? "home.unmergeCells" : "home.mergeCells");
  }, { toggle: true, cls: "tb-split-main" });
  dropdown("Select merge type", "Select merge type", "", buildMerge, "tb-split-caret");
  sep();

  // Alignment, wrapping, rotation.
  const halign = dropdown("Horizontal align", "Horizontal align", svg(ICON.alignLeft), buildHAlign);
  const valign = dropdown("Vertical align", "Vertical align", svg(ICON.alignBottom), buildVAlign);
  const wrap = dropdown("Text wrapping", "Text wrapping", svg(ICON.overflow), buildWrap);
  const rotate = dropdown("Text rotation", "Text rotation", svg(rotationIcon(45)), buildRotation);
  sep();

  // Link, clear formatting.
  const link = button("Insert link", "Insert link (Ctrl+K)", ICON.link, () => openLink());
  button("Clear formatting", "Clear formatting (Ctrl+\\)", ICON.clear, () => void onRange("edit.clearFormats"));
  groups.push(group);

  groups.forEach((g, i) => {
    if (i > 0) root.append(el("span", { class: "tb-sep", role: "separator", "aria-orientation": "vertical" }));
    root.append(g);
  });

  // -------- paint format

  function setPainter(mode: typeof painter): void {
    painter = mode;
    paint.setAttribute("aria-pressed", String(mode !== "off"));
    gridHost.classList.toggle("tb-painting", mode !== "off");
  }

  /** Where paint format picked up from: a range on a sheet (kept here, not in the engine). */
  let painterSource: { range: string; sheet: number } | null = null;

  async function pickUp(sticky: boolean): Promise<void> {
    if (grid.isEditing) await grid.commit();
    painterSource = { range: range(), sheet: (await engine.info()).active };
    setPainter(sticky ? "sticky" : "once");
    grid.focus();
  }

  // The selection made by the next click (or drag) on the sheet receives the format.
  document.addEventListener(
    "pointerup",
    (e) => {
      if (painter === "off" || !gridHost.contains(e.target as Node) || e.button !== 0) return;
      const mode = painter;
      if (mode === "once") setPainter("off");
      // Let the grid finish its own pointerup (selection) first.
      setTimeout(() => {
        if (painterSource) void run("sheets.pasteFormats", { source: painterSource.range, sourceSheet: painterSource.sheet, target: range() });
      }, 0);
    },
    true,
  );

  // -------- popover builders

  function buildFormats(): HTMLElement {
    const cur = state.style.fmt ?? "General";
    const box = el("div", { class: "tb-menu" });
    for (const f of FORMATS) {
      if (!f) {
        box.append(el("div", { class: "tb-menu-sep", role: "separator" }));
        continue;
      }
      const [label, code, sample] = f;
      const checked = code === "Accounting" ? /^_\(.*\*/.test(cur) : code === cur;
      box.append(
        menuItem(label, () => void onRange("home.numberFormat", code === "Accounting" ? { format: "Accounting" } : { code }), { checked, hint: sample }),
      );
    }
    box.append(el("div", { class: "tb-menu-sep", role: "separator" }));
    const known = FORMATS.some((f) => f && f[1] === cur) || /^_\(.*\*/.test(cur);
    const input = el("input", {
      class: "tb-field",
      type: "text",
      "aria-label": "Custom number format",
      placeholder: "Custom format, e.g. 0.000",
      value: known ? "" : cur,
      spellcheck: "false",
    });
    const apply = el("button", { type: "button", class: "tb-apply" }, "Apply");
    const go = () => {
      const code = input.value.trim();
      closePopover(false);
      if (code) void onRange("home.numberFormat", { code });
      else grid.focus();
    };
    apply.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      }
    });
    box.append(el("div", { class: "tb-custom" }, el("div", { class: "tb-custom-title" }, "Custom number format"), el("div", { class: "tb-row" }, input, apply)));
    return box;
  }

  function buildFonts(): HTMLElement {
    const cur = state.style.font ?? DEFAULT_FONT;
    const box = el("div", { class: "tb-menu tb-fonts" });
    box.append(menuItem(`Default (${DEFAULT_FONT})`, () => void onRange("home.fontName", { name: DEFAULT_FONT }), { checked: !state.style.font }));
    box.append(el("div", { class: "tb-menu-sep", role: "separator" }));
    const list = FONTS.includes(cur) ? FONTS : [...FONTS, cur].sort();
    for (const f of list) {
      box.append(menuItem(f, () => void onRange("home.fontName", { name: f }), { checked: !!state.style.font && f === cur, style: `font-family: "${f}"` }));
    }
    return box;
  }

  function buildSizes(): HTMLElement {
    const box = el("div", { class: "tb-menu tb-sizes" });
    for (const n of SIZES) box.append(menuItem(String(n), () => void onRange("home.fontSize", { size: n }), { checked: n === state.style.size }));
    return box;
  }

  function buildPalette(kind: "text" | "fill"): HTMLElement {
    const cmd = kind === "text" ? "home.fontColor" : "home.fillColor";
    const cur = (kind === "text" ? state.style.color : state.style.fill)?.toLowerCase();
    const box = el("div", { class: "tb-palette" });
    const reset = el("button", { type: "button", class: "tb-item tb-reset", "aria-label": "Reset", role: "menuitem" }, el("span", { class: "tb-item-check", html: svg(ICON.reset, 18) }), el("span", { class: "tb-item-label" }, "Reset"));
    noFocus(reset);
    reset.addEventListener("click", () => {
      closePopover(false);
      void onRange(cmd, { color: kind === "text" ? "auto" : "none" });
    });
    box.append(reset);
    PALETTE.forEach((row, i) => {
      const r = el("div", { class: `tb-swatches${i === 1 ? " tb-swatches-gap" : ""}` });
      for (const [name, color] of row) {
        const b = el("button", {
          type: "button",
          class: "tb-swatch",
          role: "menuitemradio",
          title: name,
          "aria-label": name,
          "aria-checked": String(cur === color),
          "data-color": color,
          style: `background:${color}`,
        });
        noFocus(b);
        b.addEventListener("click", () => {
          closePopover(false);
          void onRange(cmd, { color: color.toUpperCase() });
        });
        r.append(b);
      }
      box.append(r);
    });
    const picker = el("input", { type: "color", class: "tb-picker", "aria-label": "Custom color", value: cur ?? (kind === "text" ? "#000000" : "#ffffff") });
    picker.addEventListener("change", () => {
      closePopover(false);
      void onRange(cmd, { color: picker.value.toUpperCase() });
    });
    box.append(el("div", { class: "tb-custom-color" }, el("span", {}, "Custom"), el("label", { class: "tb-plus", title: "Custom color", html: svg(ICON.plus, 18) }, picker)));
    return box;
  }

  function buildBorders(): HTMLElement {
    const box = el("div", { class: "tb-borders" });
    const presets = el("div", { class: "tb-border-grid" });
    for (const [label, preset, edges] of BORDER_PRESETS) {
      presets.append(iconChoice(label, borderIcon(edges), () => void onRange("home.borders", { preset, style: borderStyle, color: borderColor })));
    }
    const color = el("input", { type: "color", class: "tb-picker", "aria-label": "Border color", value: borderColor });
    color.addEventListener("input", () => {
      borderColor = color.value;
      colorLabel.style.setProperty("--bar", borderColor);
    });
    const colorLabel = el("label", { class: "tb-choice tb-border-color", title: "Border color", html: `${svg(ICON.pencil)}<span class="tb-bar"></span>` }, color);
    colorLabel.style.setProperty("--bar", borderColor);
    const styleSel = el("select", { class: "tb-border-style", "aria-label": "Border style", title: "Border style" });
    for (const [label, v] of BORDER_STYLES) styleSel.append(el("option", { value: v, ...(v === borderStyle ? { selected: true } : {}) }, label));
    styleSel.addEventListener("change", () => (borderStyle = styleSel.value));
    box.append(presets, el("div", { class: "tb-border-side" }, colorLabel, styleSel));
    return box;
  }

  function buildMerge(): HTMLElement {
    const box = el("div", { class: "tb-menu" });
    const s = sel();
    const vertical = () => {
      const parts: string[] = [];
      for (let c = s.c0; c <= s.c1; c++) parts.push(rangeA1({ r0: s.r0, r1: s.r1, c0: c, c1: c }));
      void run("home.mergeCells", { range: parts.join(",") });
    };
    box.append(
      menuItem("Merge all", () => void onRange("home.mergeCells")),
      menuItem("Merge vertically", vertical),
      menuItem("Merge horizontally", () => void onRange("home.mergeAcross")),
      menuItem("Unmerge", () => void onRange("home.unmergeCells")),
    );
    return box;
  }

  function buildHAlign(): HTMLElement {
    const h = state.style.h ?? "l";
    return el(
      "div",
      { class: "tb-choices" },
      iconChoice("Left", ICON.alignLeft, () => void onRange("home.alignLeft", { on: true }), h === "l"),
      iconChoice("Center", ICON.alignCenter, () => void onRange("home.alignCenter", { on: true }), h === "c"),
      iconChoice("Right", ICON.alignRight, () => void onRange("home.alignRight", { on: true }), h === "r"),
    );
  }

  function buildVAlign(): HTMLElement {
    const v = state.style.v ?? "b";
    return el(
      "div",
      { class: "tb-choices" },
      iconChoice("Top", ICON.alignTop, () => void onRange("home.alignTop"), v === "t"),
      iconChoice("Middle", ICON.alignMiddle, () => void onRange("home.alignMiddle"), v === "m"),
      iconChoice("Bottom", ICON.alignBottom, () => void onRange("home.alignBottom"), v === "b"),
    );
  }

  function buildWrap(): HTMLElement {
    const on = !!state.style.wrap;
    return el(
      "div",
      { class: "tb-choices" },
      iconChoice("Overflow", ICON.overflow, () => void onRange("home.wrapText", { on: false }), !on),
      iconChoice("Wrap", ICON.wrap, () => void onRange("home.wrapText", { on: true }), on),
      iconChoice("Clip", ICON.clip, () => void onRange("home.wrapText", { on: false })),
    );
  }

  function buildRotation(): HTMLElement {
    const rot = state.style.rot ?? 0;
    const opts: [string, number | "vertical"][] = [
      ["None", 0],
      ["Tilt up", 45],
      ["Tilt down", -45],
      ["Stack vertically", "vertical"],
      ["Rotate up", 90],
      ["Rotate down", -90],
    ];
    return el(
      "div",
      { class: "tb-choices" },
      ...opts.map(([label, angle]) =>
        iconChoice(label, angle === 0 ? p("M4 14.2h13v-1.7l3 2.5-3 2.5v-1.7H4z") + `<text x="11" y="11" text-anchor="middle" font-size="10" font-family="Arial, sans-serif" font-weight="bold">ab</text>` : rotationIcon(angle), () =>
          void onRange("home.orientation", { angle }), angle === rot),
      ),
    );
  }

  function openLink(): void {
    const { row, col } = first();
    const text = el("input", { class: "tb-field", type: "text", "aria-label": "Link text", placeholder: "Text", value: state.text, spellcheck: "false" });
    const target = el("input", { class: "tb-field", type: "text", "aria-label": "Link URL", placeholder: "Search or paste a link", spellcheck: "false" });
    const apply = el("button", { type: "button", class: "tb-apply" }, "Apply");
    const go = () => {
      const url = target.value.trim();
      const label = text.value.trim();
      closePopover(false);
      if (!url) return grid.focus();
      void run("insert.link", { cell: a1(row, col), target: url, ...(label ? { text: label } : {}) });
    };
    apply.addEventListener("click", go);
    for (const f of [text, target]) {
      f.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          go();
        }
      });
    }
    const box = openPopover(link, el("div", { class: "tb-link" }, text, el("div", { class: "tb-row" }, target, apply)), "Insert link");
    box.setAttribute("role", "dialog");
    target.focus();
  }

  // -------- keyboard shortcuts the grid itself doesn't handle
  // (Ctrl+K and Ctrl+\ belong to the menu bar, which handles them for the whole page.)

  grid.input.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && !(e.ctrlKey || e.metaKey) && e.code === "Digit5") {
      e.preventDefault();
      void onRange("home.strikethrough", (a) => ({ on: !a.style.s }));
    }
  });

  // -------- reflecting the active cell

  const pressed = (b: HTMLElement, on: boolean) => b.setAttribute("aria-pressed", String(on));

  function render(): void {
    const st = state.style;
    undo.disabled = !canUndo;
    redo.disabled = !canRedo;
    pressed(bold, !!st.b);
    pressed(italic, !!st.i);
    pressed(strike, !!st.s);
    pressed(merge, state.merged);
    const s = sel();
    merge.disabled = !state.merged && s.r0 === s.r1 && s.c0 === s.c1;
    const name = font.querySelector(".tb-font-name");
    const fontText = st.font ?? `Default (${DEFAULT_FONT})`;
    if (name && name.textContent !== fontText) name.textContent = fontText;
    if (document.activeElement !== size) size.value = String(st.size);
    textColor.style.setProperty("--bar", st.color ?? "#000000");
    fillColor.style.setProperty("--bar", st.fill ?? "transparent");
    setBody(halign, svg(st.h === "c" ? ICON.alignCenter : st.h === "r" ? ICON.alignRight : ICON.alignLeft));
    setBody(valign, svg(st.v === "t" ? ICON.alignTop : st.v === "m" ? ICON.alignMiddle : ICON.alignBottom));
    setBody(wrap, svg(st.wrap ? ICON.wrap : ICON.overflow));
    setBody(rotate, svg(rotationIcon(st.rot ? st.rot : 45)));
    root.dataset.font = st.font ?? DEFAULT_FONT;
  }

  let timer = 0;
  let running = false;
  let again = false;

  async function update(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const [a, info] = await Promise.all([readActive(), engine.info()]);
        state = a;
        canUndo = info.can_undo;
        canRedo = info.can_redo;
        render();
      } while (again);
    } catch {
      /* the engine is busy opening a file; the next change refreshes */
    } finally {
      running = false;
    }
  }

  render();
  void update();

  return {
    refresh() {
      clearTimeout(timer);
      timer = window.setTimeout(() => void update(), 16);
    },
  };
}
