/**
 * Text inside a shape or table cell, drawn into a box and mapped to Google's
 * text indexes (one per character, a newline ending each paragraph). The
 * same drawing is used to show the slide and, made editable, to edit it.
 */
import { cssColor, PT_EMU, toFlat, type Json, type TFlat } from "./model";

export type TextLook = { p: Json; page: Json; scale: number; base: { ts: Json; ps: Json }; fontScale?: number };

function runCss(st: Json, look: TextLook): Partial<CSSStyleDeclaration> {
  const ts = { ...look.base.ts, ...st };
  const s: Partial<CSSStyleDeclaration> = {};
  const pt = ts.fontSize?.magnitude ?? 18;
  s.fontSize = `${Math.max(1, pt * PT_EMU * look.scale * (look.fontScale ?? 1))}px`;
  const fam = ts.weightedFontFamily?.fontFamily ?? ts.fontFamily;
  if (fam) s.fontFamily = `"${fam}", Arial, sans-serif`;
  if (ts.bold) s.fontWeight = "700";
  else if (ts.weightedFontFamily?.weight) s.fontWeight = String(ts.weightedFontFamily.weight);
  if (ts.italic) s.fontStyle = "italic";
  const deco = [ts.underline || ts.link ? "underline" : "", ts.strikethrough ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) s.textDecoration = deco;
  const fg = ts.foregroundColor ? cssColor(look.p, look.page, ts.foregroundColor) : undefined;
  s.color = fg ?? (ts.link ? "#1155cc" : "#000000");
  const bg = ts.backgroundColor ? cssColor(look.p, look.page, ts.backgroundColor) : undefined;
  if (bg) s.backgroundColor = bg;
  if (ts.baselineOffset === "SUPERSCRIPT") s.verticalAlign = "super";
  if (ts.baselineOffset === "SUBSCRIPT") s.verticalAlign = "sub";
  if (ts.smallCaps) s.fontVariant = "small-caps";
  return s;
}

/** Draw the text into `root` (replacing what's there). */
export function drawText(root: HTMLElement, text: Json, look: TextLook) {
  const f: TFlat = toFlat(text);
  root.textContent = "";
  let a = 0;
  let k = 0;
  const pts = (d: Json) => (d?.magnitude ?? 0) * PT_EMU * look.scale;
  while (a < f.chars.length || (a === 0 && !f.chars.length)) {
    let b = a;
    while (b < f.chars.length && f.chars[b].ch !== "\n") b++;
    const ps = { ...look.base.ps, ...(f.paras[k]?.style ?? {}) };
    const div = document.createElement("div");
    div.className = "st-p";
    div.dataset.s = String(a);
    const al = ps.alignment;
    div.style.textAlign = al === "CENTER" ? "center" : al === "END" ? "right" : al === "JUSTIFIED" ? "justify" : "left";
    if (typeof ps.lineSpacing === "number") div.style.lineHeight = String((ps.lineSpacing / 100) * 1.2);
    if (ps.spaceAbove) div.style.marginTop = `${pts(ps.spaceAbove)}px`;
    if (ps.spaceBelow) div.style.marginBottom = `${pts(ps.spaceBelow)}px`;
    if (ps.indentStart) div.style.paddingLeft = `${pts(ps.indentStart)}px`;
    const bullet = f.paras[k]?.bullet;
    if (bullet?.glyph) {
      const g = document.createElement("span");
      g.className = "st-b";
      g.contentEditable = "false";
      g.textContent = `${bullet.glyph} `;
      Object.assign(g.style, runCss({ ...(f.chars[a]?.st ?? {}), ...(bullet.bulletStyle ?? {}) }, look));
      div.appendChild(g);
    }
    for (let x = a; x < b; ) {
      let y = x + 1;
      while (y < b && f.chars[y].st === f.chars[x].st) y++;
      const s = document.createElement("span");
      s.dataset.o = String(x);
      Object.assign(s.style, runCss(f.chars[x].st, look));
      s.textContent = f.chars
        .slice(x, y)
        .map((c) => c.ch)
        .join("")
        .replace(/\u000b/g, "\n");
      div.appendChild(s);
      x = y;
    }
    if (a === b) {
      // An empty line still has the height of its text.
      const s = document.createElement("span");
      Object.assign(s.style, runCss(f.chars[a]?.st ?? f.chars[a - 1]?.st ?? {}, look));
      s.className = "st-empty";
      s.appendChild(document.createElement("br"));
      div.appendChild(s);
    }
    root.appendChild(div);
    k++;
    a = b + 1;
    if (b >= f.chars.length - 1) break;
  }
}

/** The text index for a DOM point inside `root`. */
export function posIn(root: HTMLElement, node: Node, off: number): number | null {
  if (!root.contains(node)) return null;
  const el = node.nodeType === 3 ? node.parentElement! : (node as HTMLElement);
  const para = el.closest<HTMLElement>(".st-p");
  if (!para || !root.contains(para)) {
    // Between paragraphs.
    const kids = Array.from(root.children) as HTMLElement[];
    const p = kids[Math.min(off, kids.length - 1)];
    if (!p) return 0;
    return off >= kids.length ? endOf(p) : Number(p.dataset.s);
  }
  const s = Number(para.dataset.s);
  if (node === para) {
    let at = s;
    for (let k = 0; k < off; k++) {
      const c = para.childNodes[k] as HTMLElement;
      if (c?.dataset?.o !== undefined) at = Number(c.dataset.o) + (c.textContent ?? "").length;
    }
    return at;
  }
  const span = el.closest<HTMLElement>("[data-o]");
  if (!span) return s;
  if (node.nodeType === 3) return Number(span.dataset.o) + off;
  return Number(span.dataset.o) + (off > 0 ? (span.textContent ?? "").length : 0);
}
function endOf(p: HTMLElement) {
  let at = Number(p.dataset.s);
  for (const c of Array.from(p.children) as HTMLElement[]) if (c.dataset.o !== undefined) at = Number(c.dataset.o) + (c.textContent ?? "").length;
  return at;
}
/** A DOM point for text index i. */
export function pointIn(root: HTMLElement, i: number): [Node, number] | null {
  const paras = Array.from(root.children) as HTMLElement[];
  let p = paras[0];
  for (const x of paras) if (Number(x.dataset.s) <= i) p = x;
  if (!p) return null;
  for (const c of Array.from(p.children) as HTMLElement[]) {
    if (c.dataset.o === undefined) continue;
    const o = Number(c.dataset.o);
    const len = (c.textContent ?? "").length;
    if (i >= o && i <= o + len && c.firstChild) return [c.firstChild, i - o];
  }
  const empty = p.querySelector(".st-empty");
  if (empty) return [empty, 0];
  return [p, p.childNodes.length];
}
export function selIn(root: HTMLElement): { a: number; f: number } | null {
  const s = window.getSelection();
  if (!s?.anchorNode || !root.contains(s.anchorNode)) return null;
  const a = posIn(root, s.anchorNode, s.anchorOffset);
  const f = s.focusNode ? posIn(root, s.focusNode, s.focusOffset) : a;
  return a === null || f === null ? null : { a, f };
}
export function setSelIn(root: HTMLElement, a: number, f = a) {
  const pa = pointIn(root, a);
  const pf = pointIn(root, f);
  const s = window.getSelection();
  if (!pa || !pf || !s) return;
  try {
    s.setBaseAndExtent(pa[0], pa[1], pf[0], pf[1]);
  } catch {}
}
/** What the browser now shows, as text (paragraphs joined by newlines). */
export function domPlain(root: HTMLElement) {
  return (Array.from(root.children) as HTMLElement[])
    .map((p) =>
      Array.from(p.childNodes)
        .filter((n) => !(n as HTMLElement).classList?.contains("st-b"))
        .map((n) => (n.textContent ?? "").replace(/\n/g, "\u000b"))
        .join("")
        .replace(/ /g, " "),
    )
    .join("\n");
}
