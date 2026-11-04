"use client";

import { useLayoutEffect, useRef } from "react";
import { background, baseStyle, boxOf, compose, cssColor, layoutOf, masterOf, PT_EMU, shapeProps, type Json, type Tf } from "./model";
import { drawText, type TextLook } from "./text";

/** What the editor is editing: an element's text, or one table cell's. */
export type EditTarget = { id: string; cell?: { rowIndex: number; columnIndex: number } } | null;
export type Preview = { id: string; dx: number; dy: number; box?: { x: number; y: number; w: number; h: number } } | null;

const HINT: Record<string, string> = { TITLE: "Click to add title", CENTERED_TITLE: "Click to add title", SUBTITLE: "Click to add subtitle", BODY: "Click to add text" };

function artPath(type: string, w: number, h: number) {
  switch (type) {
    case "TRIANGLE":
      return `M${w / 2} 0L${w} ${h}L0 ${h}Z`;
    case "RIGHT_TRIANGLE":
      return `M0 0L${w} ${h}L0 ${h}Z`;
    case "DIAMOND":
      return `M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`;
    case "PENTAGON":
      return `M${w / 2} 0L${w} ${h * 0.38}L${w * 0.81} ${h}L${w * 0.19} ${h}L0 ${h * 0.38}Z`;
    case "HEXAGON":
      return `M${w * 0.25} 0L${w * 0.75} 0L${w} ${h / 2}L${w * 0.75} ${h}L${w * 0.25} ${h}L0 ${h / 2}Z`;
    case "RIGHT_ARROW":
      return `M0 ${h * 0.25}L${w * 0.6} ${h * 0.25}L${w * 0.6} 0L${w} ${h / 2}L${w * 0.6} ${h}L${w * 0.6} ${h * 0.75}L0 ${h * 0.75}Z`;
    case "LEFT_ARROW":
      return `M${w} ${h * 0.25}L${w * 0.4} ${h * 0.25}L${w * 0.4} 0L0 ${h / 2}L${w * 0.4} ${h}L${w * 0.4} ${h * 0.75}L${w} ${h * 0.75}Z`;
    case "STAR_5": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.4 : 1;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push(`${w / 2 + (w / 2) * r * Math.cos(a)} ${h / 2 + (h / 2) * r * Math.sin(a)}`);
      }
      return `M${pts.join("L")}Z`;
    }
    case "WEDGE_RECTANGLE_CALLOUT":
      return `M0 0H${w}V${h * 0.75}H${w * 0.4}L${w * 0.15} ${h}L${w * 0.25} ${h * 0.75}H0Z`;
    default:
      return null;
  }
}

/** One text box: drawn from the text JSON; editable when it's the edit target. */
function TextBox(p: { text: Json; look: TextLook; edit: boolean; hint?: string; valign?: string; inset: number; onRoot?: (el: HTMLDivElement | null) => void; onDrawn?: () => void; composing?: () => boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = JSON.stringify([p.text ?? null, p.look.scale, p.look.base, p.look.fontScale ?? 1]);
  const { onRoot, onDrawn, composing, look, text, edit } = p;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || composing?.()) return;
    drawText(el, text, look);
    if (edit) onDrawn?.();
    // key stands for text and look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, edit]);
  useLayoutEffect(() => {
    onRoot?.(edit ? ref.current : null);
  }, [edit, onRoot]);
  const empty = !p.text?.textElements?.length;
  return (
    <div className={`tx ${p.edit ? "edit" : ""}`} style={{ padding: p.inset, justifyContent: p.valign === "MIDDLE" ? "center" : p.valign === "BOTTOM" ? "flex-end" : "flex-start" }}>
      {empty && !p.edit && p.hint && (
        <div className="hint" style={{ fontSize: Math.max(8, 18 * PT_EMU * p.look.scale) }}>
          {p.hint}
        </div>
      )}
      <div ref={ref} className="ti" contentEditable={p.edit} suppressContentEditableWarning spellCheck={p.edit} style={empty && !p.edit && p.hint ? { display: "none" } : undefined} />
    </div>
  );
}

type Leaf = { el: Json; top: string; t: Tf; decor?: boolean };
function leaves(list: Json[], parent: Tf | null, top: string | null, decor: boolean, out: Leaf[]) {
  for (const el of list ?? []) {
    const t = parent ? compose(parent, el.transform ?? {}) : (el.transform ?? {});
    if (el.elementGroup) leaves(el.elementGroup.children, t, top ?? el.objectId, decor, out);
    else out.push({ el, top: top ?? el.objectId, t, decor });
  }
  return out;
}

/** The leaf boxes of a slide's elements (groups opened), for hit-testing and selection outlines. */
export function boxesOf(page: Json) {
  return leaves(page?.pageElements ?? [], null, null, false, []).map((l) => ({ top: l.top, id: l.el.objectId, ...boxOf(l.t, l.el.size) }));
}

/** A slide drawn from Google's JSON, scaled by s (pixels per EMU). */
export default function SlideView(p: {
  pres: Json;
  page: Json;
  s: number;
  mini?: boolean;
  preview?: Preview;
  edit?: EditTarget;
  onRoot?: (el: HTMLDivElement | null) => void;
  onDrawn?: () => void;
  composing?: () => boolean;
  onDown?: (e: React.PointerEvent, top: string, cell?: { rowIndex: number; columnIndex: number }) => void;
  onDouble?: (top: string, leaf: string, cell?: { rowIndex: number; columnIndex: number }) => void;
  children?: React.ReactNode;
}) {
  const { pres, page, s } = p;
  const W = (pres.pageSize?.width?.magnitude ?? 9144000) * s;
  const H = (pres.pageSize?.height?.magnitude ?? 5143500) * s;
  const bg = background(pres, page);
  const deco = [...leaves(masterOf(pres, page)?.pageElements?.filter((e: Json) => !e.shape?.placeholder) ?? [], null, null, true, []), ...leaves(layoutOf(pres, page)?.pageElements?.filter((e: Json) => !e.shape?.placeholder) ?? [], null, null, true, [])];
  const all = [...deco, ...leaves(page?.pageElements ?? [], null, null, false, [])];
  const color = (c: Json, a?: number) => cssColor(pres, page, c, a);

  const render = (l: Leaf, i: number) => {
    const el = l.el;
    const b = boxOf(l.t, el.size);
    const pv = p.preview && p.preview.id === l.top ? p.preview : null;
    let x = b.x + (pv?.dx ?? 0);
    let y = b.y + (pv?.dy ?? 0);
    let w = b.w;
    let h = b.h;
    if (pv?.box && l.top === el.objectId) ({ x, y, w, h } = pv.box);
    const style: React.CSSProperties = { left: x * s, top: y * s, width: Math.max(1, w * s), height: Math.max(1, h * s), transform: `rotate(${b.rot}deg)${b.flip ? " scale(1,-1)" : ""}` };
    const cls = `se ${l.decor || p.mini ? "decor" : "pick"}`;
    const down = (e: React.PointerEvent, cell?: { rowIndex: number; columnIndex: number }) => p.onDown?.(e, l.top, cell);
    const dbl = (cell?: { rowIndex: number; columnIndex: number }) => p.onDouble?.(l.top, el.objectId, cell);
    const inset = 91440 * s;
    if (el.shape) {
      const sp = shapeProps(pres, el);
      const fill = sp.shapeBackgroundFill?.propertyState === "NOT_RENDERED" ? undefined : sp.shapeBackgroundFill?.solidFill ? color(sp.shapeBackgroundFill.solidFill.color, sp.shapeBackgroundFill.solidFill.alpha) : undefined;
      const ol = sp.outline;
      const stroke = !ol || ol.propertyState === "NOT_RENDERED" ? undefined : ol.outlineFill?.solidFill ? color(ol.outlineFill.solidFill.color, ol.outlineFill.solidFill.alpha) : undefined;
      const sw = stroke ? Math.max(0.5, (ol.weight?.magnitude ?? 9525) * (ol.weight?.unit === "PT" ? PT_EMU : 1) * s) : 0;
      const pw = w * s;
      const ph = h * s;
      const d = artPath(el.shape.shapeType, pw, ph);
      const editing = !!p.edit && p.edit.id === el.objectId && !p.edit.cell;
      const look: TextLook = { p: pres, page, scale: s, base: baseStyle(pres, el), fontScale: sp.autofit?.fontScale };
      return (
        <div key={`${el.objectId}${i}`} className={cls} style={style} data-id={l.top} onPointerDown={(e) => !editing && down(e)} onDoubleClick={() => dbl()}>
          {(fill || stroke) && (
            <svg className="art" viewBox={`0 0 ${pw} ${ph}`} preserveAspectRatio="none">
              {el.shape.shapeType === "ELLIPSE" ? (
                <ellipse cx={pw / 2} cy={ph / 2} rx={Math.max(0, pw / 2 - sw / 2)} ry={Math.max(0, ph / 2 - sw / 2)} fill={fill ?? "none"} stroke={stroke} strokeWidth={sw} />
              ) : d ? (
                <path d={d} fill={fill ?? "none"} stroke={stroke} strokeWidth={sw} strokeDasharray={ol?.dashStyle === "DASH" ? `${sw * 4} ${sw * 3}` : ol?.dashStyle === "DOT" ? `${sw} ${sw * 2}` : undefined} />
              ) : (
                <rect x={sw / 2} y={sw / 2} width={Math.max(0, pw - sw)} height={Math.max(0, ph - sw)} rx={el.shape.shapeType === "ROUND_RECTANGLE" ? Math.min(pw, ph) * 0.12 : 0} fill={fill ?? "none"} stroke={stroke} strokeWidth={sw} />
              )}
            </svg>
          )}
          <TextBox text={el.shape.text} look={look} edit={editing} hint={p.mini || l.decor ? undefined : HINT[el.shape.placeholder?.type ?? ""]} valign={sp.contentAlignment} inset={inset} onRoot={editing ? p.onRoot : undefined} onDrawn={p.onDrawn} composing={p.composing} />
        </div>
      );
    }
    if (el.image || el.sheetsChart) {
      const src = el.image?.contentUrl ?? el.sheetsChart?.contentUrl;
      return (
        <div key={`${el.objectId}${i}`} className={cls} style={style} data-id={l.top} onPointerDown={(e) => down(e)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {src ? <img src={src} alt="" draggable={false} /> : <div className="sl-chip">Image</div>}
        </div>
      );
    }
    if (el.line) {
      const lp = el.line.lineProperties ?? {};
      const stroke = lp.lineFill?.solidFill ? color(lp.lineFill.solidFill.color, lp.lineFill.solidFill.alpha) : "#000";
      const sw = Math.max(1, (lp.weight?.magnitude ?? 9525) * (lp.weight?.unit === "PT" ? PT_EMU : 1) * s);
      const pw = Math.max(1, w * s);
      const ph = Math.max(1, h * s);
      const hit = Math.max(8, sw + 6);
      return (
        <div key={`${el.objectId}${i}`} className={cls} style={{ ...style, height: Math.max(ph, 1) }} data-id={l.top} onPointerDown={(e) => down(e)}>
          <svg className="art" viewBox={`0 0 ${pw} ${ph}`} preserveAspectRatio="none" style={{ overflow: "visible" }}>
            <line x1={0} y1={0} x2={pw} y2={h ? ph : 0} stroke="transparent" strokeWidth={hit} style={{ pointerEvents: l.decor || p.mini ? "none" : "stroke" }} />
            <line x1={0} y1={0} x2={pw} y2={h ? ph : 0} stroke={stroke} strokeWidth={sw} strokeDasharray={lp.dashStyle === "DASH" ? `${sw * 4} ${sw * 3}` : undefined} />
            {lp.endArrow && lp.endArrow !== "NONE" && <circle cx={pw} cy={h ? ph : 0} r={sw * 1.6} fill={stroke} />}
          </svg>
        </div>
      );
    }
    if (el.table) {
      const t = el.table;
      const cols: number[] = (t.tableColumns ?? []).map((c: Json) => (c.columnWidth?.magnitude ?? 0) * s);
      return (
        <div key={`${el.objectId}${i}`} className={cls} style={style} data-id={l.top} onPointerDown={(e) => !(p.edit?.id === el.objectId) && down(e)}>
          <table>
            <colgroup>
              {cols.map((c, k) => (
                <col key={k} style={{ width: c }} />
              ))}
            </colgroup>
            <tbody>
              {(t.tableRows ?? []).map((row: Json, ri: number) => (
                <tr key={ri} style={{ height: (row.rowHeight?.magnitude ?? 0) * s }}>
                  {(row.tableCells ?? []).map((cell: Json, ci: number) => {
                    const cl = { rowIndex: ri, columnIndex: ci };
                    const editing = !!p.edit && p.edit.id === el.objectId && p.edit.cell?.rowIndex === ri && p.edit.cell?.columnIndex === ci;
                    const f = cell.tableCellProperties?.tableCellBackgroundFill;
                    return (
                      <td key={ci} colSpan={cell.columnSpan ?? 1} rowSpan={cell.rowSpan ?? 1} style={{ background: f?.solidFill ? color(f.solidFill.color, f.solidFill.alpha) : undefined }} onDoubleClick={(e) => (e.stopPropagation(), dbl(cl))}>
                        <TextBox text={cell.text} look={{ p: pres, page, scale: s, base: { ts: { fontSize: { magnitude: 14, unit: "PT" } }, ps: {} } }} edit={editing} inset={inset * 0.6} onRoot={editing ? p.onRoot : undefined} onDrawn={p.onDrawn} composing={p.composing} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    const label = el.video ? "Video (play it in Google Slides)" : el.wordArt ? "Word art" : el.speakerSpotlight ? "Speaker spotlight" : "Object";
    return (
      <div key={`${el.objectId}${i}`} className={cls} style={style} data-id={l.top} onPointerDown={(e) => down(e)}>
        <div className="sl-chip">{label}</div>
      </div>
    );
  };

  return (
    <div className={`sl-slide ${p.mini ? "mini" : ""}`} style={{ width: W, height: H, background: bg.image ? `center / cover url("${bg.image}")` : bg.color }}>
      {all.map(render)}
      {p.children}
    </div>
  );
}
