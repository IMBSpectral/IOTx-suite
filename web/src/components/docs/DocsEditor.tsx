"use client";

import "../sheets/sheets.css";
import "./docs.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
  Baseline,
  Bold,
  ChevronDown,
  CloudCheck,
  CloudOff,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  LoaderCircle,
  Lock,
  MessageSquare,
  PanelLeft,
  Pencil,
  Plus,
  Printer,
  Redo2,
  RemoveFormatting,
  Search,
  Sparkles,
  Star,
  Strikethrough,
  Table,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Trash,
  Underline,
  Undo2,
  X,
} from "lucide-react";
import { usePerms } from "@/components/iotx/PermsProvider";
import { Dropdown, useDismiss, type Item } from "../sheets/Menu";
import { Palette, ZOOMS } from "../sheets/Toolbar";
import { FONTS, fromHex } from "../sheets/model";
import { DocEngine } from "./engine";
import { DocView, modelText, runCss } from "./view";
import {
  canInsert,
  cellAt,
  checkDelete,
  DEFAULT_NAMED,
  isText,
  mapIndex,
  newlineOf,
  paraAt,
  parasIn,
  presetOf,
  pt,
  rgbOf,
  STYLE_NAMES,
  styleAt,
  tableEnd,
  textOf,
  wordCount,
  type Flat,
  type Json,
  type Req,
  type Tok,
  type TS,
} from "./model";

type Sel = { a: number; f: number };
type Dialog = null | { kind: "find"; replace: boolean } | { kind: "link" } | { kind: "image" } | { kind: "count" } | { kind: "trash" };
const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
const SPACING: [number, string][] = [
  [100, "Single"],
  [115, "1.15"],
  [150, "1.5"],
  [200, "Double"],
];
const PRESET = { bullet: "BULLET_DISC_CIRCLE_SQUARE", number: "NUMBERED_DECIMAL_ALPHA_ROMAN", check: "BULLET_CHECKBOX" } as const;
const CLEAR = "bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset";
const ord = (s: Sel) => ({ s: Math.min(s.a, s.f), e: Math.max(s.a, s.f) });
const range = (s: number, e: number) => ({ startIndex: s, endIndex: e });

/** Stretches of plain text in [s, e) (not table markers, chips or suggestions): style requests go to these. */
function textSegs(t: Tok[], s: number, e: number) {
  const out: [number, number][] = [];
  let a = -1;
  for (let i = s; i < e; i++) {
    const tk = t[i];
    const ok = isText(tk) && tk.k !== "x" && !tk.ro && !tk.sug;
    if (ok && a < 0) a = i;
    if (!ok && a >= 0) (out.push([a, i]), (a = -1));
  }
  if (a >= 0) out.push([a, e]);
  return out;
}
/** Neighbouring paragraphs in [s, e), grouped so no request spans a table edge. */
function paraGroups(t: Tok[], s: number, e: number) {
  const out: [number, number][] = [];
  for (const [a, b] of parasIn(t, s, e)) {
    if ((t[b - 1] as { ro?: 1 }).ro) continue;
    const last = out[out.length - 1];
    if (last && last[1] === a) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

/** The named styles' look, as CSS for the page (Google's defaults where the document doesn't say). */
function namedCss(f: Flat) {
  const normal = f.named.NORMAL_TEXT?.ts ?? {};
  return Object.entries(DEFAULT_NAMED)
    .map(([ns, d]) => {
      const n = f.named[ns];
      const ts = ns === "NORMAL_TEXT" ? normal : { ...normal, ...(n?.ts ?? {}) };
      const css = runCss(ts) as Record<string, string>;
      const ps = n?.ps ?? {};
      const decl: string[] = [];
      decl.push(`font-size:${css.fontSize ?? `${d.size}pt`}`);
      if (css.fontFamily) decl.push(`font-family:${css.fontFamily}`);
      if (css.color || d.color) decl.push(`color:${css.color ?? d.color}`);
      if (css.fontWeight || d.bold) decl.push(`font-weight:${css.fontWeight ?? 700}`);
      if (css.fontStyle || d.italic) decl.push(`font-style:${css.fontStyle ?? "italic"}`);
      decl.push(`margin-top:${pt(ps.spaceAbove) ?? d.above}pt`, `margin-bottom:${pt(ps.spaceBelow) ?? d.below}pt`);
      if (typeof ps.lineSpacing === "number") decl.push(`line-height:${(ps.lineSpacing / 100) * 1.15}`);
      return `.dx-page .dx-ns-${ns}{${decl.join(";")}}`;
    })
    .join("\n");
}

/**
 * A Google Doc, edited the way Google Docs does it: title, menus, toolbar,
 * the outline, and the white page. Typing, deleting and formatting are shown
 * at once and saved through documents.batchUpdate in batches; tables, images
 * and page breaks are saved straight away and the page waits for Google's
 * copy. Suggestions, comments, drawings, equations and smart chips show read only.
 */
export default function DocsEditor({ id }: { id: string }) {
  const router = useRouter();
  const perms = usePerms();
  const [ver, setVer] = useState(0);
  const [eng] = useState(() => new DocEngine(id, () => setVer((v) => v + 1)));
  const meta = eng.meta;
  const doc = eng.view;
  const [selUi, setSelUi] = useState<Sel | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToastText] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | "fit">(1);
  const [outline, setOutline] = useState(true);
  const [comments, setComments] = useState<Json[] | null | "loading">(null);
  const [height, setHeight] = useState<number | null>(null);
  const [imgSel, setImgSel] = useState<number | null>(null);
  const [fitW, setFitW] = useState(0);
  const [focused, setFocused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const viewRef = useRef<DocView | null>(null);
  const selRef = useRef<Sel | null>(null);
  /** Formatting chosen with nothing selected: applied to what's typed next at that spot. */
  const carry = useRef<{ ts: TS; fields: string[]; at: number } | null>(null);
  const afterReload = useRef<number | null>(null);

  const say = useCallback((text: string) => {
    setToastText(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(null), 4500);
  }, []);

  // Load, then keep in step with others' edits: every 20 seconds and when the window regains focus.
  useEffect(() => {
    eng.onNotice = say;
    eng.onMoved = (g) => {
      // After a table, image or page break, the caret goes where Google's copy puts the new content.
      if (afterReload.current !== null && !eng.locked) {
        const i = afterReload.current;
        afterReload.current = null;
        selRef.current = { a: i, f: i };
        return;
      }
      const s = selRef.current;
      if (s && g) selRef.current = { a: mapIndex(s.a, g, true)!, f: mapIndex(s.f, g, true)! };
    };
    void eng.open(true);
    const t = setInterval(() => void eng.refresh(), 20_000);
    const focus = () => void eng.refresh();
    window.addEventListener("focus", focus);
    const leave = (e: BeforeUnloadEvent) => {
      if (eng.busy) e.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", focus);
      window.removeEventListener("beforeunload", leave);
      void eng.flush();
    };
  }, [eng, say]);

  // Fill the space below whatever bar sits above the editor.
  const opened = !!meta && !!doc;
  useEffect(() => {
    if (!opened) return;
    const fit = () => {
      const el = root.current;
      if (el) setHeight(Math.max(320, Math.floor(window.innerHeight - el.getBoundingClientRect().top)));
      if (canvas.current) setFitW(canvas.current.clientWidth);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    if (root.current) ro.observe(root.current.parentElement ?? root.current);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [opened]);

  const readOnly = !meta?.canEdit || !!doc?.unsafe;
  const ro = readOnly || eng.locked;

  // ── Drawing the page, and keeping the caret where it was ──
  useLayoutEffect(() => {
    if (!doc || !page.current) return;
    if (!viewRef.current || viewRef.current.root !== page.current) viewRef.current = new DocView(page.current);
    const v = viewRef.current;
    if (eng.composing) return;
    v.render(doc);
    const hs = doc.docStyle;
    const hid = hs.useFirstPageHeaderFooter && hs.firstPageHeaderId ? hs.firstPageHeaderId : hs.defaultHeaderId;
    const fid = hs.useFirstPageHeaderFooter && hs.firstPageFooterId ? hs.firstPageFooterId : hs.defaultFooterId;
    if (headerRef.current) v.render(doc, { toks: doc.headers[hid] ?? [], into: headerRef.current, inert: true });
    if (footerRef.current) v.render(doc, { toks: doc.footers[fid] ?? [], into: footerRef.current, inert: true });
    page.current.querySelectorAll(".dx-io.sel").forEach((n) => n.classList.remove("sel"));
    if (imgSel !== null) {
      const k = v.paraIndex(imgSel);
      v.paras[k]?.querySelector(`.dx-io[data-o="${imgSel - v.starts[k]}"]`)?.classList.add("sel");
    }
    // Put the caret back after a redraw, unless the person is typing somewhere else (the title, a dialog).
    const s = selRef.current;
    const active = document.activeElement;
    const chrome = !!active && !!root.current?.querySelector(".sx-toolbar")?.contains(active);
    if (s && !readOnly && (active === page.current || active === document.body || chrome)) {
      if (active === document.body) page.current.focus({ preventScroll: true });
      v.setSel(s.a, s.f);
    }
  }, [doc, ver, eng, imgSel, readOnly]);

  // Track the selection for the toolbar.
  useEffect(() => {
    let raf = 0;
    const onSel = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const s = viewRef.current?.getSel();
        if (!s) return;
        if (carry.current && carry.current.at !== Math.min(s.a, s.f)) carry.current = null;
        selRef.current = s;
        setSelUi((old) => (old && old.a === s.a && old.f === s.f ? old : s));
      });
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      cancelAnimationFrame(raf);
    };
  }, []);

  // ── Selection helpers ──
  const toks = () => eng.view!.toks;
  function sel(): { s: number; e: number; a: number; f: number } {
    const live = viewRef.current?.getSel();
    if (live) selRef.current = live;
    const x = selRef.current ?? { a: 1, f: 1 };
    return { ...ord(x), ...x };
  }
  function caret(i: number, j = i) {
    selRef.current = { a: i, f: j };
    setSelUi({ a: i, f: j });
  }
  function guard() {
    if (readOnly) return say("This document is view only here."), false;
    if (eng.locked) return say("Saving to Google… one moment."), false;
    return true;
  }
  const run = (label: string, reqs: Req[], group?: string) => (reqs.length ? eng.run(label, reqs, group) : false);

  // ── Typing and deleting ──
  function typeText(text: string, label = "Typing") {
    if (!guard() || !doc) return;
    const { s, e } = sel();
    const t = toks();
    const reqs: Req[] = [];
    let at = s;
    if (s < e) {
      const d = checkDelete(t, s, e);
      if (typeof d === "string") return say(d);
      reqs.push({ deleteContentRange: { range: range(d.s, d.e) } });
      at = d.s;
    }
    const why = canInsert(t, at);
    if (why) return say(why);
    const clean = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000c\u000e-\u001f]/g, "");
    if (!clean) return;
    // Enter on an empty list item ends the list, as in Docs.
    const [ps, pe] = paraAt(t, at);
    const nl = newlineOf(t, at);
    if (clean === "\n" && s === e && nl?.bullet && pe - ps === 1) return void run("Remove bullet", [{ deleteParagraphBullets: { range: range(ps, pe) } }]);
    reqs.push({ insertText: { location: { index: at }, text: clean } });
    const c = carry.current;
    if (c && c.at === s) reqs.push({ updateTextStyle: { range: range(at, at + clean.length), textStyle: c.ts, fields: c.fields.join(",") } });
    // A new line after a heading is normal text.
    if (clean === "\n" && at === pe - 1 && nl && /^(HEADING_|TITLE|SUBTITLE)/.test(nl.ps?.namedStyleType ?? "")) reqs.push({ updateParagraphStyle: { range: range(at + 1, at + 2), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
    if (run(label, reqs, s < e || clean.length > 1 || c ? undefined : "type")) {
      caret(at + clean.length);
      if (c) carry.current = { ...c, at: at + clean.length };
    }
  }

  function deleteDir(back: boolean, unit: "char" | "word" | "line" = "char") {
    if (!guard() || !doc) return;
    const { s, e } = sel();
    const t = toks();
    let a = s;
    let b = e;
    if (s === e) {
      const [ps, pe] = paraAt(t, s);
      if (back) {
        if (s === ps) {
          const nl = newlineOf(t, s);
          if (nl?.bullet) return void run("Remove bullet", [{ deleteParagraphBullets: { range: range(ps, pe) } }]);
          if (pt(nl?.ps?.indentStart) && !nl?.bullet) return void run("Decrease indent", [{ updateParagraphStyle: { range: range(ps, pe), paragraphStyle: { indentStart: { magnitude: Math.max(0, pt(nl!.ps.indentStart)! - 36), unit: "PT" }, indentFirstLine: { magnitude: Math.max(0, (pt(nl!.ps.indentFirstLine) ?? 0) - 36), unit: "PT" } }, fields: "indentStart,indentFirstLine" } }]);
          if (s <= 1 || !isText(t[s - 1])) return;
        }
        a = s - 1;
        if (unit === "word") {
          const txt = modelText(t, ps, s);
          const m = /\S*\s*$/.exec(txt.slice(0, s - ps));
          a = s - Math.max(1, m?.[0].length ?? 1);
        } else if (unit === "line") a = Math.min(s - 1, ps);
        const lo = (t[a] as { ch?: string })?.ch;
        if (unit === "char" && lo && /[\udc00-\udfff]/.test(lo) && a > ps) a--;
      } else {
        if (t[s]?.k === "n" && !isText(t[s + 1])) return;
        b = s + 1;
        if (unit === "word") {
          const txt = modelText(t, s, pe - 1);
          const m = /^\S*\s*/.exec(txt);
          b = s + Math.max(1, m?.[0].length ?? 1);
        }
        const hi = (t[s] as { ch?: string })?.ch;
        if (unit === "char" && hi && /[\ud800-\udbff]/.test(hi)) b++;
      }
    }
    const d = checkDelete(t, a, b);
    if (typeof d === "string") return say(d);
    if (d.s >= d.e) return;
    if (run("Delete", [{ deleteContentRange: { range: range(d.s, d.e) } }], s === e ? (back ? "del" : "fdel") : undefined)) caret(d.s);
  }

  /** After the browser typed by itself (IME, some phone keyboards): read the paragraph back and save the difference. */
  function syncFromDom() {
    const v = viewRef.current;
    const s = window.getSelection();
    if (!v || !doc || !s?.anchorNode) return;
    const p = (s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : (s.anchorNode as Element))?.closest<HTMLElement>("[data-p]");
    if (!p || !page.current?.contains(p)) return setVer((x) => x + 1);
    const t = toks();
    const [ps, pe] = paraAt(t, Number(p.dataset.p));
    const now = v.domText(p);
    const was = modelText(t, ps, pe - 1);
    v.dirty.add(p);
    if (now === was) return setVer((x) => x + 1);
    let pre = 0;
    while (pre < now.length && pre < was.length && now[pre] === was[pre]) pre++;
    let suf = 0;
    while (suf < now.length - pre && suf < was.length - pre && now[now.length - 1 - suf] === was[was.length - 1 - suf]) suf++;
    const ins = now.slice(pre, now.length - suf);
    const reqs: Req[] = [];
    if (was.length - suf > pre) {
      const d = checkDelete(t, ps + pre, ps + was.length - suf);
      if (typeof d === "string") return say(d), setVer((x) => x + 1);
      reqs.push({ deleteContentRange: { range: range(d.s, d.e) } });
    }
    if (ins.includes("￼")) return setVer((x) => x + 1);
    if (ins) reqs.push({ insertText: { location: { index: ps + pre }, text: ins } });
    if (!guard()) return setVer((x) => x + 1);
    if (run("Typing", reqs, "type")) caret(ps + pre + ins.length);
    else setVer((x) => x + 1);
  }

  // ── Formatting ──
  function curStyle(): TS {
    if (!doc) return {};
    const { s, e } = ord(selUi ?? { a: 1, f: 1 });
    const t = doc.toks;
    const base = s < e ? ((t[s] as { ts?: TS }).ts ?? {}) : styleAt(t, s);
    return carry.current && carry.current.at === s ? { ...base, ...carry.current.ts } : base;
  }
  function setStyle(style: TS, fields: string, label: string) {
    if (!guard() || !doc) return;
    const { s, e } = sel();
    if (s === e) {
      const c = carry.current?.at === s ? carry.current : { ts: {}, fields: [], at: s };
      const ts = { ...c.ts };
      for (const f of fields.split(",")) if (style[f] === undefined) delete ts[f];
      carry.current = { ts: { ...ts, ...style }, fields: [...new Set([...c.fields, ...fields.split(",")])], at: s };
      setVer((v) => v + 1);
      return;
    }
    run(
      label,
      textSegs(toks(), s, e).map(([a, b]) => ({ updateTextStyle: { range: range(a, b), textStyle: style, fields } })),
    );
  }
  const toggle = (field: "bold" | "italic" | "underline" | "strikethrough", label: string) => setStyle({ [field]: !curStyle()[field] }, field, label);
  function baseline(v: "SUPERSCRIPT" | "SUBSCRIPT") {
    setStyle(curStyle().baselineOffset === v ? {} : { baselineOffset: v }, "baselineOffset", v === "SUPERSCRIPT" ? "Superscript" : "Subscript");
  }
  function colour(which: "text" | "highlight", hex: string | null) {
    const field = which === "text" ? "foregroundColor" : "backgroundColor";
    setStyle(hex ? { [field]: { color: { rgbColor: fromHex(hex) } } } : {}, field, which === "text" ? "Text colour" : "Highlight colour");
  }
  function clearFormatting() {
    if (!guard()) return;
    const { s, e } = sel();
    if (s === e) {
      carry.current = null;
      return setVer((v) => v + 1);
    }
    run("Clear formatting", textSegs(toks(), s, e).map(([a, b]) => ({ updateTextStyle: { range: range(a, b), textStyle: {}, fields: CLEAR } })));
  }
  function paraStyle(style: Json, fields: string, label: string) {
    if (!guard()) return;
    const { s, e } = sel();
    run(
      label,
      paraGroups(toks(), s, e).map(([a, b]) => ({ updateParagraphStyle: { range: range(a, b), paragraphStyle: style, fields } })),
    );
  }
  function list(preset: string) {
    if (!guard() || !doc) return;
    const { s, e } = sel();
    const t = toks();
    const groups = paraGroups(t, s, e);
    const nls = parasIn(t, s, e).map(([, b]) => t[b - 1] as Extract<Tok, { k: "n" }>);
    const all = nls.length > 0 && nls.every((n) => n.bullet && presetOf(doc.lists[n.bullet.listId]) === preset);
    const reqs: Req[] = [];
    for (const [a, b] of groups) {
      if (nls.some((n) => n.bullet)) reqs.push({ deleteParagraphBullets: { range: range(a, b) } });
      if (!all) reqs.push({ createParagraphBullets: { range: range(a, b), bulletPreset: preset } });
    }
    run(all ? "Remove list" : preset === PRESET.check ? "Checklist" : preset === PRESET.number ? "Numbered list" : "Bulleted list", reqs);
  }
  /** Indent: list items change nesting level (as Docs does, by re-making the list); other paragraphs move 0.5". */
  function indent(dir: 1 | -1) {
    if (!guard() || !doc) return;
    const { s, e } = sel();
    const t = toks();
    const ps = parasIn(t, s, e);
    const first = t[ps[0]?.[1] - 1] as Extract<Tok, { k: "n" }> | undefined;
    if (first?.bullet) {
      const listId = first.bullet.listId;
      // The whole run of paragraphs in this list, around the selection.
      let a = ps[0][0];
      let b = ps[ps.length - 1][1];
      for (;;) {
        if (a <= 1 || t[a - 1]?.k !== "n") break;
        const [pa] = paraAt(t, a - 1);
        if ((t[a - 1] as Extract<Tok, { k: "n" }>).bullet?.listId !== listId) break;
        a = pa;
      }
      for (;;) {
        if (b >= t.length || !isText(t[b])) break;
        const [, pb] = paraAt(t, b);
        if ((t[pb - 1] as Extract<Tok, { k: "n" }>).bullet?.listId !== listId) break;
        b = pb;
      }
      const block = parasIn(t, a, b);
      const preset = presetOf(doc.lists[listId]);
      const levels = block.map(([pa, pb]) => (t[pb - 1] as Extract<Tok, { k: "n" }>).bullet?.nestingLevel ?? 0);
      const next = block.map(([pa], i) => (pa >= ps[0][0] && pa < ps[ps.length - 1][1] ? Math.max(0, Math.min(8, levels[i] + dir)) : levels[i]));
      if (next.every((l, i) => l === levels[i])) return;
      const remake = (lv: number[]) => {
        const reqs: Req[] = [{ deleteParagraphBullets: { range: range(a, b) } }];
        let extra = 0;
        for (let i = block.length - 1; i >= 0; i--) if (lv[i]) reqs.push({ insertText: { location: { index: block[i][0] }, text: "\t".repeat(lv[i]) } });
        for (const l of lv) extra += l;
        reqs.push({ createParagraphBullets: { range: range(a, b + extra), bulletPreset: preset } });
        return reqs;
      };
      eng.apply({ label: dir > 0 ? "Increase indent" : "Decrease indent", redo: remake(next), undo: remake(levels) });
      return;
    }
    run(
      dir > 0 ? "Increase indent" : "Decrease indent",
      ps
        .filter(([, b]) => !(t[b - 1] as { ro?: 1 }).ro)
        .map(([a, b]) => {
          const n = (t[b - 1] as Extract<Tok, { k: "n" }>).ps ?? {};
          const st = Math.max(0, (pt(n.indentStart) ?? 0) + 36 * dir);
          const fl = Math.max(0, (pt(n.indentFirstLine) ?? 0) + 36 * dir);
          return { updateParagraphStyle: { range: range(a, b), paragraphStyle: { indentStart: { magnitude: st, unit: "PT" }, indentFirstLine: { magnitude: fl, unit: "PT" } }, fields: "indentStart,indentFirstLine" } };
        }),
    );
  }

  // ── Links ──
  /** The link around index i: its extent and URL. */
  function linkAt(i: number) {
    const t = doc?.toks ?? [];
    const at = (t[i] as { ts?: TS })?.ts?.link ? i : (t[i - 1] as { ts?: TS })?.ts?.link ? i - 1 : -1;
    if (at < 0) return null;
    const url = (t[at] as { ts: TS }).ts.link;
    const same = (k: number) => JSON.stringify((t[k] as { ts?: TS })?.ts?.link) === JSON.stringify(url) && t[k]?.k === "c";
    let a = at;
    let b = at + 1;
    while (a > 0 && same(a - 1)) a--;
    while (b < t.length && same(b)) b++;
    return { s: a, e: b, url: url.url as string | undefined };
  }
  function setLink(url: string, text: string) {
    if (!guard() || !doc) return;
    const { s, e } = sel();
    const u = /^[a-z]+:|^#/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    const t = toks();
    const ex = s === e ? linkAt(s) : null;
    if (ex) return void run("Edit link", [{ updateTextStyle: { range: range(ex.s, ex.e), textStyle: { link: { url: u } }, fields: "link" } }]);
    if (s === e) {
      const why = canInsert(t, s);
      if (why) return say(why);
      const label = text.trim() || u;
      if (run("Insert link", [{ insertText: { location: { index: s }, text: label } }, { updateTextStyle: { range: range(s, s + label.length), textStyle: { link: { url: u } }, fields: "link" } }])) caret(s + label.length);
      return;
    }
    run("Insert link", textSegs(t, s, e).map(([a, b]) => ({ updateTextStyle: { range: range(a, b), textStyle: { link: { url: u } }, fields: "link" } })));
  }
  function removeLink() {
    if (!guard()) return;
    const { s, e } = sel();
    const ex = s === e ? linkAt(s) : { s, e };
    if (ex) run("Remove link", textSegs(toks(), ex.s, ex.e).map(([a, b]) => ({ updateTextStyle: { range: range(a, b), textStyle: {}, fields: "link" } })));
  }

  // ── Structural changes: saved at once, then the page shows Google's copy ──
  function structural(label: string, reqs: Req[], fix?: (f: Flat) => Req[] | null) {
    if (!guard()) return false;
    return eng.apply({ label, redo: reqs, undo: null, fix }, { structural: true });
  }
  function insertTable(rows: number, cols: number) {
    const { s } = sel();
    const why = canInsert(toks(), s);
    if (why) return say(why);
    structural("Insert table", [{ insertTable: { rows, columns: cols, location: { index: s } } }], (f) => (f.toks[s + 1]?.k === "ts" ? [{ deleteContentRange: { range: range(s, tableEnd(f.toks, s + 1) + 1) } }] : null));
    afterReload.current = s + 4;
  }
  function tableOp(op: "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "delRow" | "delCol" | "delTable") {
    if (!guard()) return;
    const { s } = sel();
    const c = cellAt(toks(), s);
    if (!c) return say("Put the cursor in a table first.");
    const loc = { tableStartLocation: { index: c.table }, rowIndex: c.row, columnIndex: c.col };
    if (op === "delTable") {
      structural("Delete table", [{ deleteContentRange: { range: range(c.table, tableEnd(toks(), c.table) + 1) } }]);
      caret(c.table);
      return;
    }
    if (op === "rowAbove" || op === "rowBelow") structural("Insert row", [{ insertTableRow: { tableCellLocation: loc, insertBelow: op === "rowBelow" } }], () => [{ deleteTableRow: { tableCellLocation: { ...loc, rowIndex: op === "rowBelow" ? c.row + 1 : c.row } } }]);
    if (op === "colLeft" || op === "colRight") structural("Insert column", [{ insertTableColumn: { tableCellLocation: loc, insertRight: op === "colRight" } }], () => [{ deleteTableColumn: { tableCellLocation: { ...loc, columnIndex: op === "colRight" ? c.col + 1 : c.col } } }]);
    if (op === "delRow") structural("Delete row", [{ deleteTableRow: { tableCellLocation: loc } }]);
    if (op === "delCol") structural("Delete column", [{ deleteTableColumn: { tableCellLocation: loc } }]);
  }
  function pageBreak() {
    const { s } = sel();
    if (cellAt(toks(), s)) return say("Page breaks can't go inside a table.");
    const why = canInsert(toks(), s);
    if (why) return say(why);
    structural("Page break", [{ insertPageBreak: { location: { index: s } } }], (f) => (f.toks[s]?.k === "pb" ? [{ deleteContentRange: { range: range(s, s + 2) } }] : null));
    afterReload.current = s + 2;
  }
  async function insertImage(uri: string, widthPt: number | null) {
    const { s } = sel();
    const why = canInsert(toks(), s);
    if (why) return say(why);
    const ok = structural(
      "Insert image",
      [{ insertInlineImage: { location: { index: s }, uri, ...(widthPt ? { objectSize: { width: { magnitude: Math.round(widthPt), unit: "PT" } } } : {}) } }],
      (f) => (f.toks[s]?.k === "io" ? [{ deleteContentRange: { range: range(s, s + 1) } }] : null),
    );
    if (ok) afterReload.current = s + 1;
  }
  function replaceAll(find: string, rep: string, matchCase: boolean) {
    if (!guard() || !doc || !find) return;
    // Where the matches are now, to undo it afterwards (body text only).
    const t = toks();
    const text = modelText(t, 0, t.length);
    const hay = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? find : find.toLowerCase();
    const hits: number[] = [];
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + Math.max(1, needle.length))) hits.push(i);
    const olds = hits.map((h) => text.slice(h, h + find.length));
    structural("Replace all", [{ replaceAllText: { containsText: { text: find, matchCase }, replaceText: rep } }], (f) => {
      const d = rep.length - find.length;
      const out: Req[] = [];
      for (let k = hits.length - 1; k >= 0; k--) {
        const at = hits[k] + k * d;
        if (modelText(f.toks, at, at + rep.length) !== rep) return null;
        if (rep.length) out.push({ deleteContentRange: { range: range(at, at + rep.length) } });
        out.push({ insertText: { location: { index: at }, text: olds[k] } });
      }
      return out.length ? out : null;
    });
    say(hits.length ? `Replacing ${hits.length} match${hits.length === 1 ? "" : "es"}…` : `"${find}" wasn't found in the body; Google will also look in headers and footers.`);
  }
  function findNext(find: string, matchCase: boolean, back = false) {
    if (!doc || !find) return false;
    const t = doc.toks;
    const text = modelText(t, 0, t.length);
    const hay = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? find : find.toLowerCase();
    const { s, e } = sel();
    let i = back ? hay.lastIndexOf(needle, s - 1) : hay.indexOf(needle, e);
    if (i < 0) i = back ? hay.lastIndexOf(needle) : hay.indexOf(needle);
    if (i < 0) return say(`"${find}" wasn't found.`), false;
    caret(i, i + find.length);
    page.current?.focus();
    viewRef.current?.setSel(i, i + find.length);
    viewRef.current?.point(i)?.[0].parentElement?.scrollIntoView({ block: "center" });
    return true;
  }

  // ── Undo ──
  /** The caret after undoing or redoing: after the last text put in, or where the last text went. */
  function caretAfter(reqs: Req[]) {
    for (let k = reqs.length - 1; k >= 0; k--) {
      const r = reqs[k];
      if (r.insertText) return caret(r.insertText.location.index + r.insertText.text.length);
      if (r.deleteContentRange) return caret(r.deleteContentRange.range.startIndex);
    }
  }
  function undo() {
    if (!guard()) return;
    const e = eng.undo();
    if (!e) return say("Nothing to undo.");
    caretAfter(e.undo ?? []);
  }
  function redo() {
    if (!guard()) return;
    const e = eng.redo();
    if (!e) return say("Nothing to redo.");
    caretAfter(e.redo);
  }

  // ── Keys and input events (kept current for the native listeners) ──
  const handlers = useRef({ beforeInput: (_e: InputEvent) => {}, sync: () => {} });
  handlers.current = {
    beforeInput: (e: InputEvent) => {
      if (eng.composing || e.isComposing || e.inputType === "insertCompositionText") return;
      e.preventDefault();
      switch (e.inputType) {
        case "insertText":
        case "insertReplacementText":
          return typeText(e.data ?? e.dataTransfer?.getData("text/plain") ?? "");
        case "insertParagraph":
          return typeText("\n");
        case "insertLineBreak":
          return typeText("\u000b");
        case "insertFromPaste":
          return typeText(e.dataTransfer?.getData("text/plain") ?? "", "Paste");
        case "deleteContentBackward":
          return deleteDir(true);
        case "deleteContentForward":
          return deleteDir(false);
        case "deleteWordBackward":
          return deleteDir(true, "word");
        case "deleteWordForward":
          return deleteDir(false, "word");
        case "deleteSoftLineBackward":
        case "deleteHardLineBackward":
          return deleteDir(true, "line");
        case "deleteByCut":
        case "deleteContent":
          return deleteDir(true);
        case "historyUndo":
          return undo();
        case "historyRedo":
          return redo();
        case "formatBold":
          return toggle("bold", "Bold");
        case "formatItalic":
          return toggle("italic", "Italic");
        case "formatUnderline":
          return toggle("underline", "Underline");
        default:
          return;
      }
    },
    sync: syncFromDom,
  };
  useEffect(() => {
    const el = page.current;
    if (!el || !opened) return;
    const bi = (e: Event) => handlers.current.beforeInput(e as InputEvent);
    const start = () => (eng.composing = true);
    const end = () => {
      eng.composing = false;
      handlers.current.sync();
    };
    const input = (e: Event) => {
      if (!(e as InputEvent).isComposing && !eng.composing) handlers.current.sync();
    };
    el.addEventListener("beforeinput", bi);
    el.addEventListener("compositionstart", start);
    el.addEventListener("compositionend", end);
    el.addEventListener("input", input);
    return () => {
      el.removeEventListener("beforeinput", bi);
      el.removeEventListener("compositionstart", start);
      el.removeEventListener("compositionend", end);
      el.removeEventListener("input", input);
    };
  }, [opened, eng]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey) {
      if (k === "b") return e.preventDefault(), toggle("bold", "Bold");
      if (k === "i") return e.preventDefault(), toggle("italic", "Italic");
      if (k === "u") return e.preventDefault(), toggle("underline", "Underline");
      if (k === "z") return e.preventDefault(), e.shiftKey ? redo() : undo();
      if (k === "y") return e.preventDefault(), redo();
      if (k === "k") return e.preventDefault(), !ro && setDialog({ kind: "link" });
      if (k === "f") return e.preventDefault(), setDialog({ kind: "find", replace: false });
      if (k === "h") return e.preventDefault(), setDialog({ kind: "find", replace: true });
      if (k === "p") return e.preventDefault(), print();
      if (k === "s") return e.preventDefault(), void eng.flush(), say("Saving to Drive.");
      if (k === "\\") return e.preventDefault(), clearFormatting();
      if (e.shiftKey && k === "c") return e.preventDefault(), setDialog({ kind: "count" });
      if (k === "]") return e.preventDefault(), indent(1);
      if (k === "[") return e.preventDefault(), indent(-1);
      if (k === "enter") return e.preventDefault(), pageBreak();
      if (e.shiftKey && k === "x") return e.preventDefault(), toggle("strikethrough", "Strikethrough");
      if (e.shiftKey && (e.key === "&" || e.code === "Digit7")) return e.preventDefault(), list(PRESET.number);
      if (e.shiftKey && (e.key === "*" || e.code === "Digit8")) return e.preventDefault(), list(PRESET.bullet);
      if (e.shiftKey && (e.key === "(" || e.code === "Digit9")) return e.preventDefault(), list(PRESET.check);
      if (k === ".") return e.preventDefault(), baseline("SUPERSCRIPT");
      if (k === ",") return e.preventDefault(), baseline("SUBSCRIPT");
    }
    if (mod && e.altKey && /^Digit[0-6]$/.test(e.code)) {
      e.preventDefault();
      const n = Number(e.code.slice(5));
      return paraStyle({ namedStyleType: n === 0 ? "NORMAL_TEXT" : `HEADING_${n}` }, "namedStyleType", "Paragraph style");
    }
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      if (!doc) return;
      const { s } = sel();
      const c = cellAt(doc.toks, s);
      const nl = newlineOf(doc.toks, s);
      if (nl?.bullet) return indent(e.shiftKey ? -1 : 1);
      if (c) {
        // Next or previous cell.
        const t = doc.toks;
        let j = e.shiftKey ? c.first - 2 : c.last + 1;
        while (j > 0 && j < t.length && !isText(t[j])) j += e.shiftKey ? -1 : 1;
        if (j > 0 && j < t.length) {
          const [ps] = paraAt(t, j);
          return caret(e.shiftKey ? j : ps), viewRef.current?.setSel(e.shiftKey ? j : ps);
        }
        return;
      }
      if (e.shiftKey) return indent(-1);
      return typeText("\t");
    }
    if ((e.key === "Delete" || e.key === "Backspace") && imgSel !== null) {
      e.preventDefault();
      caret(imgSel, imgSel + 1);
      setImgSel(null);
      return deleteDir(true);
    }
  }
  function onCut(e: React.ClipboardEvent) {
    e.preventDefault();
    if (!doc) return;
    const { s, e: end } = sel();
    if (s === end) return;
    e.clipboardData.setData("text/plain", textOf(doc.toks, s, end));
    const r = window.getSelection()?.getRangeAt(0);
    if (r) {
      const box = document.createElement("div");
      box.appendChild(r.cloneContents());
      e.clipboardData.setData("text/html", box.innerHTML);
    }
    deleteDir(true);
  }
  function onPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    typeText(e.clipboardData.getData("text/plain"), "Paste");
  }
  function onMouseDown(e: React.MouseEvent) {
    const t = e.target as HTMLElement;
    const io = t.closest<HTMLElement>(".dx-io");
    const p = t.closest<HTMLElement>("[data-p]");
    if (io && p) {
      e.preventDefault();
      const i = Number(p.dataset.p) + Number(io.dataset.o);
      page.current?.focus();
      io.classList.add("sel");
      setImgSel(i);
      caret(i, i + 1);
      viewRef.current?.setSel(i, i + 1);
      return;
    }
    setImgSel(null);
    if (t.closest(".dx-check")) say("Ticking checklist items isn't available through Google's API; open the file in Google Docs to tick them.");
    const link = t.closest<HTMLElement>(".dx-link");
    if (link && (e.ctrlKey || e.metaKey) && link.dataset.href && /^https?:/.test(link.dataset.href)) window.open(link.dataset.href, "_blank", "noopener,noreferrer");
  }

  // ── File actions ──
  async function post(body: Record<string, unknown>) {
    const r = await fetch(`/api/google/docs/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Google didn't accept that.");
    return d;
  }
  async function rename(name: string) {
    setTitleDraft(null);
    const n = name.trim();
    if (!meta || !n || n === meta.file.name) return;
    const old = meta.file.name;
    eng.setFile({ name: n });
    try {
      await post({ action: "rename", name: n });
    } catch (e) {
      eng.setFile({ name: old });
      say((e as Error).message);
    }
  }
  async function star() {
    if (!meta) return;
    const to = !meta.file.starred;
    eng.setFile({ starred: to });
    try {
      await post({ action: "star", starred: to });
    } catch (e) {
      eng.setFile({ starred: !to });
      say((e as Error).message);
    }
  }
  async function googlePost(body: Record<string, unknown>) {
    const r = await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Google didn't accept that.");
    return d;
  }
  async function newDoc() {
    try {
      const { file } = await googlePost({ action: "create", kind: "docs", name: "Untitled document" });
      window.open(`/docs/${file.id}`, "_blank");
    } catch (e) {
      say((e as Error).message);
    }
  }
  async function makeCopy() {
    if (!meta) return;
    try {
      const { file } = await googlePost({ action: "copy", id, name: `Copy of ${meta.file.name}` });
      window.open(`/docs/${file.id}`, "_blank");
    } catch (e) {
      say((e as Error).message);
    }
  }
  async function trash() {
    try {
      await eng.flush();
      await googlePost({ action: "trash", id });
      router.push("/docs?trashed=1");
    } catch (e) {
      say((e as Error).message);
    }
  }
  const exportUrl = (format: string, inline = false) => `/api/google/docs/${encodeURIComponent(id)}?view=export&format=${format}&name=${encodeURIComponent(meta?.file.name ?? "document")}${inline ? "&inline=1" : ""}`;
  async function print() {
    await eng.flush();
    window.open(exportUrl("pdf", true), "_blank");
  }
  async function download(format: string) {
    await eng.flush();
    const a = document.createElement("a");
    a.href = exportUrl(format);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  async function loadComments() {
    setComments("loading");
    const r = await fetch(`/api/google/docs/${encodeURIComponent(id)}?view=comments`).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) {
      setComments(null);
      return say(d.error ?? "Couldn't load the comments.");
    }
    setComments(d.comments ?? []);
  }
  function askAi() {
    if (!doc || !meta) return;
    const text = modelText(doc.toks, 0, doc.toks.length).replace(/￼/g, "").replace(/\s+/g, " ").trim();
    const prompt = `About my Google Doc "${meta.file.name}" (${wordCount(doc.toks).words} words). Here is how it starts:\n\n${text.slice(0, 1500)}${text.length > 1500 ? "…" : ""}\n\nSummarise it and suggest improvements.`;
    window.open(`/home/chat?prompt=${encodeURIComponent(prompt)}`, "_blank");
  }

  // ── Not connected, missing file, loading ──
  if (!meta || !doc) {
    const err = eng.loadError;
    return (
      <div className="sx-root ox-docs" style={{ height: "60vh" }}>
        <div style={{ margin: "auto", maxWidth: 460, textAlign: "center", padding: 24 }}>
          {!err ? (
            <p style={{ color: "var(--ix-muted)", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <LoaderCircle size={16} className="animate-spin" /> Opening the document…
            </p>
          ) : (
            <>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>{err.connect ? "Connect Google Drive" : "Couldn't open this document"}</h1>
              <p style={{ color: "var(--ix-muted)", marginTop: 6 }}>{err.connect ? "Connect your Google account to open and edit your Google Docs here." : err.text}</p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
                {(err.connect || err.reconnect) && (
                  <a className="sx-btn primary" href={`/api/google/connect?back=/docs/${encodeURIComponent(id)}`}>
                    {err.connect ? "Connect Google Drive" : "Reconnect Google"}
                  </a>
                )}
                <NextLink className="sx-btn" href="/docs">
                  Back to Docs
                </NextLink>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── What the toolbar shows ──
  const cur = ord(selUi ?? { a: 1, f: 1 });
  const ts = curStyle();
  const nl = newlineOf(doc.toks, cur.s);
  const ns: string = nl?.ps?.namedStyleType ?? "NORMAL_TEXT";
  const named = { ...(doc.named.NORMAL_TEXT?.ts ?? {}), ...(doc.named[ns]?.ts ?? {}) };
  const size = pt(ts.fontSize) ?? pt(named.fontSize) ?? DEFAULT_NAMED[ns]?.size ?? 11;
  const font: string = ts.weightedFontFamily?.fontFamily ?? named.weightedFontFamily?.fontFamily ?? "Arial";
  const align: string = nl?.ps?.alignment ?? "START";
  const listPreset = nl?.bullet ? presetOf(doc.lists[nl.bullet.listId]) : null;
  const inTable = !!cellAt(doc.toks, cur.s);
  const counts = wordCount(doc.toks);
  const ds = doc.docStyle ?? {};
  const pageW = pt(ds.pageSize?.width) ?? 612;
  const pageH = pt(ds.pageSize?.height) ?? 792;
  const ml = pt(ds.marginLeft) ?? 72;
  const mr = pt(ds.marginRight) ?? 72;
  const mt = pt(ds.marginTop) ?? 72;
  const mb = pt(ds.marginBottom) ?? 72;
  const pageless = ds.documentFormat?.documentMode === "PAGELESS";
  const pagePx = pageW * (96 / 72);
  const z = zoom === "fit" ? Math.max(0.3, Math.min(2, (fitW - 48) / pagePx)) : zoom;
  const headings = (() => {
    const out: { i: number; level: number; text: string }[] = [];
    const t = doc.toks;
    for (let i = 0; i < t.length; i++) {
      const tk = t[i];
      if (tk.k !== "n") continue;
      const n = tk.ps?.namedStyleType ?? "";
      const m = /^HEADING_(\d)$/.exec(n);
      if (!m && n !== "TITLE") continue;
      const [a] = paraAt(t, i);
      const text = modelText(t, a, i).replace(/￼/g, "").trim();
      if (text) out.push({ i: a, level: m ? Number(m[1]) : 0, text });
    }
    return out;
  })();
  const link = cur.s === cur.e ? linkAt(cur.s) : null;
  const saveState = eng.save;

  const tb = (label: string, icon: React.ReactNode, onClick: () => void, opts: { pressed?: boolean; disabled?: boolean; phone?: boolean } = {}) => (
    <button type="button" className={`sx-tb ${opts.phone ? "" : "sx-hide-phone"}`} title={label} aria-label={label} aria-pressed={opts.pressed} disabled={opts.disabled ?? ro} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {icon}
    </button>
  );
  const sep = <span className="sx-tbsep sx-hide-phone" />;
  const styleItems: Item[] = ["NORMAL_TEXT", "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"].map((s) => ({
    label: STYLE_NAMES[s],
    checked: ns === s,
    hint: s.startsWith("HEADING_") && Number(s.slice(8)) <= 6 ? `Ctrl+Alt+${s.slice(8)}` : s === "NORMAL_TEXT" ? "Ctrl+Alt+0" : undefined,
    disabled: ro,
    onClick: () => paraStyle({ namedStyleType: s }, "namedStyleType", "Paragraph style"),
  }));
  const tableItems: Item[] = [
    { label: "Insert row above", disabled: ro || !inTable, onClick: () => tableOp("rowAbove") },
    { label: "Insert row below", disabled: ro || !inTable, onClick: () => tableOp("rowBelow") },
    { label: "Insert column left", disabled: ro || !inTable, onClick: () => tableOp("colLeft") },
    { label: "Insert column right", disabled: ro || !inTable, onClick: () => tableOp("colRight") },
    "-",
    { label: "Delete row", disabled: ro || !inTable, onClick: () => tableOp("delRow") },
    { label: "Delete column", disabled: ro || !inTable, onClick: () => tableOp("delCol") },
    { label: "Delete table", danger: true, disabled: ro || !inTable, onClick: () => tableOp("delTable") },
  ];
  const tablePicker = (close: () => void) => <TablePicker onPick={(r, c) => (close(), insertTable(r, c))} />;
  const menus: Record<string, Item[]> = {
    File: [
      { label: "New document", icon: <Plus size={15} />, onClick: newDoc, disabled: !perms.can("docs.google.edit") },
      { label: "Open", icon: <FileText size={15} />, onClick: () => router.push("/docs") },
      { label: "Make a copy", icon: <Copy size={15} />, onClick: makeCopy, disabled: !perms.can("docs.google.edit") },
      "-",
      { label: "Rename", icon: <Pencil size={15} />, onClick: () => titleInput.current?.focus(), disabled: readOnly },
      { label: "Move to trash", icon: <Trash size={15} />, danger: true, disabled: !perms.can("docs.google.edit") || readOnly, onClick: () => setDialog({ kind: "trash" }) },
      "-",
      {
        label: "Download",
        icon: <Download size={15} />,
        sub: [
          ["docx", "Microsoft Word (.docx)"],
          ["pdf", "PDF document (.pdf)"],
          ["odt", "OpenDocument (.odt)"],
          ["rtf", "Rich text (.rtf)"],
          ["txt", "Plain text (.txt)"],
          ["md", "Markdown (.md)"],
          ["epub", "EPUB (.epub)"],
        ].map(([f, l]) => ({ label: l, onClick: () => void download(f) })),
      },
      { label: "Print", icon: <Printer size={15} />, hint: "Ctrl+P", onClick: () => void print() },
      "-",
      { label: "Open in Google Docs", icon: <ExternalLink size={15} />, onClick: () => window.open(meta.file.webViewLink, "_blank", "noopener,noreferrer") },
    ],
    Edit: [
      { label: "Undo", icon: <Undo2 size={15} />, hint: "Ctrl+Z", disabled: ro || !eng.canUndo, onClick: undo },
      { label: "Redo", icon: <Redo2 size={15} />, hint: "Ctrl+Y", disabled: ro || !eng.canRedo, onClick: redo },
      "-",
      {
        label: "Select all",
        hint: "Ctrl+A",
        onClick: () => {
          page.current?.focus();
          caret(1, doc.toks.length - 1);
          viewRef.current?.setSel(1, doc.toks.length - 1);
        },
      },
      { label: "Find and replace", icon: <Search size={15} />, hint: "Ctrl+H", onClick: () => setDialog({ kind: "find", replace: true }) },
    ],
    View: [
      { label: "Show outline", checked: outline, onClick: () => setOutline((o) => !o) },
      { label: "Zoom", sub: [...ZOOMS.map((v) => ({ label: `${Math.round(v * 100)}%`, checked: zoom === v, onClick: () => setZoom(v) })), { label: "Fit", checked: zoom === "fit", onClick: () => setZoom("fit") }] },
      { label: "Comments", icon: <MessageSquare size={15} />, onClick: () => (comments ? setComments(null) : void loadComments()) },
    ],
    Insert: [
      { label: "Image", icon: <ImagePlus size={15} />, disabled: ro, onClick: () => setDialog({ kind: "image" }) },
      {
        label: "Table",
        icon: <Table size={15} />,
        disabled: ro,
        sub: [1, 2, 3, 4, 5].flatMap((r) => [{ label: `${r} × ${r === 1 ? 2 : r} table`, onClick: () => insertTable(r, r === 1 ? 2 : r) }]),
      },
      { label: "Link", icon: <LinkIcon size={15} />, hint: "Ctrl+K", disabled: ro, onClick: () => setDialog({ kind: "link" }) },
      { label: "Page break", hint: "Ctrl+Enter", disabled: ro, onClick: pageBreak },
      "-",
      { label: "Headers and footers (edit in Google Docs)", disabled: true },
    ],
    Format: [
      {
        label: "Text",
        sub: [
          { label: "Bold", hint: "Ctrl+B", checked: !!ts.bold, disabled: ro, onClick: () => toggle("bold", "Bold") },
          { label: "Italic", hint: "Ctrl+I", checked: !!ts.italic, disabled: ro, onClick: () => toggle("italic", "Italic") },
          { label: "Underline", hint: "Ctrl+U", checked: !!ts.underline, disabled: ro, onClick: () => toggle("underline", "Underline") },
          { label: "Strikethrough", hint: "Alt+Shift+5", checked: !!ts.strikethrough, disabled: ro, onClick: () => toggle("strikethrough", "Strikethrough") },
          { label: "Superscript", hint: "Ctrl+.", checked: ts.baselineOffset === "SUPERSCRIPT", disabled: ro, onClick: () => baseline("SUPERSCRIPT") },
          { label: "Subscript", hint: "Ctrl+,", checked: ts.baselineOffset === "SUBSCRIPT", disabled: ro, onClick: () => baseline("SUBSCRIPT") },
          { label: "Small caps", checked: !!ts.smallCaps, disabled: ro, onClick: () => setStyle({ smallCaps: !ts.smallCaps }, "smallCaps", "Small caps") },
        ],
      },
      { label: "Paragraph styles", sub: styleItems },
      {
        label: "Align and indent",
        sub: [
          { label: "Left", checked: align === "START", disabled: ro, onClick: () => paraStyle({ alignment: "START" }, "alignment", "Align") },
          { label: "Centre", checked: align === "CENTER", disabled: ro, onClick: () => paraStyle({ alignment: "CENTER" }, "alignment", "Align") },
          { label: "Right", checked: align === "END", disabled: ro, onClick: () => paraStyle({ alignment: "END" }, "alignment", "Align") },
          { label: "Justified", checked: align === "JUSTIFIED", disabled: ro, onClick: () => paraStyle({ alignment: "JUSTIFIED" }, "alignment", "Align") },
          "-",
          { label: "Increase indent", hint: "Ctrl+]", disabled: ro, onClick: () => indent(1) },
          { label: "Decrease indent", hint: "Ctrl+[", disabled: ro, onClick: () => indent(-1) },
        ],
      },
      {
        label: "Line and paragraph spacing",
        sub: [
          ...SPACING.map(([v, l]) => ({ label: l, checked: (nl?.ps?.lineSpacing ?? 115) === v, disabled: ro, onClick: () => paraStyle({ lineSpacing: v }, "lineSpacing", "Line spacing") })),
          "-" as const,
          { label: "Add space before paragraph", disabled: ro, onClick: () => paraStyle({ spaceAbove: { magnitude: 10, unit: "PT" } }, "spaceAbove", "Space before") },
          { label: "Add space after paragraph", disabled: ro, onClick: () => paraStyle({ spaceBelow: { magnitude: 10, unit: "PT" } }, "spaceBelow", "Space after") },
          { label: "Remove space before and after", disabled: ro, onClick: () => paraStyle({ spaceAbove: { magnitude: 0, unit: "PT" }, spaceBelow: { magnitude: 0, unit: "PT" } }, "spaceAbove,spaceBelow", "Remove space") },
        ],
      },
      {
        label: "Bullets and numbering",
        sub: [
          { label: "Bulleted list", hint: "Ctrl+Shift+8", checked: listPreset === PRESET.bullet, disabled: ro, onClick: () => list(PRESET.bullet) },
          { label: "Numbered list", hint: "Ctrl+Shift+7", checked: !!listPreset?.startsWith("NUMBERED"), disabled: ro, onClick: () => list(PRESET.number) },
          { label: "Checklist", hint: "Ctrl+Shift+9", checked: listPreset === PRESET.check, disabled: ro, onClick: () => list(PRESET.check) },
        ],
      },
      { label: "Table", sub: tableItems },
      "-",
      { label: "Clear formatting", icon: <RemoveFormatting size={15} />, hint: "Ctrl+\\", disabled: ro, onClick: clearFormatting },
    ],
    Tools: [
      { label: "Word count", hint: "Ctrl+Shift+C", onClick: () => setDialog({ kind: "count" }) },
      { label: "Comments", icon: <MessageSquare size={15} />, onClick: () => void loadComments() },
      ...(perms.can("home.ask") ? ["-" as const, { label: "Ask AI about this document", icon: <Sparkles size={15} />, onClick: askAi }] : []),
    ],
  };

  return (
    <div ref={root} className="sx-root ox-docs" style={{ height: height ?? "calc(100dvh - 64px)" }}>
      {/* Title bar */}
      <div className="sx-top">
        <NextLink href="/docs" className="sx-logo dx-logo" title="Docs home" aria-label="Docs home">
          <FileText size={20} />
        </NextLink>
        <div className="sx-titlebox">
          <div className="sx-titlerow">
            <input
              ref={titleInput}
              className="sx-title"
              aria-label="Document name"
              value={titleDraft ?? meta.file.name}
              readOnly={readOnly}
              onChange={(e) => setTitleDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => titleDraft !== null && void rename(titleDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setTitleDraft(null);
                  requestAnimationFrame(() => page.current?.focus());
                }
              }}
            />
            <button type="button" className={`sx-ibtn ${meta.file.starred ? "starred" : ""}`} title={meta.file.starred ? "Remove star" : "Star"} aria-label={meta.file.starred ? "Remove star" : "Star"} aria-pressed={!!meta.file.starred} onClick={star}>
              <Star size={17} fill={meta.file.starred ? "currentColor" : "none"} />
            </button>
            <span className={`sx-status ${saveState.state === "error" ? "error" : ""}`} role="status" aria-live="polite">
              {saveState.state === "saving" ? (
                <>
                  <LoaderCircle size={14} className="animate-spin" /> Saving…
                </>
              ) : saveState.state === "error" ? (
                <>
                  <CloudOff size={14} /> {saveState.error}
                  <button type="button" className="sx-btn" style={{ padding: "1px 10px", marginLeft: 4 }} onClick={() => eng.retry()}>
                    Retry
                  </button>
                  <button type="button" className="sx-btn" style={{ padding: "1px 10px" }} onClick={() => eng.dismissError()}>
                    Dismiss
                  </button>
                </>
              ) : saveState.state === "saved" ? (
                <>
                  <CloudCheck size={14} /> Saved to Drive
                </>
              ) : (
                <span className="sx-hide-phone">{readOnly ? "View only" : "All changes saved in Drive"}</span>
              )}
            </span>
          </div>
          <nav className="sx-menubar" aria-label="Menu">
            {Object.entries(menus).map(([name, items]) => (
              <Dropdown key={name} title={name} className="" button={name} items={items} />
            ))}
          </nav>
        </div>
        <button type="button" className="sx-ibtn sx-hide-phone" title="Comments" aria-label="Comments" onClick={() => (comments ? setComments(null) : void loadComments())}>
          <MessageSquare size={17} />
        </button>
        <a className="sx-ibtn sx-hide-phone" href={meta.file.webViewLink} target="_blank" rel="noopener noreferrer" title="Open in Google Docs" aria-label="Open in Google Docs">
          <ExternalLink size={17} />
        </a>
        <a className="sx-share" href={meta.file.webViewLink} target="_blank" rel="noopener noreferrer" title="Share in Google Docs">
          <Lock size={15} />
          <span className="sx-hide-phone">Share</span>
        </a>
      </div>

      {!meta.connection.canEdit ? (
        <div className="sx-banner">
          <b>View only.</b> Your Google connection was made with read-only access.
          <a href={`/api/google/connect?back=/docs/${encodeURIComponent(id)}`} style={{ color: "var(--ox-ink)", fontWeight: 600, textDecoration: "underline" }}>
            Reconnect Google to allow editing
          </a>
        </div>
      ) : doc.unsafe ? (
        <div className="sx-banner">
          <b>View only.</b> This document has content the editor can&rsquo;t follow safely yet, so editing here is off to protect it. Edit it in Google Docs.
        </div>
      ) : readOnly ? (
        <div className="sx-banner">
          <b>View only.</b> {meta.file.capabilities?.canEdit === false ? "The owner shared this file with you for viewing." : "Editing Google Docs isn't turned on for your role."}
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="sx-toolbar" role="toolbar" aria-label="Formatting">
        {tb("Find (Ctrl+F)", <Search size={17} />, () => setDialog({ kind: "find", replace: false }), { disabled: false })}
        {tb("Undo (Ctrl+Z)", <Undo2 size={17} />, undo, { disabled: ro || !eng.canUndo, phone: true })}
        {tb("Redo (Ctrl+Y)", <Redo2 size={17} />, redo, { disabled: ro || !eng.canRedo, phone: true })}
        {tb("Print (Ctrl+P)", <Printer size={17} />, () => void print(), { disabled: false })}
        {sep}
        <span className="sx-hide-phone">
          <Dropdown
            title="Zoom"
            button={
              <>
                {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`} <ChevronDown size={13} />
              </>
            }
            items={[...ZOOMS.map((v) => ({ label: `${Math.round(v * 100)}%`, checked: zoom === v, onClick: () => setZoom(v) })), { label: "Fit", checked: zoom === "fit", onClick: () => setZoom("fit") }]}
          />
        </span>
        {sep}
        <Dropdown
          title="Styles"
          disabled={ro}
          button={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 92, justifyContent: "space-between" }}>
              {STYLE_NAMES[ns] ?? "Normal text"} <ChevronDown size={13} />
            </span>
          }
          items={styleItems}
        />
        {sep}
        <span className="sx-hide-phone">
          <Dropdown
            title="Font"
            disabled={ro}
            button={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 84, justifyContent: "space-between", fontFamily: font }}>
                {font} <ChevronDown size={13} />
              </span>
            }
            items={[...new Set([font, ...FONTS])].map((f) => ({ label: f, checked: f === font, onClick: () => setStyle({ weightedFontFamily: { fontFamily: f, weight: 400 } }, "weightedFontFamily", "Font") }))}
          />
        </span>
        {sep}
        <span className="sx-fsize sx-hide-phone">
          <button type="button" className="sx-tb" style={{ height: 24, minWidth: 22 }} title="Decrease font size" aria-label="Decrease font size" disabled={ro} onMouseDown={(e) => e.preventDefault()} onClick={() => setStyle({ fontSize: { magnitude: Math.max(1, size - 1), unit: "PT" } }, "fontSize", "Font size")}>
            −
          </button>
          <Dropdown title="Font size" className="sx-tb" disabled={ro} button={<span style={{ minWidth: 22 }}>{size}</span>} items={SIZES.map((n) => ({ label: String(n), checked: n === size, onClick: () => setStyle({ fontSize: { magnitude: n, unit: "PT" } }, "fontSize", "Font size") }))} />
          <button type="button" className="sx-tb" style={{ height: 24, minWidth: 22 }} title="Increase font size" aria-label="Increase font size" disabled={ro} onMouseDown={(e) => e.preventDefault()} onClick={() => setStyle({ fontSize: { magnitude: Math.min(400, size + 1), unit: "PT" } }, "fontSize", "Font size")}>
            +
          </button>
        </span>
        {sep}
        {tb("Bold (Ctrl+B)", <Bold size={17} />, () => toggle("bold", "Bold"), { pressed: !!ts.bold, phone: true })}
        {tb("Italic (Ctrl+I)", <Italic size={17} />, () => toggle("italic", "Italic"), { pressed: !!ts.italic, phone: true })}
        {tb("Underline (Ctrl+U)", <Underline size={17} />, () => toggle("underline", "Underline"), { pressed: !!ts.underline, phone: true })}
        {tb("Strikethrough", <Strikethrough size={17} />, () => toggle("strikethrough", "Strikethrough"), { pressed: !!ts.strikethrough })}
        <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
          <Dropdown
            title="Text colour"
            disabled={ro}
            button={
              <span style={{ position: "relative", display: "inline-grid", placeItems: "center", width: 22, height: 24 }}>
                <Baseline size={17} />
                <span className="sx-swatchbar" style={{ background: rgbOf(ts.foregroundColor) ?? "#000" }} />
              </span>
            }
          >
            {(close) => <Palette value={rgbOf(ts.foregroundColor)} reset="Reset" onPick={(h) => (close(), colour("text", h))} />}
          </Dropdown>
          <Dropdown
            title="Highlight colour"
            disabled={ro}
            button={
              <span style={{ position: "relative", display: "inline-grid", placeItems: "center", width: 22, height: 24 }}>
                <Highlighter size={17} />
                <span className="sx-swatchbar" style={{ background: rgbOf(ts.backgroundColor) ?? "transparent" }} />
              </span>
            }
          >
            {(close) => <Palette value={rgbOf(ts.backgroundColor)} reset="None" onPick={(h) => (close(), colour("highlight", h))} />}
          </Dropdown>
        </span>
        {sep}
        {tb("Insert link (Ctrl+K)", <LinkIcon size={17} />, () => setDialog({ kind: "link" }), { pressed: !!link })}
        {tb("Insert image", <ImagePlus size={17} />, () => setDialog({ kind: "image" }))}
        <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
          <Dropdown title="Insert table" disabled={ro} button={<Table size={17} />}>
            {tablePicker}
          </Dropdown>
        </span>
        {sep}
        <span className="sx-hide-phone" style={{ display: "inline-flex" }}>
          <Dropdown
            title="Align"
            disabled={ro}
            button={align === "CENTER" ? <TextAlignCenter size={17} /> : align === "END" ? <TextAlignEnd size={17} /> : align === "JUSTIFIED" ? <TextAlignJustify size={17} /> : <TextAlignStart size={17} />}
            items={(
              [
                ["START", "Left", <TextAlignStart key="l" size={15} />],
                ["CENTER", "Centre", <TextAlignCenter key="c" size={15} />],
                ["END", "Right", <TextAlignEnd key="r" size={15} />],
                ["JUSTIFIED", "Justified", <TextAlignJustify key="j" size={15} />],
              ] as [string, string, React.ReactNode][]
            ).map(([v, l, icon]) => ({ label: l, icon, checked: align === v, onClick: () => paraStyle({ alignment: v }, "alignment", "Align") }))}
          />
          <Dropdown
            title="Line and paragraph spacing"
            disabled={ro}
            button={<span style={{ fontSize: 15, lineHeight: 1 }}>↕</span>}
            items={SPACING.map(([v, l]) => ({ label: l, checked: (nl?.ps?.lineSpacing ?? 115) === v, onClick: () => paraStyle({ lineSpacing: v }, "lineSpacing", "Line spacing") }))}
          />
        </span>
        {tb("Checklist (Ctrl+Shift+9)", <ListTodo size={17} />, () => list(PRESET.check), { pressed: listPreset === PRESET.check })}
        {tb("Bulleted list (Ctrl+Shift+8)", <List size={17} />, () => list(PRESET.bullet), { pressed: listPreset === PRESET.bullet, phone: true })}
        {tb("Numbered list (Ctrl+Shift+7)", <ListOrdered size={17} />, () => list(PRESET.number), { pressed: !!listPreset?.startsWith("NUMBERED") })}
        {tb("Decrease indent (Ctrl+[)", <IndentDecrease size={17} />, () => indent(-1))}
        {tb("Increase indent (Ctrl+])", <IndentIncrease size={17} />, () => indent(1))}
        {sep}
        {tb("Clear formatting (Ctrl+\\)", <RemoveFormatting size={17} />, clearFormatting)}
        <span style={{ flex: 1 }} />
        {tb(outline ? "Hide outline" : "Show outline", <PanelLeft size={17} />, () => setOutline((o) => !o), { pressed: outline, disabled: false })}
      </div>

      <div className="dx-main">
        {outline && (
          <nav className="dx-outline" aria-label="Document outline">
            <h2>
              <PanelLeft size={14} /> Outline
            </h2>
            {headings.length ? (
              headings.map((h) => (
                <button
                  key={h.i}
                  type="button"
                  className={`o ${cur.s >= h.i && (headings.find((x) => x.i > h.i)?.i ?? Infinity) > cur.s ? "on" : ""}`}
                  style={{ paddingLeft: 6 + Math.max(0, h.level - 1) * 12, fontWeight: h.level <= 1 ? 500 : 400 }}
                  title={h.text}
                  onClick={() => {
                    page.current?.focus();
                    caret(h.i);
                    viewRef.current?.setSel(h.i);
                    viewRef.current?.point(h.i)?.[0].parentElement?.closest("[data-p]")?.scrollIntoView({ block: "start", behavior: "smooth" });
                  }}
                >
                  {h.text}
                </button>
              ))
            ) : (
              <p style={{ color: "var(--ix-muted)", fontSize: 12.5, padding: "0 6px" }}>Headings you add to the document appear here.</p>
            )}
          </nav>
        )}
        <div ref={canvas} className="dx-canvas">
          <style>{namedCss(doc)}</style>
          <div className="dx-zoom" style={{ zoom: z }}>
            <div
              className="dx-page"
              style={
                {
                  width: `${pageW}pt`,
                  minHeight: pageless ? undefined : `${pageH}pt`,
                  padding: `${mt}pt ${mr}pt ${mb}pt ${ml}pt`,
                  "--dx-ml": `${ml}pt`,
                  "--dx-mr": `${mr}pt`,
                } as React.CSSProperties
              }
            >
              <div ref={headerRef} className="dx-hf" style={{ marginTop: `-${Math.max(0, mt - (pt(ds.marginHeader) ?? 36))}pt`, marginBottom: 12 }} title="Headers and footers are shown here; edit them in Google Docs." />
              <div
                ref={page}
                className="dx-body"
                role="textbox"
                aria-multiline="true"
                aria-label="Document"
                contentEditable={!readOnly}
                suppressContentEditableWarning
                spellCheck
                onKeyDown={onKeyDown}
                onCut={onCut}
                onPaste={onPaste}
                onDrop={(e) => e.preventDefault()}
                onMouseDown={onMouseDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
              />
              <div ref={footerRef} className="dx-hf" style={{ marginTop: 24 }} title="Headers and footers are shown here; edit them in Google Docs." />
            </div>
          </div>
          {eng.locked && <div className="dx-lock" aria-hidden />}
          {doc.positioned > 0 && <p style={{ textAlign: "center", fontSize: 12, color: "var(--ix-muted)", marginTop: 10 }}>This document has {doc.positioned} image{doc.positioned === 1 ? "" : "s"} placed beside the text; open it in Google Docs to see {doc.positioned === 1 ? "it" : "them"}.</p>}
        </div>
        {comments && (
          <aside className="dx-side" aria-label="Comments">
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <b style={{ flex: 1 }}>Comments</b>
              <button type="button" className="sx-ibtn" aria-label="Close comments" onClick={() => setComments(null)}>
                <X size={16} />
              </button>
            </div>
            {comments === "loading" ? (
              <p style={{ color: "var(--ix-muted)" }}>Loading…</p>
            ) : comments.length === 0 ? (
              <p style={{ color: "var(--ix-muted)" }}>No comments on this document.</p>
            ) : (
              comments.map((c) => (
                <div key={c.id} className="dx-comment" style={{ opacity: c.resolved ? 0.6 : 1 }}>
                  <b>{c.author?.displayName ?? "Someone"}</b> <span style={{ color: "var(--ix-muted)", fontSize: 12 }}>{c.createdTime ? new Date(c.createdTime).toLocaleDateString() : ""}{c.resolved ? " · Resolved" : ""}</span>
                  {c.quotedFileContent?.value && <q>{c.quotedFileContent.value}</q>}
                  <p style={{ marginTop: 4 }}>{c.content}</p>
                  {(c.replies ?? []).map((r: Json, i: number) => (
                    <p key={i} style={{ marginTop: 6, paddingLeft: 10, borderLeft: "2px solid var(--ix-line)" }}>
                      <b>{r.author?.displayName ?? "Someone"}:</b> {r.content}
                    </p>
                  ))}
                </div>
              ))
            )}
            <p style={{ color: "var(--ix-muted)", fontSize: 12 }}>Comments are read only here. Reply to them and resolve them in Google Docs.</p>
          </aside>
        )}
        <button type="button" className="dx-count" onClick={() => setDialog({ kind: "count" })} title="Word count">
          {counts.words.toLocaleString()} word{counts.words === 1 ? "" : "s"}
        </button>
      </div>

      {link && !ro && focused && <LinkBubble view={viewRef.current} at={cur.s} url={link.url ?? ""} onEdit={() => setDialog({ kind: "link" })} onRemove={removeLink} />}

      {dialog?.kind === "find" && <FindDialog replace={dialog.replace} readOnly={ro} onClose={() => setDialog(null)} onFind={findNext} onReplace={(f, r, mc) => {
        const { s, e } = sel();
        const t = toks();
        const now = modelText(t, s, e);
        if (s === e || (mc ? now !== f : now.toLowerCase() !== f.toLowerCase())) return findNext(f, mc);
        typeText(r, "Replace");
        findNext(f, mc);
      }} onReplaceAll={(f, r, mc) => {
        replaceAll(f, r, mc);
        setDialog(null);
      }} />}
      {dialog?.kind === "link" && <LinkDialog initial={link?.url ?? ""} hasText={cur.s !== cur.e || !!link} onClose={() => setDialog(null)} onRemove={link ? () => (setDialog(null), removeLink()) : undefined} onSave={(u, t) => (setDialog(null), setLink(u, t))} />}
      {dialog?.kind === "image" && <ImageDialog docId={id} maxPt={pageW - ml - mr} onClose={() => setDialog(null)} onMessage={say} onInsert={(uri, w) => (setDialog(null), void insertImage(uri, w))} />}
      {dialog?.kind === "count" && (
        <Modal title="Word count" onClose={() => setDialog(null)}>
          <table style={{ width: "100%", fontSize: 13.5 }}>
            <tbody>
              <tr>
                <td>Words</td>
                <td style={{ textAlign: "right" }}>{counts.words.toLocaleString()}</td>
              </tr>
              <tr>
                <td>Characters (no newlines)</td>
                <td style={{ textAlign: "right" }}>{counts.chars.toLocaleString()}</td>
              </tr>
              {cur.s !== cur.e && (
                <tr>
                  <td>Words in the selection</td>
                  <td style={{ textAlign: "right" }}>{wordCount(doc.toks.slice(cur.s, cur.e)).words.toLocaleString()}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button type="button" className="sx-btn" onClick={() => setDialog(null)}>
              OK
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "trash" && (
        <Modal title="Move to trash?" onClose={() => setDialog(null)}>
          <p style={{ color: "var(--ix-muted)", fontSize: 13.5 }}>&ldquo;{meta.file.name}&rdquo; goes to Google Drive&rsquo;s Trash. You can restore it there for 30 days.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button type="button" className="sx-btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button type="button" className="sx-btn primary" style={{ background: "#dc2626", borderColor: "#dc2626" }} onClick={() => (setDialog(null), void trash())}>
              Move to trash
            </button>
          </div>
        </Modal>
      )}

      {toast && (
        <div role="status" style={{ position: "fixed", left: "50%", bottom: 64, transform: "translateX(-50%)", zIndex: 80, background: "#323232", color: "#fff", padding: "10px 16px", borderRadius: 6, fontSize: 13.5, maxWidth: "calc(100vw - 32px)", boxShadow: "0 4px 14px rgba(0,0,0,.3)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useDismiss(true, onClose);
  return (
    <div ref={ref} className="sx-pop sx-dialog" role="dialog" aria-label={title}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>{title}</h2>
      {children}
    </div>
  );
}

function TablePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState<[number, number]>([1, 1]);
  return (
    <div>
      <div className="dx-tgrid" onMouseLeave={() => setHover([1, 1])}>
        {Array.from({ length: 8 * 10 }, (_, i) => {
          const r = Math.floor(i / 10) + 1;
          const c = (i % 10) + 1;
          return <button key={i} type="button" aria-label={`${r} by ${c} table`} className={r <= hover[0] && c <= hover[1] ? "on" : ""} onMouseEnter={() => setHover([r, c])} onFocus={() => setHover([r, c])} onClick={() => onPick(r, c)} />;
        })}
      </div>
      <p style={{ textAlign: "center", fontSize: 12.5, marginTop: 6 }}>
        {hover[0]} × {hover[1]}
      </p>
    </div>
  );
}

function LinkBubble({ view, at, url, onEdit, onRemove }: { view: DocView | null; at: number; url: string; onEdit: () => void; onRemove: () => void }) {
  const r = view?.rectAt(at);
  if (!r) return null;
  return (
    <div className="dx-bubble" style={{ left: Math.max(8, Math.min(r.left, window.innerWidth - 340)), top: r.bottom + 6 }} onMouseDown={(e) => e.preventDefault()}>
      <ExternalLink size={14} />
      <a href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
      <button type="button" className="sx-ibtn" title="Edit link" aria-label="Edit link" onClick={onEdit}>
        <Pencil size={14} />
      </button>
      <button type="button" className="sx-ibtn" title="Remove link" aria-label="Remove link" onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}

function LinkDialog(p: { initial: string; hasText: boolean; onClose: () => void; onSave: (url: string, text: string) => void; onRemove?: () => void }) {
  const [url, setUrl] = useState(p.initial);
  const [text, setText] = useState("");
  return (
    <Modal title="Insert link" onClose={p.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) p.onSave(url, text);
        }}
        style={{ display: "grid", gap: 8 }}
      >
        {!p.hasText && <input aria-label="Text" className="sx-input" placeholder="Text" value={text} onChange={(e) => setText(e.target.value)} />}
        <input autoFocus aria-label="Link" className="sx-input" placeholder="Paste a link" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          {p.onRemove && (
            <button type="button" className="sx-btn" onClick={p.onRemove}>
              Remove link
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="sx-btn" onClick={p.onClose}>
            Cancel
          </button>
          <button className="sx-btn primary" disabled={!url.trim()}>
            Apply
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** An image by URL, or uploaded from the computer to the person's Drive. */
function ImageDialog(p: { docId: string; maxPt: number; onClose: () => void; onInsert: (uri: string, widthPt: number | null) => void; onMessage: (t: string) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Natural size, so the image goes in at its size (or the page width).
  const widthOf = (src: string) =>
    new Promise<number | null>((res) => {
      const img = new Image();
      img.onload = () => res(Math.min(p.maxPt, (img.naturalWidth * 72) / 96));
      img.onerror = () => res(null);
      img.src = src;
      setTimeout(() => res(null), 4000);
    });
  async function upload(f: File) {
    setBusy(true);
    const local = URL.createObjectURL(f);
    const w = await widthOf(local);
    URL.revokeObjectURL(local);
    const form = new FormData();
    form.append("file", f);
    const r = await fetch(`/api/google/docs/${encodeURIComponent(p.docId)}`, { method: "POST", body: form }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok || !d.uri) return p.onMessage(d.error ?? "Couldn't upload the image.");
    p.onInsert(d.uri, w);
  }
  return (
    <Modal title="Insert image" onClose={p.onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const u = url.trim();
          if (!/^https:\/\//i.test(u)) return p.onMessage("Use an https:// link to an image that's publicly reachable.");
          setBusy(true);
          const w = await widthOf(u);
          setBusy(false);
          p.onInsert(u, w);
        }}
        style={{ display: "grid", gap: 10 }}
      >
        <label style={{ fontSize: 13 }}>
          By URL
          <input autoFocus aria-label="Image URL" className="sx-input" style={{ width: "100%", marginTop: 4 }} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <p style={{ fontSize: 12, color: "var(--ix-muted)" }}>Or upload one: it&rsquo;s saved to your Drive and shared by link only until Google has inserted it.</p>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="sx-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Working…" : "Upload from computer"}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="sx-btn" onClick={p.onClose}>
            Cancel
          </button>
          <button className="sx-btn primary" disabled={!url.trim() || busy}>
            Insert
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FindDialog(p: { replace: boolean; readOnly: boolean; onClose: () => void; onFind: (text: string, matchCase: boolean, back?: boolean) => boolean | void; onReplace: (find: string, rep: string, matchCase: boolean) => void; onReplaceAll: (find: string, rep: string, matchCase: boolean) => void }) {
  const [find, setFind] = useState("");
  const [rep, setRep] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  return (
    <Modal title={p.replace ? "Find and replace" : "Find"} onClose={p.onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center" }}>
        <label htmlFor="dx-find">Find</label>
        <input id="dx-find" autoFocus className="sx-input" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), p.onFind(find, matchCase, e.shiftKey))} />
        {p.replace && (
          <>
            <label htmlFor="dx-rep">Replace with</label>
            <input id="dx-rep" className="sx-input" value={rep} onChange={(e) => setRep(e.target.value)} disabled={p.readOnly} />
          </>
        )}
      </div>
      <label style={{ display: "flex", gap: 6, marginTop: 10, fontSize: 13 }}>
        <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
        <button type="button" className="sx-btn" onClick={p.onClose}>
          Done
        </button>
        <button type="button" className="sx-btn" disabled={!find} onClick={() => p.onFind(find, matchCase, true)}>
          Previous
        </button>
        <button type="button" className="sx-btn" disabled={!find} onClick={() => p.onFind(find, matchCase)}>
          Next
        </button>
        {p.replace && (
          <>
            <button type="button" className="sx-btn" disabled={!find || p.readOnly} onClick={() => p.onReplace(find, rep, matchCase)}>
              Replace
            </button>
            <button type="button" className="sx-btn primary" disabled={!find || p.readOnly} onClick={() => p.onReplaceAll(find, rep, matchCase)}>
              Replace all
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

