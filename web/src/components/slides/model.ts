/**
 * A Google Slides presentation as the editor holds it: Google's own JSON
 * (presentations.get), changed locally by the same batchUpdate requests that
 * are sent to Google, so the screen shows a change before Google confirms
 * it. Text in a shape is handled one character per index, as Google counts
 * it; transforms and sizes are in EMU (914,400 to the inch).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;
export type Req = Record<string, Json>;

export const EMU_PX = 1 / 9525;
export const PT_EMU = 12700;

// ── Text ──
export type TChar = { ch: string; st: Json };
export type TFlat = { chars: TChar[]; paras: { style: Json; bullet?: Json }[] };
export function toFlat(text: Json): TFlat {
  const out: TFlat = { chars: [], paras: [] };
  for (const te of text?.textElements ?? []) {
    if (te.paragraphMarker) out.paras.push({ style: te.paragraphMarker.style ?? {}, ...(te.paragraphMarker.bullet ? { bullet: te.paragraphMarker.bullet } : {}) });
    const run = te.textRun ?? te.autoText;
    if (run) for (const ch of String(run.content ?? "").split("")) out.chars.push({ ch, st: run.style ?? {} });
  }
  // Every paragraph has a marker.
  const n = out.chars.filter((c) => c.ch === "\n").length;
  while (out.paras.length < n) out.paras.push({ style: {} });
  return out;
}
export function fromFlat(f: TFlat): Json {
  if (!f.chars.length) return undefined;
  const els: Json[] = [];
  let a = 0;
  let k = 0;
  while (a < f.chars.length) {
    let b = a;
    while (b < f.chars.length && f.chars[b].ch !== "\n") b++;
    b = Math.min(f.chars.length, b + 1);
    const p = f.paras[k] ?? { style: {} };
    els.push({ startIndex: a, endIndex: b, paragraphMarker: { style: p.style ?? {}, ...(p.bullet ? { bullet: p.bullet } : {}) } });
    for (let x = a; x < b; ) {
      let y = x + 1;
      while (y < b && f.chars[y].st === f.chars[x].st) y++;
      els.push({ startIndex: x, endIndex: y, textRun: { content: f.chars.slice(x, y).map((c) => c.ch).join(""), style: f.chars[x].st } });
      x = y;
    }
    a = b;
    k++;
  }
  return { textElements: els };
}
/** The text people see (without the last newline). */
export const plainOf = (text: Json) => {
  const s = toFlat(text).chars.map((c) => c.ch).join("");
  return s.endsWith("\n") ? s.slice(0, -1) : s;
};

// ── Finding things ──
export type Found = { el: Json; list: Json[]; page: Json };
export function findEl(p: Json, id: string): Found | null {
  const look = (list: Json[], page: Json): Found | null => {
    for (const el of list ?? []) {
      if (el.objectId === id) return { el, list, page };
      if (el.elementGroup) {
        const r = look(el.elementGroup.children, page);
        if (r) return r;
      }
    }
    return null;
  };
  for (const s of p.slides ?? []) {
    const r = look(s.pageElements, s) ?? (s.slideProperties?.notesPage ? look(s.slideProperties.notesPage.pageElements, s.slideProperties.notesPage) : null);
    if (r) return r;
  }
  for (const s of [...(p.layouts ?? []), ...(p.masters ?? [])]) {
    const r = look(s.pageElements, s);
    if (r) return r;
  }
  return null;
}
export const slideOf = (p: Json, id: string) => (p.slides ?? []).find((s: Json) => s.objectId === id);
function holder(p: Json, r: Json) {
  const f = findEl(p, r.objectId);
  if (!f) throw new Error(`No object ${r.objectId}`);
  if (r.cellLocation) {
    const cell = f.el.table?.tableRows?.[r.cellLocation.rowIndex ?? 0]?.tableCells?.[r.cellLocation.columnIndex ?? 0];
    if (!cell) throw new Error("No such cell");
    return cell;
  }
  return f.el.shape;
}
function span(r: Json, len: number): [number, number] {
  const t = r.textRange ?? { type: "ALL" };
  if (t.type === "ALL") return [0, len];
  return [t.startIndex ?? 0, t.type === "FROM_START_INDEX" ? len : t.endIndex];
}
export function patch(obj: Json, style: Json, fields: string) {
  if (fields.trim() === "*") return JSON.parse(JSON.stringify(style ?? {}));
  const out = JSON.parse(JSON.stringify(obj ?? {}));
  for (const path of fields.split(",").map((x) => x.trim()).filter(Boolean)) {
    const parts = path.split(".");
    let src = style;
    for (const q of parts) src = src?.[q];
    let dst = out;
    for (const q of parts.slice(0, -1)) dst = dst[q] ??= {};
    if (src === undefined) delete dst[parts[parts.length - 1]];
    else dst[parts[parts.length - 1]] = JSON.parse(JSON.stringify(src));
  }
  return out;
}
export function pickPath(obj: Json, fields: string) {
  return patch({}, obj ?? {}, fields);
}

// ── Applying requests locally ──
export const LOCAL = new Set(["insertText", "deleteText", "updateTextStyle", "updateParagraphStyle", "updatePageElementTransform", "updateShapeProperties", "createShape", "createLine", "deleteObject", "updateSlidesPosition"]);
export const TS_FIELDS = "bold,italic,underline,strikethrough,smallCaps,baselineOffset,fontFamily,fontSize,foregroundColor,backgroundColor,link,weightedFontFamily";

export function applyReq(p: Json, req: Req) {
  const kind = Object.keys(req)[0];
  const r = req[kind];
  switch (kind) {
    case "insertText": {
      const h = holder(p, r);
      const f = toFlat(h.text);
      const i = r.insertionIndex ?? 0;
      const text = String(r.text ?? "");
      if (!f.chars.length) {
        const st = {};
        f.chars = (text.endsWith("\n") ? text : `${text}\n`).split("").map((ch) => ({ ch, st }));
        f.paras = f.chars.filter((c) => c.ch === "\n").map(() => ({ style: {} }));
      } else {
        const prev = f.chars[i - 1];
        const st = prev && prev.ch !== "\n" ? prev.st : (f.chars[i]?.st ?? {});
        const k = f.chars.slice(0, i).filter((c) => c.ch === "\n").length;
        const add = text.split("").map((ch) => ({ ch, st }));
        f.chars.splice(i, 0, ...add);
        const nl = add.filter((c) => c.ch === "\n").length;
        for (let x = 0; x < nl; x++) f.paras.splice(k + 1, 0, JSON.parse(JSON.stringify(f.paras[k] ?? { style: {} })));
      }
      h.text = fromFlat(f);
      return;
    }
    case "deleteText": {
      const h = holder(p, r);
      const f = toFlat(h.text);
      const s = span(r, f.chars.length)[0];
      let e = span(r, f.chars.length)[1];
      if (s === 0 && e >= f.chars.length) {
        delete h.text;
        return;
      }
      if (e >= f.chars.length) e = f.chars.length - 1;
      const k = f.chars.slice(0, s).filter((c) => c.ch === "\n").length;
      const gone = f.chars.slice(s, e).filter((c) => c.ch === "\n").length;
      f.chars.splice(s, e - s);
      f.paras.splice(k + 1, gone);
      h.text = fromFlat(f);
      return;
    }
    case "updateTextStyle": {
      const h = holder(p, r);
      const f = toFlat(h.text);
      const [s, e] = span(r, f.chars.length);
      const memo = new Map<Json, Json>();
      for (let i = s; i < e && i < f.chars.length; i++) {
        const old = f.chars[i].st;
        if (!memo.has(old)) memo.set(old, patch(old, r.style ?? {}, r.fields ?? ""));
        f.chars[i].st = memo.get(old);
      }
      h.text = fromFlat(f);
      return;
    }
    case "updateParagraphStyle": {
      const h = holder(p, r);
      const f = toFlat(h.text);
      const [s, e] = span(r, f.chars.length);
      let k = 0;
      let a = 0;
      for (let i = 0; i < f.chars.length; i++) {
        if (f.chars[i].ch !== "\n") continue;
        if (a <= Math.max(s, e - 1) && i >= s && f.paras[k]) f.paras[k].style = patch(f.paras[k].style, r.style ?? {}, r.fields ?? "");
        k++;
        a = i + 1;
      }
      h.text = fromFlat(f);
      return;
    }
    case "updatePageElementTransform": {
      const f = findEl(p, r.objectId);
      if (!f) return;
      f.el.transform = { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: 0, translateY: 0, unit: "EMU", ...r.transform };
      return;
    }
    case "updateShapeProperties": {
      const f = findEl(p, r.objectId);
      if (f?.el.shape) f.el.shape.shapeProperties = patch(f.el.shape.shapeProperties ?? {}, r.shapeProperties ?? {}, r.fields ?? "");
      return;
    }
    case "createShape":
    case "createLine": {
      const ep = r.elementProperties ?? {};
      const page = slideOf(p, ep.pageObjectId);
      if (!page) return;
      const textbox = r.shapeType === "TEXT_BOX";
      const el: Json = { objectId: r.objectId, size: ep.size, transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "EMU", ...(ep.transform ?? {}) } };
      if (kind === "createLine") el.line = { lineCategory: r.lineCategory ?? "STRAIGHT", lineType: "STRAIGHT_CONNECTOR_1", lineProperties: { lineFill: { solidFill: { color: { themeColor: "DARK1" } } }, weight: { magnitude: 19050, unit: "EMU" } } };
      else
        el.shape = {
          shapeType: r.shapeType,
          shapeProperties: textbox
            ? { shapeBackgroundFill: { propertyState: "NOT_RENDERED" }, outline: { propertyState: "NOT_RENDERED" }, contentAlignment: "TOP" }
            : { shapeBackgroundFill: { solidFill: { color: { themeColor: "ACCENT1" }, alpha: 1 } }, outline: { outlineFill: { solidFill: { color: { themeColor: "DARK2" } } }, weight: { magnitude: 9525, unit: "EMU" } }, contentAlignment: "MIDDLE" },
        };
      page.pageElements = [...(page.pageElements ?? []), el];
      return;
    }
    case "deleteObject": {
      const s = slideOf(p, r.objectId);
      if (s) {
        p.slides = p.slides.filter((x: Json) => x !== s);
        return;
      }
      const f = findEl(p, r.objectId);
      if (f) f.list.splice(f.list.indexOf(f.el), 1);
      return;
    }
    case "updateSlidesPosition": {
      const ids: string[] = r.slideObjectIds ?? [];
      const moving = ids.map((id) => slideOf(p, id)).filter(Boolean);
      const at = r.insertionIndex ?? 0;
      const before = p.slides.slice(0, at).filter((s: Json) => ids.includes(s.objectId)).length;
      p.slides = p.slides.filter((s: Json) => !ids.includes(s.objectId));
      p.slides.splice(at - before, 0, ...moving);
      return;
    }
    default:
      throw new Error(`${kind} isn't applied locally`);
  }
}

const range = (s: number, e: number) => ({ type: "FIXED_RANGE", startIndex: s, endIndex: e });

/** The requests that undo `req`, worked out before it's applied; null when it can't be undone here. */
export function invert(p: Json, req: Req): Req[] | null {
  const kind = Object.keys(req)[0];
  const r = req[kind];
  const at = r.cellLocation ? { cellLocation: r.cellLocation } : {};
  switch (kind) {
    case "insertText": {
      const f = toFlat(holder(p, r)?.text);
      if (!f.chars.length) return [{ deleteText: { objectId: r.objectId, ...at, textRange: { type: "ALL" } } }];
      return [{ deleteText: { objectId: r.objectId, ...at, textRange: range(r.insertionIndex ?? 0, (r.insertionIndex ?? 0) + String(r.text).length) } }];
    }
    case "deleteText": {
      const f = toFlat(holder(p, r)?.text);
      const s = span(r, f.chars.length)[0];
      let e = span(r, f.chars.length)[1];
      if (e >= f.chars.length) e = Math.max(s, f.chars.length - 1);
      const gone = f.chars.slice(s, e);
      if (!gone.length) return [];
      const out: Req[] = [{ insertText: { objectId: r.objectId, ...at, insertionIndex: s, text: gone.map((c) => c.ch).join("") } }];
      for (let a = 0; a < gone.length; ) {
        let b = a + 1;
        while (b < gone.length && gone[b].st === gone[a].st) b++;
        out.push({ updateTextStyle: { objectId: r.objectId, ...at, textRange: range(s + a, s + b), style: pickPath(gone[a].st, TS_FIELDS), fields: TS_FIELDS } });
        a = b;
      }
      return out;
    }
    case "updateTextStyle": {
      const f = toFlat(holder(p, r)?.text);
      const [s, e] = span(r, f.chars.length);
      const out: Req[] = [];
      for (let a = s; a < e; ) {
        let b = a + 1;
        while (b < e && f.chars[b].st === f.chars[a].st) b++;
        out.push({ updateTextStyle: { objectId: r.objectId, ...at, textRange: range(a, b), style: pickPath(f.chars[a].st, r.fields), fields: r.fields } });
        a = b;
      }
      return out;
    }
    case "updateParagraphStyle": {
      const f = toFlat(holder(p, r)?.text);
      const [s, e] = span(r, f.chars.length);
      const out: Req[] = [];
      let k = 0;
      let a = 0;
      for (let i = 0; i < f.chars.length; i++) {
        if (f.chars[i].ch !== "\n") continue;
        if (a <= Math.max(s, e - 1) && i >= s) out.push({ updateParagraphStyle: { objectId: r.objectId, ...at, textRange: range(a, i + 1), style: pickPath(f.paras[k]?.style, r.fields), fields: r.fields } });
        k++;
        a = i + 1;
      }
      return out;
    }
    case "updatePageElementTransform": {
      const f = findEl(p, r.objectId);
      return f ? [{ updatePageElementTransform: { objectId: r.objectId, applyMode: "ABSOLUTE", transform: { ...f.el.transform } } }] : null;
    }
    case "updateShapeProperties": {
      const f = findEl(p, r.objectId);
      if (!f?.el.shape) return null;
      return [{ updateShapeProperties: { objectId: r.objectId, shapeProperties: pickPath(f.el.shape.shapeProperties, r.fields), fields: r.fields } }];
    }
    case "createShape":
    case "createLine":
      return [{ deleteObject: { objectId: r.objectId } }];
    case "deleteObject": {
      if (slideOf(p, r.objectId)) return null;
      const f = findEl(p, r.objectId);
      const el = f?.el;
      // Shapes and text boxes can be put back; images, tables, lines and groups can't exactly.
      if (!f || !el?.shape || el.shape.placeholder || !f.page?.objectId || !slideOf(p, f.page.objectId)) return null;
      const out: Req[] = [{ createShape: { objectId: el.objectId, shapeType: el.shape.shapeType, elementProperties: { pageObjectId: f.page.objectId, size: el.size, transform: el.transform } } }];
      if (el.shape.shapeProperties) {
        const fields = ["shapeBackgroundFill", "outline", "contentAlignment"].filter((k) => el.shape.shapeProperties[k] !== undefined && el.shape.shapeProperties[k]?.propertyState !== "INHERIT").join(",");
        if (fields) out.push({ updateShapeProperties: { objectId: el.objectId, shapeProperties: pickPath(el.shape.shapeProperties, fields), fields } });
      }
      const t = toFlat(el.shape.text);
      if (t.chars.length) {
        const text = t.chars.map((c) => c.ch).join("");
        out.push({ insertText: { objectId: el.objectId, insertionIndex: 0, text: text.endsWith("\n") ? text.slice(0, -1) : text } });
        for (let a = 0; a < t.chars.length - 1; ) {
          let b = a + 1;
          while (b < t.chars.length - 1 && t.chars[b].st === t.chars[a].st) b++;
          out.push({ updateTextStyle: { objectId: el.objectId, textRange: range(a, b), style: pickPath(t.chars[a].st, TS_FIELDS), fields: TS_FIELDS } });
          a = b;
        }
        let k = 0;
        let a = 0;
        for (let i = 0; i < t.chars.length; i++) {
          if (t.chars[i].ch !== "\n") continue;
          const al = t.paras[k]?.style?.alignment;
          if (al) out.push({ updateParagraphStyle: { objectId: el.objectId, textRange: range(a, i + 1), style: { alignment: al }, fields: "alignment" } });
          k++;
          a = i + 1;
        }
      }
      return out;
    }
    case "updateSlidesPosition": {
      const ids: string[] = r.slideObjectIds ?? [];
      if (ids.length !== 1) return null;
      const from = (p.slides ?? []).findIndex((s: Json) => s.objectId === ids[0]);
      const at = r.insertionIndex ?? 0;
      const to = at > from ? at - 1 : at;
      return [{ updateSlidesPosition: { slideObjectIds: ids, insertionIndex: from > to ? from + 1 : from } }];
    }
  }
  return null;
}

/** Object ids a request touches (to see whether someone else changed the same thing). */
export function touches(req: Req): string[] {
  const kind = Object.keys(req)[0];
  const r = req[kind];
  if (kind === "updateSlidesPosition") return ["#order", ...(r.slideObjectIds ?? [])];
  if (r?.tableObjectId) return [r.tableObjectId];
  if (r?.objectId) return [r.objectId];
  if (r?.elementProperties?.pageObjectId) return [r.elementProperties.pageObjectId];
  return [];
}

// ── Geometry ──
export type Tf = { scaleX?: number; scaleY?: number; shearX?: number; shearY?: number; translateX?: number; translateY?: number; unit?: string };
const unitK = (t: Tf) => (t.unit === "PT" ? PT_EMU : 1);
/** parent ∘ child, as Google composes group transforms. */
export function compose(a: Tf, b: Tf): Tf {
  const ka = unitK(a);
  const kb = unitK(b);
  const [a1, b1, c1, d1, e1, f1] = [a.scaleX ?? 1, a.shearY ?? 0, a.shearX ?? 0, a.scaleY ?? 1, (a.translateX ?? 0) * ka, (a.translateY ?? 0) * ka];
  const [a2, b2, c2, d2, e2, f2] = [b.scaleX ?? 1, b.shearY ?? 0, b.shearX ?? 0, b.scaleY ?? 1, (b.translateX ?? 0) * kb, (b.translateY ?? 0) * kb];
  return { scaleX: a1 * a2 + c1 * b2, shearY: b1 * a2 + d1 * b2, shearX: a1 * c2 + c1 * d2, scaleY: b1 * c2 + d1 * d2, translateX: a1 * e2 + c1 * f2 + e1, translateY: b1 * e2 + d1 * f2 + f1, unit: "EMU" };
}
const dim = (d: Json) => (d ? (d.magnitude ?? 0) * (d.unit === "PT" ? PT_EMU : 1) : 0);
/** Where an element is drawn: top-left corner, size (EMU) and rotation. */
export function boxOf(t: Tf, size: Json) {
  const k = unitK(t);
  const a = t.scaleX ?? 1;
  const b = t.shearY ?? 0;
  const c = t.shearX ?? 0;
  const d = t.scaleY ?? 1;
  const sx = Math.hypot(a, b) || 1e-9;
  const det = a * d - b * c;
  const sy = det / sx;
  return { x: (t.translateX ?? 0) * k, y: (t.translateY ?? 0) * k, w: dim(size?.width) * sx, h: dim(size?.height) * Math.abs(sy), rot: (Math.atan2(b, a) * 180) / Math.PI, flip: det < 0, w0: dim(size?.width), h0: dim(size?.height) };
}

// ── Inheritance: placeholders take their look from the layout and master ──
export function parentOf(p: Json, el: Json): Json | null {
  const id = el?.shape?.placeholder?.parentObjectId;
  if (!id) return null;
  for (const pg of [...(p.layouts ?? []), ...(p.masters ?? [])]) for (const x of pg.pageElements ?? []) if (x.objectId === id) return x;
  return null;
}
export function shapeProps(p: Json, el: Json, depth = 0): Json {
  const own = el?.shape?.shapeProperties ?? {};
  const par = depth < 4 ? parentOf(p, el) : null;
  if (!par) return own;
  const up = shapeProps(p, par, depth + 1);
  const out: Json = { ...up };
  for (const [k, v] of Object.entries(own)) if (!(v && typeof v === "object" && (v as Json).propertyState === "INHERIT")) out[k] = v;
  return out;
}
/** The text and paragraph style a placeholder's text starts from. */
export function baseStyle(p: Json, el: Json, depth = 0): { ts: Json; ps: Json } {
  const par = depth < 4 ? parentOf(p, el) : null;
  const up = par ? baseStyle(p, par, depth + 1) : { ts: {}, ps: {} };
  if (!par) return up;
  const els = par.shape?.text?.textElements ?? [];
  const run = els.find((x: Json) => x.textRun)?.textRun?.style ?? {};
  const pm = els.find((x: Json) => x.paragraphMarker)?.paragraphMarker?.style ?? {};
  return { ts: { ...up.ts, ...run }, ps: { ...up.ps, ...pm } };
}
export function masterOf(p: Json, page: Json) {
  const mid = page?.slideProperties?.masterObjectId ?? (p.layouts ?? []).find((l: Json) => l.objectId === page?.slideProperties?.layoutObjectId)?.layoutProperties?.masterObjectId;
  return (p.masters ?? []).find((m: Json) => m.objectId === mid) ?? p.masters?.[0];
}
export function layoutOf(p: Json, page: Json) {
  return (p.layouts ?? []).find((l: Json) => l.objectId === page?.slideProperties?.layoutObjectId) ?? null;
}
/** A colour as CSS, with theme colours from the slide's master. */
export function cssColor(p: Json, page: Json, c: Json, alpha?: number): string | undefined {
  const col = c?.opaqueColor ?? c;
  let rgb = col?.rgbColor;
  if (!rgb && col?.themeColor) rgb = masterOf(p, page)?.pageProperties?.colorScheme?.colors?.find((x: Json) => x.type === col.themeColor)?.color;
  if (!rgb) return col && Object.keys(col).length === 0 ? "#000000" : undefined;
  const h = (v?: number) => Math.round((v ?? 0) * 255);
  const a = alpha ?? 1;
  return a < 1 ? `rgba(${h(rgb.red)},${h(rgb.green)},${h(rgb.blue)},${a})` : `rgb(${h(rgb.red)},${h(rgb.green)},${h(rgb.blue)})`;
}
export function background(p: Json, page: Json): { color?: string; image?: string } {
  const chain = [page, layoutOf(p, page), masterOf(p, page)];
  for (const pg of chain) {
    const f = pg?.pageProperties?.pageBackgroundFill;
    if (!f || f.propertyState === "INHERIT") continue;
    if (f.propertyState === "NOT_RENDERED") return { color: "#ffffff" };
    if (f.stretchedPictureFill?.contentUrl) return { image: f.stretchedPictureFill.contentUrl };
    if (f.solidFill) return { color: cssColor(p, page, f.solidFill.color, f.solidFill.alpha) };
  }
  return { color: "#ffffff" };
}

/** A short hash of a slide as drawn, so its picture from Google is reused until it changes. */
export function slideHash(s: Json) {
  const str = JSON.stringify([s?.pageElements, s?.pageProperties]);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
export const newId = (prefix = "g") => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const SHAPES: [string, string][] = [
  ["RECTANGLE", "Rectangle"],
  ["ROUND_RECTANGLE", "Rounded rectangle"],
  ["ELLIPSE", "Oval"],
  ["TRIANGLE", "Triangle"],
  ["RIGHT_TRIANGLE", "Right triangle"],
  ["DIAMOND", "Diamond"],
  ["PENTAGON", "Pentagon"],
  ["HEXAGON", "Hexagon"],
  ["RIGHT_ARROW", "Right arrow"],
  ["LEFT_ARROW", "Left arrow"],
  ["STAR_5", "Star"],
  ["WEDGE_RECTANGLE_CALLOUT", "Callout"],
];
