"use client";

import { useState } from "react";
import {
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowLeft,
  ArrowRight,
  Baseline,
  Bold,
  ChevronDown,
  DollarSign,
  Funnel,
  Grid3x3,
  Italic,
  Link,
  Minus,
  PaintBucket,
  Percent,
  Plus,
  Redo2,
  Sigma,
  StickyNote,
  Strikethrough,
  TableCellsMerge,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  TextWrap,
  Underline,
  Undo2,
} from "lucide-react";
import { Dropdown, type Item } from "./Menu";
import { DEFAULT_FONT, DEFAULT_SIZE, FONTS, NUMBER_FORMATS, PALETTE, SIZES, fillOf, getUF, inkOf, type Cell } from "./model";

export type BorderKind = "all" | "inner" | "horizontal" | "vertical" | "outer" | "left" | "top" | "right" | "bottom" | "clear";
export type Tools = {
  cur: Cell | null | undefined;
  readOnly: boolean;
  zoom: number;
  setZoom: (z: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  fmt: (path: string, value: unknown, label: string) => void;
  colour: (which: "text" | "fill", hex: string | null) => void;
  numberFormat: (nf: { type: string; pattern?: string } | null, label: string) => void;
  currency: () => void;
  decimals: (d: 1 | -1) => void;
  borders: (kind: BorderKind, color: string, style: string) => void;
  merge: (type: "MERGE_ALL" | "MERGE_COLUMNS" | "MERGE_ROWS" | "UNMERGE") => void;
  merged: boolean;
  link: () => void;
  note: () => void;
  filterOn: boolean;
  toggleFilter: () => void;
  fn: (name: string) => void;
};

export const ZOOMS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2];
export const FUNCTIONS = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"];

/** Google's palette with a reset and a custom colour, for text and fill colour. */
export function Palette({ value, onPick, reset }: { value?: string; onPick: (hex: string | null) => void; reset: string }) {
  const [custom, setCustom] = useState(value ?? "#4a86e8");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <button type="button" className="sx-mi" style={{ padding: "4px 6px" }} onClick={() => onPick(null)}>
        {reset}
      </button>
      <div className="sx-palette">
        {PALETTE.flat().map((h) => (
          <button key={h} type="button" title={h} aria-label={h} style={{ background: h, outline: value === h ? "2px solid var(--ox, #0d9488)" : undefined }} onClick={() => onPick(h)} />
        ))}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
        Custom
        <input type="color" aria-label="Custom colour" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button type="button" className="sx-btn" style={{ padding: "2px 10px" }} onClick={() => onPick(custom)}>
          Apply
        </button>
      </label>
    </div>
  );
}

/** Little pictures for the border choices. */
function BorderIcon({ kind }: { kind: BorderKind }) {
  const on = "currentColor";
  const off = "var(--ix-muted)";
  const has = (side: string) =>
    kind === "all" ||
    (kind === "outer" && ["t", "b", "l", "r"].includes(side)) ||
    (kind === "inner" && ["h", "v"].includes(side)) ||
    (kind === "horizontal" && side === "h") ||
    (kind === "vertical" && side === "v") ||
    (kind === "left" && side === "l") ||
    (kind === "right" && side === "r") ||
    (kind === "top" && side === "t") ||
    (kind === "bottom" && side === "b");
  const line = (side: string, x1: number, y1: number, x2: number, y2: number) => <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={has(side) ? on : off} strokeWidth={has(side) ? 2 : 1} strokeDasharray={has(side) ? undefined : "1.5 1.5"} />;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      {line("t", 2, 2, 16, 2)}
      {line("b", 2, 16, 16, 16)}
      {line("l", 2, 2, 2, 16)}
      {line("r", 16, 2, 16, 16)}
      {line("h", 2, 9, 16, 9)}
      {line("v", 9, 2, 9, 16)}
    </svg>
  );
}

const STYLES: [string, string][] = [
  ["SOLID", "Solid"],
  ["SOLID_MEDIUM", "Medium"],
  ["SOLID_THICK", "Thick"],
  ["DASHED", "Dashed"],
  ["DOTTED", "Dotted"],
  ["DOUBLE", "Double"],
];

function Borders({ t }: { t: Tools }) {
  const [color, setColor] = useState("#000000");
  const [style, setStyle] = useState("SOLID");
  const kinds: BorderKind[] = ["all", "inner", "horizontal", "vertical", "outer", "left", "top", "right", "bottom", "clear"];
  return (
    <Dropdown title="Borders" button={<Grid3x3 size={17} />} disabled={t.readOnly}>
      {(close) => (
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 30px)", gap: 4 }}>
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                className="sx-tb"
                title={k === "clear" ? "Clear borders" : `${k[0].toUpperCase()}${k.slice(1)} borders`}
                aria-label={k === "clear" ? "Clear borders" : `${k} borders`}
                onClick={() => {
                  t.borders(k, color, style);
                  close();
                }}
              >
                {k === "clear" ? <span style={{ fontSize: 11 }}>✕</span> : <BorderIcon kind={k} />}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              Colour <input type="color" aria-label="Border colour" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
            <select aria-label="Border style" className="sx-input" style={{ padding: "3px 6px" }} value={style} onChange={(e) => setStyle(e.target.value)}>
              {STYLES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Dropdown>
  );
}

/** The toolbar under the menus, as in Google Sheets. */
export default function Toolbar({ t }: { t: Tools }) {
  const uf = t.cur?.uf;
  const ro = t.readOnly;
  const on = (path: string) => !!getUF(uf, path);
  const size = (getUF(uf, "textFormat.fontSize") as number | undefined) ?? DEFAULT_SIZE;
  const font = (getUF(uf, "textFormat.fontFamily") as string | undefined) ?? DEFAULT_FONT;
  const ha = (uf?.horizontalAlignment ?? "LEFT") as string;
  const va = (uf?.verticalAlignment ?? "BOTTOM") as string;
  const wrap = (uf?.wrapStrategy ?? "OVERFLOW_CELL") as string;
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const setSize = (n: number) => n >= 1 && n <= 400 && t.fmt("textFormat.fontSize", n, "Font size");
  const tb = (label: string, icon: React.ReactNode, onClick: () => void, opts: { pressed?: boolean; disabled?: boolean; phone?: boolean } = {}) => (
    <button
      type="button"
      className={`sx-tb ${opts.phone ? "" : "sx-hide-phone"}`}
      title={label}
      aria-label={label}
      aria-pressed={opts.pressed}
      disabled={opts.disabled ?? ro}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );
  const sep = <span className="sx-tbsep sx-hide-phone" />;
  const haIcon = ha === "CENTER" ? <TextAlignCenter size={17} /> : ha === "RIGHT" ? <TextAlignEnd size={17} /> : <TextAlignStart size={17} />;
  const vaIcon = va === "TOP" ? <AlignVerticalJustifyStart size={17} /> : va === "MIDDLE" ? <AlignVerticalJustifyCenter size={17} /> : <AlignVerticalJustifyEnd size={17} />;
  const choice = (items: [string, string, React.ReactNode][], cur: string, path: string, label: string): Item[] =>
    items.map(([v, l, icon]) => ({ label: l, icon, checked: cur === v, onClick: () => t.fmt(path, v, label) }));

  return (
    <div className="sx-toolbar" role="toolbar" aria-label="Formatting">
      {tb("Undo (Ctrl+Z)", <Undo2 size={17} />, t.undo, { disabled: ro || !t.canUndo, phone: true })}
      {tb("Redo (Ctrl+Y)", <Redo2 size={17} />, t.redo, { disabled: ro || !t.canRedo, phone: true })}
      <Dropdown
        title="Zoom"
        className="sx-tb"
        button={
          <>
            {Math.round(t.zoom * 100)}% <ChevronDown size={14} />
          </>
        }
        items={ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: z === t.zoom, onClick: () => t.setZoom(z) }))}
      />
      {sep}
      {tb("Format as currency", <DollarSign size={16} />, t.currency)}
      {tb("Format as percent", <Percent size={16} />, () => t.numberFormat({ type: "PERCENT", pattern: "0.00%" }, "Percent"))}
      {tb(
        "Decrease decimal places",
        <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 600 }}>
          <ArrowLeft size={11} />.0
        </span>,
        () => t.decimals(-1),
      )}
      {tb(
        "Increase decimal places",
        <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 600 }}>
          .00
          <ArrowRight size={11} />
        </span>,
        () => t.decimals(1),
      )}
      <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
        <Dropdown
          title="More formats"
          disabled={ro}
          button={
            <>
              <span style={{ fontWeight: 600, fontSize: 12 }}>123</span> <ChevronDown size={14} />
            </>
          }
          items={NUMBER_FORMATS.map((f) => ({ label: f.label, hint: f.sample, checked: f.nf ? uf?.numberFormat?.pattern === f.nf.pattern : !uf?.numberFormat, onClick: () => t.numberFormat(f.nf, f.label) }))}
        />
      </span>
      {sep}
      <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
        <Dropdown
          title="Font"
          disabled={ro}
          button={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, width: 92, justifyContent: "space-between" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{font}</span>
              <ChevronDown size={14} />
            </span>
          }
          items={FONTS.map((f) => ({ label: f, checked: f === font, icon: <span style={{ fontFamily: f }}>A</span>, onClick: () => t.fmt("textFormat.fontFamily", f, "Font") }))}
        />
      </span>
      {sep}
      <span className="sx-fsize sx-hide-phone">
        <button type="button" className="sx-tb" style={{ height: 24, minWidth: 22 }} title="Decrease font size" aria-label="Decrease font size" disabled={ro} onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(Math.max(1, size - 1))}>
          <Minus size={14} />
        </button>
        <input
          aria-label="Font size"
          list="sx-sizes"
          disabled={ro}
          value={sizeDraft ?? String(size)}
          onChange={(e) => setSizeDraft(e.target.value)}
          onBlur={() => setSizeDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setSize(Number(sizeDraft ?? size));
              setSizeDraft(null);
            }
          }}
        />
        <datalist id="sx-sizes">
          {SIZES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button type="button" className="sx-tb" style={{ height: 24, minWidth: 22 }} title="Increase font size" aria-label="Increase font size" disabled={ro} onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(size + 1)}>
          <Plus size={14} />
        </button>
      </span>
      {sep}
      {tb("Bold (Ctrl+B)", <Bold size={16} />, () => t.fmt("textFormat.bold", !on("textFormat.bold"), "Bold"), { pressed: on("textFormat.bold"), phone: true })}
      {tb("Italic (Ctrl+I)", <Italic size={16} />, () => t.fmt("textFormat.italic", !on("textFormat.italic"), "Italic"), { pressed: on("textFormat.italic"), phone: true })}
      {tb("Strikethrough (Alt+Shift+5)", <Strikethrough size={16} />, () => t.fmt("textFormat.strikethrough", !on("textFormat.strikethrough"), "Strikethrough"), { pressed: on("textFormat.strikethrough") })}
      {tb("Underline (Ctrl+U)", <Underline size={16} />, () => t.fmt("textFormat.underline", !on("textFormat.underline"), "Underline"), { pressed: on("textFormat.underline") })}
      <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
        <Dropdown
          title="Text colour"
          disabled={ro}
          button={
            <span style={{ position: "relative", display: "inline-grid", placeItems: "center", width: 22, height: 26 }}>
              <Baseline size={16} />
              <span className="sx-swatchbar" style={{ background: inkOf(uf) ?? "#000000" }} />
            </span>
          }
        >
          {(close) => (
            <Palette
              value={inkOf(uf)}
              reset="Reset"
              onPick={(h) => {
                t.colour("text", h);
                close();
              }}
            />
          )}
        </Dropdown>
      </span>
      {sep}
      <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
        <Dropdown
          title="Fill colour"
          disabled={ro}
          button={
            <span style={{ position: "relative", display: "inline-grid", placeItems: "center", width: 22, height: 26 }}>
              <PaintBucket size={16} />
              <span className="sx-swatchbar" style={{ background: fillOf(uf) ?? "transparent", border: fillOf(uf) ? undefined : "1px solid var(--ix-line)" }} />
            </span>
          }
        >
          {(close) => (
            <Palette
              value={fillOf(uf)}
              reset="Reset"
              onPick={(h) => {
                t.colour("fill", h);
                close();
              }}
            />
          )}
        </Dropdown>
      </span>
      <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
        <Borders t={t} />
      </span>
      <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
        {tb(t.merged ? "Unmerge cells" : "Merge cells", <TableCellsMerge size={17} />, () => t.merge(t.merged ? "UNMERGE" : "MERGE_ALL"), { pressed: t.merged })}
        <Dropdown
          title="Merge options"
          disabled={ro}
          className="sx-tb"
          button={<ChevronDown size={13} />}
          items={[
            { label: "Merge all", onClick: () => t.merge("MERGE_ALL") },
            { label: "Merge vertically", onClick: () => t.merge("MERGE_COLUMNS") },
            { label: "Merge horizontally", onClick: () => t.merge("MERGE_ROWS") },
            { label: "Unmerge", onClick: () => t.merge("UNMERGE") },
          ]}
        />
      </span>
      {sep}
      <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
        <Dropdown
          title="Horizontal align"
          disabled={ro}
          button={
            <>
              {haIcon}
              <ChevronDown size={13} />
            </>
          }
          items={choice(
            [
              ["LEFT", "Left", <TextAlignStart key="l" size={15} />],
              ["CENTER", "Center", <TextAlignCenter key="c" size={15} />],
              ["RIGHT", "Right", <TextAlignEnd key="r" size={15} />],
            ],
            ha,
            "horizontalAlignment",
            "Align",
          )}
        />
        <Dropdown
          title="Vertical align"
          disabled={ro}
          button={
            <>
              {vaIcon}
              <ChevronDown size={13} />
            </>
          }
          items={choice(
            [
              ["TOP", "Top", <AlignVerticalJustifyStart key="t" size={15} />],
              ["MIDDLE", "Middle", <AlignVerticalJustifyCenter key="m" size={15} />],
              ["BOTTOM", "Bottom", <AlignVerticalJustifyEnd key="b" size={15} />],
            ],
            va,
            "verticalAlignment",
            "Vertical align",
          )}
        />
        <Dropdown
          title="Text wrapping"
          disabled={ro}
          button={
            <>
              <TextWrap size={17} />
              <ChevronDown size={13} />
            </>
          }
          items={choice(
            [
              ["OVERFLOW_CELL", "Overflow", null],
              ["WRAP", "Wrap", null],
              ["CLIP", "Clip", null],
            ],
            wrap,
            "wrapStrategy",
            "Wrapping",
          )}
        />
      </span>
      {sep}
      {tb("Insert link (Ctrl+K)", <Link size={16} />, t.link)}
      {tb("Insert note", <StickyNote size={16} />, t.note)}
      {tb(t.filterOn ? "Remove filter" : "Create a filter", <Funnel size={16} />, t.toggleFilter, { pressed: t.filterOn })}
      <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
        <Dropdown title="Functions" disabled={ro} button={<Sigma size={16} />} items={FUNCTIONS.map((f) => ({ label: f, onClick: () => t.fn(f) }))} />
      </span>
    </div>
  );
}
