"use client";

import "../sheets/sheets.css";
import "./slides.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
  Baseline,
  Bold,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudCheck,
  CloudOff,
  Copy,
  Download,
  ExternalLink,
  ImagePlus,
  Italic,
  LoaderCircle,
  Lock,
  Minus,
  PaintBucket,
  Pencil,
  Play,
  Plus,
  Presentation,
  Printer,
  Redo2,
  Shapes,
  Sparkles,
  SquareDashed,
  Star,
  Table,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Trash,
  Type,
  Underline,
  Undo2,
  X,
} from "lucide-react";
import { usePerms } from "@/components/iotx/PermsProvider";
import { Dropdown, useDismiss, type Item } from "../sheets/Menu";
import { Palette, ZOOMS } from "../sheets/Toolbar";
import { FONTS, fromHex } from "../sheets/model";
import { SlidesEngine } from "./engine";
import SlideView, { boxesOf, type EditTarget, type Preview } from "./SlideView";
import { domPlain, selIn, setSelIn } from "./text";
import { baseStyle, boxOf, cssColor, findEl, newId, plainOf, SHAPES, slideHash, slideOf, toFlat, type Json, type Req } from "./model";

type Dialog = null | { kind: "image" } | { kind: "trash" } | { kind: "layouts"; at: number };
const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];

/**
 * A Google Slides presentation, edited the way Google Slides does it: the
 * filmstrip (Google's own slide pictures, drawn here while a slide has
 * unsaved changes), the slide canvas with real, selectable shapes, text
 * boxes, images, tables and lines, speaker notes, and presenting. Changes
 * go to presentations.batchUpdate in batches.
 */
export default function SlidesEditor({ id }: { id: string }) {
  const router = useRouter();
  const perms = usePerms();
  const [, setVer] = useState(0);
  const [eng] = useState(() => new SlidesEngine(id, () => setVer((v) => v + 1)));
  const meta = eng.meta;
  const pres = eng.view;
  const [curId, setCurId] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [edit, setEditState] = useState<EditTarget>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [present, setPresent] = useState<number | null>(null);
  const [showNotes, setShowNotes] = useState(true);
  const [phone, setPhone] = useState(false);
  const [notesDraft, setNotesDraft] = useState<{ sid: string; text: string } | null>(null);
  const [toast, setToastText] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [stageSize, setStageSize] = useState({ w: 800, h: 450 });
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [badThumbs, setBadThumbs] = useState<Set<string>>(() => new Set());
  const [editEl, setEditEl] = useState<HTMLDivElement | null>(null);
  const [editSelUi, setEditSelUi] = useState<{ a: number; f: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const editSel = useRef<{ a: number; f: number } | null>(null);
  const composing = useRef(false);
  const dragFrom = useRef<number | null>(null);

  const say = useCallback((text: string) => {
    setToastText(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(null), 4500);
  }, []);
  const setEdit = useCallback(
    (t: EditTarget) => {
      setEditState(t);
      eng.setEditing(!!t);
      if (!t) void eng.flush();
    },
    [eng],
  );

  useEffect(() => {
    eng.onNotice = say;
    void eng.open(true);
    const t = setInterval(() => void eng.refresh(), 20_000);
    const focus = () => void eng.refresh();
    window.addEventListener("focus", focus);
    const leave = (e: BeforeUnloadEvent) => {
      if (eng.busy) e.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    const mq = window.matchMedia("(max-width: 640px)");
    const ph = () => setPhone(mq.matches);
    ph();
    mq.addEventListener("change", ph);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", focus);
      window.removeEventListener("beforeunload", leave);
      mq.removeEventListener("change", ph);
      void eng.flush();
    };
  }, [eng, say]);

  // Fill the space given, and fit the slide to the stage.
  const opened = !!meta && !!pres;
  useEffect(() => {
    if (!opened) return;
    const fit = () => {
      const el = root.current;
      if (el) setHeight(Math.max(320, Math.floor(window.innerHeight - el.getBoundingClientRect().top)));
      if (stage.current) setStageSize({ w: stage.current.clientWidth, h: stage.current.clientHeight });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    if (root.current) ro.observe(root.current.parentElement ?? root.current);
    if (stage.current) ro.observe(stage.current);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [opened, showNotes]);

  const readOnly = !meta?.canEdit;
  const ro = readOnly || phone || eng.locked;
  const slides: Json[] = pres?.slides ?? [];
  const slide = slides.find((s) => s.objectId === curId) ?? slides[0] ?? null;
  const idx = slide ? slides.indexOf(slide) : 0;
  const PW = pres?.pageSize?.width?.magnitude ?? 9144000;
  const PH = pres?.pageSize?.height?.magnitude ?? 5143500;
  const fitS = Math.max(0.00002, Math.min((stageSize.w - 36) / PW, (stageSize.h - 36) / PH));
  const s = zoom === "fit" ? fitS : (zoom * 960) / PW;

  // â”€â”€ Text editing inside a shape or cell â”€â”€
  const holder = (t: EditTarget = edit) => {
    if (!t || !pres) return null;
    const el = findEl(pres, t.id)?.el;
    if (!el) return null;
    return t.cell ? el.table?.tableRows?.[t.cell.rowIndex]?.tableCells?.[t.cell.columnIndex] : el.shape;
  };
  const target = (t: EditTarget = edit) => (t ? { objectId: t.id, ...(t.cell ? { cellLocation: t.cell } : {}) } : null);
  const fixed = (a: number, b: number) => ({ type: "FIXED_RANGE", startIndex: a, endIndex: b });
  function editText(insert: string | null, dir?: "back" | "fwd" | "wordback") {
    if (!edit || ro) return;
    const rt = editEl;
    const sel = (rt && selIn(rt)) ?? editSel.current ?? { a: 0, f: 0 };
    let a = Math.min(sel.a, sel.f);
    let b = Math.max(sel.a, sel.f);
    const plain = plainOf(holder()?.text);
    const tg = target()!;
    const reqs: Req[] = [];
    if (a === b && dir === "back") {
      if (a === 0) return;
      a = dir === "back" ? a - 1 : a;
    } else if (a === b && dir === "wordback") {
      const m = /\S*\s*$/.exec(plain.slice(0, a));
      a = Math.max(0, a - Math.max(1, m?.[0].length ?? 1));
    } else if (a === b && dir === "fwd") {
      if (a >= plain.length) return;
      b = a + 1;
    }
    if (b > a) reqs.push({ deleteText: { ...tg, textRange: fixed(a, b) } });
    const text = (insert ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000c\u000e-\u001f]/g, "");
    if (text) reqs.push({ insertText: { ...tg, insertionIndex: a, text } });
    if (!reqs.length) return;
    if (eng.run(text ? "Typing" : "Delete", reqs, `type:${edit.id}`)) editSel.current = { a: a + text.length, f: a + text.length };
  }
  function syncEditFromDom() {
    const rt = editEl;
    if (!rt || !edit) return;
    const now = domPlain(rt);
    const was = plainOf(holder()?.text);
    if (now === was) return setVer((v) => v + 1);
    let pre = 0;
    while (pre < now.length && pre < was.length && now[pre] === was[pre]) pre++;
    let suf = 0;
    while (suf < now.length - pre && suf < was.length - pre && now[now.length - 1 - suf] === was[was.length - 1 - suf]) suf++;
    const tg = target()!;
    const reqs: Req[] = [];
    if (was.length - suf > pre) reqs.push({ deleteText: { ...tg, textRange: fixed(pre, was.length - suf) } });
    const mid = now.slice(pre, now.length - suf);
    if (mid) reqs.push({ insertText: { ...tg, insertionIndex: pre, text: mid } });
    editSel.current = { a: pre + mid.length, f: pre + mid.length };
    if (!ro) eng.run("Typing", reqs, `type:${edit.id}`);
    setVer((v) => v + 1);
  }
  const handlers = useRef({ bi: (_e: InputEvent) => {}, sync: () => {} });
  useLayoutEffect(() => {
  handlers.current = {
    bi: (e: InputEvent) => {
      if (composing.current || e.isComposing || e.inputType === "insertCompositionText") return;
      e.preventDefault();
      switch (e.inputType) {
        case "insertText":
        case "insertReplacementText":
          return editText(e.data ?? e.dataTransfer?.getData("text/plain") ?? "");
        case "insertParagraph":
          return editText("\n");
        case "insertLineBreak":
          return editText("\u000b");
        case "insertFromPaste":
          return editText(e.dataTransfer?.getData("text/plain") ?? "");
        case "deleteContentBackward":
        case "deleteByCut":
        case "deleteContent":
          return editText(null, "back");
        case "deleteWordBackward":
          return editText(null, "wordback");
        case "deleteContentForward":
          return editText(null, "fwd");
        case "historyUndo":
          return undo();
        case "historyRedo":
          return redo();
        case "formatBold":
          return toggle("bold");
        case "formatItalic":
          return toggle("italic");
        case "formatUnderline":
          return toggle("underline");
      }
    },
    sync: syncEditFromDom,
  };
  });
  useEffect(() => {
    const el = editEl;
    if (!el) return;
    const bi = (e: Event) => handlers.current.bi(e as InputEvent);
    const cs = () => (composing.current = true);
    const ce = () => {
      composing.current = false;
      handlers.current.sync();
    };
    const sel = () => {
      const x = selIn(el);
      if (x) {
        editSel.current = x;
        setEditSelUi(x);
      }
    };
    const paste = (e: ClipboardEvent) => {
      e.preventDefault();
      editText(e.clipboardData?.getData("text/plain") ?? "");
    };
    el.addEventListener("beforeinput", bi);
    el.addEventListener("compositionstart", cs);
    el.addEventListener("compositionend", ce);
    el.addEventListener("paste", paste);
    document.addEventListener("selectionchange", sel);
    el.focus();
    if (editSel.current) setSelIn(el, editSel.current.a, editSel.current.f);
    return () => {
      el.removeEventListener("beforeinput", bi);
      el.removeEventListener("compositionstart", cs);
      el.removeEventListener("compositionend", ce);
      el.removeEventListener("paste", paste);
      document.removeEventListener("selectionchange", sel);
    };
    // editText reads the latest state through handlers; the listener only needs the element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editEl]);
  const onDrawn = useCallback(() => {
    if (editEl && editSel.current && document.activeElement === editEl) setSelIn(editEl, editSel.current.a, editSel.current.f);
  }, [editEl]);
  const isComposing = useCallback(() => composing.current, []);

  // â”€â”€ Selection, moving and resizing â”€â”€
  const topEl = (tid: string | null) => (tid && slide ? (slide.pageElements ?? []).find((e: Json) => e.objectId === tid) : null);
  function startEdit(top: string, leaf: string, cell?: { rowIndex: number; columnIndex: number }) {
    if (ro) return;
    const el = findEl(pres, leaf)?.el;
    if (!el || (!el.shape && !(el.table && cell))) return;
    setSelId(top);
    const len = plainOf(cell ? el.table.tableRows[cell.rowIndex].tableCells[cell.columnIndex].text : el.shape.text).length;
    editSel.current = { a: len, f: len };
    setEdit({ id: leaf, cell });
  }
  function onDown(e: React.PointerEvent, top: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (edit && edit.id !== top) setEdit(null);
    setSelId(top);
    stage.current?.focus({ preventScroll: true });
    if (ro) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const st = { moved: false };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / s;
      const dy = (ev.clientY - y0) / s;
      if (!st.moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      st.moved = true;
      setPreview({ id: top, dx, dy });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPreview(null);
      if (!st.moved) return;
      nudge(top, (ev.clientX - x0) / s, (ev.clientY - y0) / s, "Move");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function nudge(top: string, dx: number, dy: number, label: string, group?: string) {
    const el = topEl(top);
    if (!el) return;
    const t = el.transform ?? {};
    const k = t.unit === "PT" ? 12700 : 1;
    eng.run(label, [{ updatePageElementTransform: { objectId: top, applyMode: "ABSOLUTE", transform: { scaleX: t.scaleX ?? 1, scaleY: t.scaleY ?? 1, shearX: t.shearX ?? 0, shearY: t.shearY ?? 0, translateX: Math.round((t.translateX ?? 0) * k + dx), translateY: Math.round((t.translateY ?? 0) * k + dy), unit: "EMU" } } }], group);
  }
  function resizeStart(e: React.PointerEvent, handle: string) {
    e.stopPropagation();
    e.preventDefault();
    const el = topEl(selId);
    if (!el || ro) return;
    const b = boxOf(el.transform ?? {}, el.size);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const calc = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / s;
      const dy = (ev.clientY - y0) / s;
      let { x, y, w, h } = b;
      if (handle.includes("e")) w = Math.max(20000, b.w + dx);
      if (handle.includes("s")) h = Math.max(b.h0 ? 20000 : 0, b.h + dy);
      if (handle.includes("w")) (w = Math.max(20000, b.w - dx)), (x = b.x + b.w - w);
      if (handle.includes("n")) (h = Math.max(b.h0 ? 20000 : 0, b.h - dy)), (y = b.y + b.h - h);
      return { x, y, w, h };
    };
    const move = (ev: PointerEvent) => setPreview({ id: el.objectId, dx: 0, dy: 0, box: calc(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPreview(null);
      const n = calc(ev);
      if (Math.abs(n.w - b.w) < 1 && Math.abs(n.h - b.h) < 1 && n.x === b.x && n.y === b.y) return;
      const t = el.transform ?? {};
      eng.run("Resize", [
        {
          updatePageElementTransform: {
            objectId: el.objectId,
            applyMode: "ABSOLUTE",
            transform: { scaleX: Math.sign(t.scaleX ?? 1) * (n.w / (b.w0 || 1)), scaleY: b.h0 ? Math.sign(t.scaleY ?? 1) * (n.h / b.h0) : (t.scaleY ?? 1), shearX: 0, shearY: 0, translateX: Math.round(n.x), translateY: Math.round(n.y), unit: "EMU" },
          },
        },
      ]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // â”€â”€ Changes â”€â”€
  function guard() {
    if (readOnly) return say("This presentation is view only here."), false;
    if (phone) return say("Edit slides on a larger screen; on a phone you can view and present."), false;
    if (eng.locked) return say("Saving to Googleâ€¦ one moment."), false;
    return true;
  }
  const center = (w: number, h: number) => ({ size: { width: { magnitude: w, unit: "EMU" }, height: { magnitude: h, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: Math.round((PW - w) / 2), translateY: Math.round((PH - h) / 2), unit: "EMU" } });
  function addText() {
    if (!guard() || !slide) return;
    const oid = newId();
    if (eng.run("Insert text box", [{ createShape: { objectId: oid, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: slide.objectId, ...center(3600000, 600000) } } }])) {
      setSelId(oid);
      editSel.current = { a: 0, f: 0 };
      setEdit({ id: oid });
    }
  }
  function addShape(type: string) {
    if (!guard() || !slide) return;
    const oid = newId();
    if (eng.run("Insert shape", [{ createShape: { objectId: oid, shapeType: type, elementProperties: { pageObjectId: slide.objectId, ...center(2200000, 1400000) } } }])) setSelId(oid);
  }
  function addLine() {
    if (!guard() || !slide) return;
    const oid = newId();
    if (eng.run("Insert line", [{ createLine: { objectId: oid, lineCategory: "STRAIGHT", elementProperties: { pageObjectId: slide.objectId, ...center(3000000, 0) } } }])) setSelId(oid);
  }
  function structural(label: string, reqs: Req[], undo: Req[] | null) {
    if (!guard()) return false;
    return eng.apply({ label, redo: reqs, undo }, { structural: true });
  }
  function addTable(rows: number, cols: number) {
    if (!slide) return;
    const oid = newId();
    if (structural("Insert table", [{ createTable: { objectId: oid, rows, columns: cols, elementProperties: { pageObjectId: slide.objectId, ...center(Math.min(PW - 600000, cols * 1800000), rows * 400000) } } }], [{ deleteObject: { objectId: oid } }])) setSelId(oid);
  }
  function addImage(url: string, ratio: number | null) {
    if (!slide) return;
    const oid = newId();
    const w = 3600000;
    const h = Math.round(w * (ratio ?? 0.6));
    if (structural("Insert image", [{ createImage: { objectId: oid, url, elementProperties: { pageObjectId: slide.objectId, ...center(w, Math.min(h, PH - 400000)) } } }], [{ deleteObject: { objectId: oid } }])) setSelId(oid);
  }
  function deleteSel() {
    if (!guard() || !selId) return;
    if (eng.run("Delete", [{ deleteObject: { objectId: selId } }])) {
      setSelId(null);
      setEdit(null);
    }
  }
  function duplicateSel() {
    if (!selId) return;
    const nid = newId();
    if (structural("Duplicate", [{ duplicateObject: { objectId: selId, objectIds: { [selId]: nid } } }], [{ deleteObject: { objectId: nid } }])) setSelId(nid);
  }
  function addSlide(layoutId?: string) {
    if (!pres) return;
    const sid = newId("s");
    const lay = layoutId ? { layoutId } : (pres.layouts ?? []).some((l: Json) => l.layoutProperties?.name === "TITLE_AND_BODY") ? { predefinedLayout: "TITLE_AND_BODY" } : { predefinedLayout: "BLANK" };
    if (structural("New slide", [{ createSlide: { objectId: sid, insertionIndex: idx + 1, slideLayoutReference: lay } }], [{ deleteObject: { objectId: sid } }])) {
      setCurId(sid);
      setSelId(null);
    }
  }
  function duplicateSlide() {
    if (!slide) return;
    const sid = newId("s");
    if (structural("Duplicate slide", [{ duplicateObject: { objectId: slide.objectId, objectIds: { [slide.objectId]: sid } } }], [{ deleteObject: { objectId: sid } }])) setCurId(sid);
  }
  function deleteSlide() {
    if (!guard() || !slide) return;
    if (slides.length < 2) return say("A presentation needs at least one slide.");
    const next = slides[idx + 1] ?? slides[idx - 1];
    if (eng.run("Delete slide", [{ deleteObject: { objectId: slide.objectId } }])) {
      setCurId(next?.objectId ?? null);
      setSelId(null);
    }
  }
  function moveSlide(from: number, to: number) {
    if (!guard() || from === to || to < 0 || to >= slides.length) return;
    eng.run("Move slide", [{ updateSlidesPosition: { slideObjectIds: [slides[from].objectId], insertionIndex: to > from ? to + 1 : to } }]);
  }

  // â”€â”€ Text style: the selection while editing, otherwise all of the selected shape's text â”€â”€
  function styleTarget(): { tg: Json; range: Json; text: Json } | null {
    if (edit) {
      const sel = (editEl && selIn(editEl)) ?? editSel.current ?? { a: 0, f: 0 };
      const a = Math.min(sel.a, sel.f);
      const b = Math.max(sel.a, sel.f);
      const text = holder()?.text;
      return { tg: target(), range: a < b ? fixed(a, b) : { type: "ALL" }, text };
    }
    const el = topEl(selId);
    if (!el?.shape) return null;
    return { tg: { objectId: el.objectId }, range: { type: "ALL" }, text: el.shape.text };
  }
  function textStyle(style: Json, fields: string, label: string) {
    if (!guard()) return;
    const t = styleTarget();
    if (!t) return say("Select a text box or shape first.");
    if (!t.text?.textElements?.length) return say("Add some text first.");
    eng.run(label, [{ updateTextStyle: { ...t.tg, textRange: t.range, style, fields } }]);
  }
  function align(al: string) {
    if (!guard()) return;
    const t = styleTarget();
    if (!t) return say("Select a text box or shape first.");
    if (!t.text?.textElements?.length) return say("Add some text first.");
    eng.run("Align", [{ updateParagraphStyle: { ...t.tg, textRange: t.range, style: { alignment: al }, fields: "alignment" } }]);
  }
  function curText(): Json {
    const el0 = edit ? findEl(pres, edit.id)?.el : topEl(selId);
    const text = edit ? holder()?.text : el0?.shape?.text;
    const t = el0 ? { text, tg: { objectId: el0.objectId } } : null;
    if (!t?.text) return {};
    const f = toFlat(t.text);
    const at = edit && editSelUi ? Math.max(0, Math.min(editSelUi.a, editSelUi.f) - (editSelUi.a === editSelUi.f ? 1 : 0)) : 0;
    const el = findEl(pres, t.tg.objectId)?.el;
    return { ...(el ? baseStyle(pres, el).ts : {}), ...(f.chars[at]?.st ?? f.chars[0]?.st ?? {}), _ps: f.paras[0]?.style ?? {} };
  }
  const toggle = (k: "bold" | "italic" | "underline" | "strikethrough") => textStyle({ [k]: !curText()[k] }, k, k[0].toUpperCase() + k.slice(1));
  function shapeColour(which: "fill" | "border", hex: string | null) {
    if (!guard()) return;
    const el = topEl(selId);
    if (!el?.shape) return say("Select a shape first.");
    const key = which === "fill" ? "shapeBackgroundFill" : "outline";
    const sub = which === "fill" ? "solidFill.color" : "outlineFill.solidFill.color";
    const sp = hex ? (which === "fill" ? { shapeBackgroundFill: { propertyState: "RENDERED", solidFill: { color: { rgbColor: fromHex(hex) } } } } : { outline: { propertyState: "RENDERED", outlineFill: { solidFill: { color: { rgbColor: fromHex(hex) } } } } }) : { [key]: { propertyState: "NOT_RENDERED" } };
    eng.run(which === "fill" ? "Fill colour" : "Border colour", [{ updateShapeProperties: { objectId: el.objectId, shapeProperties: sp, fields: hex ? `${key}.${sub},${key}.propertyState` : `${key}.propertyState` } }]);
  }

  // â”€â”€ Speaker notes â”€â”€
  const notesId: string | undefined = slide?.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
  const notesShape = notesId && pres ? findEl(pres, notesId)?.el : null;
  const notesText = plainOf(notesShape?.shape?.text);
  function commitNotes(text: string) {
    if (!notesId || !notesShape || ro) return;
    const was = plainOf(notesShape.shape?.text);
    if (text === was) return;
    let pre = 0;
    while (pre < text.length && pre < was.length && text[pre] === was[pre]) pre++;
    let suf = 0;
    while (suf < text.length - pre && suf < was.length - pre && text[text.length - 1 - suf] === was[was.length - 1 - suf]) suf++;
    const reqs: Req[] = [];
    if (was.length - suf > pre) reqs.push({ deleteText: { objectId: notesId, textRange: fixed(pre, was.length - suf) } });
    const mid = text.slice(pre, text.length - suf);
    if (mid) reqs.push({ insertText: { objectId: notesId, insertionIndex: pre, text: mid } });
    eng.run("Speaker notes", reqs, `notes:${notesId}`);
  }

  // â”€â”€ Undo â”€â”€
  function undo() {
    if (!guard()) return;
    if (!eng.undo()) say("Nothing to undo.");
  }
  function redo() {
    if (!guard()) return;
    if (!eng.redo()) say("Nothing to redo.");
  }

  function onStageKey(e: React.KeyboardEvent) {
    if (edit) {
      if (e.key === "Escape") return e.preventDefault(), setEdit(null), stage.current?.focus();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "b") return e.preventDefault(), toggle("bold");
      if (mod && e.key.toLowerCase() === "i") return e.preventDefault(), toggle("italic");
      if (mod && e.key.toLowerCase() === "u") return e.preventDefault(), toggle("underline");
      if (mod && e.key.toLowerCase() === "z") return e.preventDefault(), e.shiftKey ? redo() : undo();
      if (mod && e.key.toLowerCase() === "y") return e.preventDefault(), redo();
      return;
    }
    if ((e.target as HTMLElement).closest("textarea,input")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === "z") return e.preventDefault(), e.shiftKey ? redo() : undo();
    if (mod && k.toLowerCase() === "y") return e.preventDefault(), redo();
    if (mod && k.toLowerCase() === "m") return e.preventDefault(), addSlide();
    if (mod && k === "Enter") return e.preventDefault(), setPresent(idx);
    if (mod && k.toLowerCase() === "d" && selId) return e.preventDefault(), duplicateSel();
    if (k === "Escape") return setSelId(null);
    if ((k === "Delete" || k === "Backspace") && selId) return e.preventDefault(), deleteSel();
    if (k === "Enter" && selId) {
      const el = topEl(selId);
      if (el?.shape) return e.preventDefault(), startEdit(selId, selId);
    }
    if (selId && k.startsWith("Arrow")) {
      e.preventDefault();
      if (!guard()) return;
      const step = (e.shiftKey ? 10 : 1) / s;
      nudge(selId, k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0, k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0, "Move", `nudge:${selId}`);
      return;
    }
    if (!selId && (k === "ArrowDown" || k === "PageDown") && slides[idx + 1]) return e.preventDefault(), setCurId(slides[idx + 1].objectId);
    if (!selId && (k === "ArrowUp" || k === "PageUp") && slides[idx - 1]) return e.preventDefault(), setCurId(slides[idx - 1].objectId);
  }

  // â”€â”€ File actions â”€â”€
  async function post(body: Record<string, unknown>) {
    const r = await fetch(`/api/google/slides/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
  const exportUrl = (format: string, inline = false) => `/api/google/slides/${encodeURIComponent(id)}?view=export&format=${format}&name=${encodeURIComponent(meta?.file.name ?? "presentation")}${inline ? "&inline=1" : ""}`;
  async function download(format: string) {
    await eng.flush();
    const a = document.createElement("a");
    a.href = exportUrl(format);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function askAi() {
    if (!pres || !meta) return;
    const texts = slides
      .map((sl, i) => `Slide ${i + 1}: ${(sl.pageElements ?? []).map((e: Json) => plainOf(e.shape?.text)).filter(Boolean).join(" / ")}`)
      .join("\n")
      .slice(0, 1600);
    window.open(`/home/chat?prompt=${encodeURIComponent(`About my Google Slides presentation "${meta.file.name}" (${slides.length} slides):\n\n${texts}\n\nSummarise it and suggest how to improve it.`)}`, "_blank");
  }


  if (!meta || !pres) {
    const err = eng.loadError;
    return (
      <div className="sx-root ox-slides" style={{ height: "60vh" }}>
        <div style={{ margin: "auto", maxWidth: 460, textAlign: "center", padding: 24 }}>
          {!err ? (
            <p style={{ color: "var(--ix-muted)", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <LoaderCircle size={16} className="animate-spin" /> Opening the presentationâ€¦
            </p>
          ) : (
            <>
              <h1 style={{ fontSize: 18, fontWeight: 600 }}>{err.connect ? "Connect Google Drive" : "Couldn't open this presentation"}</h1>
              <p style={{ color: "var(--ix-muted)", marginTop: 6 }}>{err.connect ? "Connect your Google account to open and edit your Google Slides here." : err.text}</p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
                {(err.connect || err.reconnect) && (
                  <a className="sx-btn primary" href={`/api/google/connect?back=/slides/${encodeURIComponent(id)}`}>
                    {err.connect ? "Connect Google Drive" : "Reconnect Google"}
                  </a>
                )}
                <NextLink className="sx-btn" href="/slides">
                  Back to Slides
                </NextLink>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const selEl = topEl(selId);
  const ct = curText();
  const saveState = eng.save;
  const thumbFor = (sl: Json, size = "MEDIUM") => {
    const b = slideOf(eng.base, sl.objectId);
    const h = slideHash(sl);
    if (!b || slideHash(b) !== h || eng.busy || badThumbs.has(`${sl.objectId}:${h}:${size}`)) return null;
    return { url: `/api/google/slides/${encodeURIComponent(id)}?view=thumb&page=${encodeURIComponent(sl.objectId)}&size=${size}&v=${h}`, key: `${sl.objectId}:${h}:${size}` };
  };
  const layouts: Json[] = pres.layouts ?? [];
  const layoutItems: Item[] = layouts.map((l) => ({ label: l.layoutProperties?.displayName ?? l.layoutProperties?.name ?? "Layout", onClick: () => addSlide(l.objectId) }));
  const tb = (label: string, icon: React.ReactNode, onClick: () => void, opts: { pressed?: boolean; disabled?: boolean; phone?: boolean } = {}) => <TB label={label} icon={icon} onClick={onClick} pressed={opts.pressed} phone={opts.phone} disabled={opts.disabled ?? ro} />;
  const sep = <span className="sx-tbsep sx-hide-phone" />;
  const shapeItems: Item[] = SHAPES.map(([t, l]) => ({ label: l, onClick: () => addShape(t) }));
  const tableItems: Item[] = [
    [1, 2],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 4],
  ].map(([r, c]) => ({ label: `${r} Ã— ${c} table`, onClick: () => addTable(r, c) }));
  const menus: Record<string, Item[]> = {
    File: [
      {
        label: "New presentation",
        icon: <Plus size={15} />,
        disabled: !perms.can("slides.google.edit"),
        onClick: async () => {
          try {
            const { file } = await googlePost({ action: "create", kind: "slides", name: "Untitled presentation" });
            window.open(`/slides/${file.id}`, "_blank");
          } catch (e) {
            say((e as Error).message);
          }
        },
      },
      { label: "Open", icon: <Presentation size={15} />, onClick: () => router.push("/slides") },
      {
        label: "Make a copy",
        icon: <Copy size={15} />,
        disabled: !perms.can("slides.google.edit"),
        onClick: async () => {
          try {
            const { file } = await googlePost({ action: "copy", id, name: `Copy of ${meta.file.name}` });
            window.open(`/slides/${file.id}`, "_blank");
          } catch (e) {
            say((e as Error).message);
          }
        },
      },
      "-",
      { label: "Rename", icon: <Pencil size={15} />, disabled: readOnly, onClick: () => titleInput.current?.focus() },
      { label: "Move to trash", icon: <Trash size={15} />, danger: true, disabled: readOnly || !perms.can("slides.google.edit"), onClick: () => setDialog({ kind: "trash" }) },
      "-",
      {
        label: "Download",
        icon: <Download size={15} />,
        sub: [
          ["pptx", "Microsoft PowerPoint (.pptx)"],
          ["pdf", "PDF document (.pdf)"],
          ["odp", "OpenDocument (.odp)"],
          ["txt", "Plain text (.txt)"],
        ].map(([f, l]) => ({ label: l, onClick: () => void download(f) })),
      },
      { label: "Print", icon: <Printer size={15} />, onClick: () => void eng.flush().then(() => window.open(exportUrl("pdf", true), "_blank")) },
      "-",
      { label: "Open in Google Slides", icon: <ExternalLink size={15} />, onClick: () => window.open(meta.file.webViewLink, "_blank", "noopener,noreferrer") },
    ],
    Edit: [
      { label: "Undo", icon: <Undo2 size={15} />, hint: "Ctrl+Z", disabled: ro || !eng.canUndo, onClick: undo },
      { label: "Redo", icon: <Redo2 size={15} />, hint: "Ctrl+Y", disabled: ro || !eng.canRedo, onClick: redo },
      "-",
      { label: "Duplicate", hint: "Ctrl+D", disabled: ro || !selId, onClick: duplicateSel },
      { label: "Delete", icon: <Trash size={15} />, hint: "Delete", disabled: ro || !selId, onClick: deleteSel },
    ],
    View: [
      { label: "Present", icon: <Play size={15} />, hint: "Ctrl+Enter", onClick: () => setPresent(idx) },
      { label: "Speaker notes", checked: showNotes, onClick: () => setShowNotes((v) => !v) },
      { label: "Zoom", sub: [{ label: "Fit", checked: zoom === "fit", onClick: () => setZoom("fit") }, ...ZOOMS.map((v) => ({ label: `${Math.round(v * 100)}%`, checked: zoom === v, onClick: () => setZoom(v) }))] },
    ],
    Insert: [
      { label: "Text box", icon: <Type size={15} />, disabled: ro, onClick: addText },
      { label: "Image", icon: <ImagePlus size={15} />, disabled: ro, onClick: () => setDialog({ kind: "image" }) },
      { label: "Shape", icon: <Shapes size={15} />, disabled: ro, sub: shapeItems },
      { label: "Line", icon: <Minus size={15} />, disabled: ro, onClick: addLine },
      { label: "Table", icon: <Table size={15} />, disabled: ro, sub: tableItems },
      "-",
      { label: "New slide", icon: <Plus size={15} />, hint: "Ctrl+M", disabled: ro, sub: layoutItems.length ? layoutItems : undefined, onClick: () => addSlide() },
    ],
    Format: [
      { label: "Bold", hint: "Ctrl+B", checked: !!ct.bold, disabled: ro, onClick: () => toggle("bold") },
      { label: "Italic", hint: "Ctrl+I", checked: !!ct.italic, disabled: ro, onClick: () => toggle("italic") },
      { label: "Underline", hint: "Ctrl+U", checked: !!ct.underline, disabled: ro, onClick: () => toggle("underline") },
      { label: "Strikethrough", checked: !!ct.strikethrough, disabled: ro, onClick: () => toggle("strikethrough") },
      "-",
      { label: "Align left", disabled: ro, onClick: () => align("START") },
      { label: "Align centre", disabled: ro, onClick: () => align("CENTER") },
      { label: "Align right", disabled: ro, onClick: () => align("END") },
    ],
    Slide: [
      { label: "New slide", icon: <Plus size={15} />, disabled: ro, sub: layoutItems.length ? layoutItems : undefined, onClick: () => addSlide() },
      { label: "Duplicate slide", icon: <Copy size={15} />, disabled: ro, onClick: duplicateSlide },
      { label: "Delete slide", icon: <Trash size={15} />, danger: true, disabled: ro || slides.length < 2, onClick: deleteSlide },
      "-",
      { label: "Move slide up", disabled: ro || idx === 0, onClick: () => moveSlide(idx, idx - 1) },
      { label: "Move slide down", disabled: ro || idx >= slides.length - 1, onClick: () => moveSlide(idx, idx + 1) },
    ],
    ...(perms.can("home.ask") ? { Tools: [{ label: "Ask AI about this presentation", icon: <Sparkles size={15} />, onClick: askAi }] as Item[] } : {}),
  };

  // The selection outline and resize handles.
  const selBox = (() => {
    if (!selEl || !slide) return null;
    if (selEl.elementGroup) {
      const bs = boxesOf(slide).filter((b) => b.top === selEl.objectId);
      if (!bs.length) return null;
      const x = Math.min(...bs.map((b) => b.x));
      const y = Math.min(...bs.map((b) => b.y));
      return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y, rot: 0, resize: false };
    }
    const b = boxOf(selEl.transform ?? {}, selEl.size);
    return { ...b, resize: Math.abs(b.rot) < 0.01 && !b.flip && !selEl.line };
  })();
  const pv = preview && selBox && preview.id === selId ? (preview.box ? { ...selBox, ...preview.box } : { ...selBox, x: selBox.x + preview.dx, y: selBox.y + preview.dy }) : selBox;

  return (
    <div ref={root} className="sx-root ox-slides" style={{ height: height ?? "calc(100dvh - 64px)" }}>
      <div className="sx-top">
        <NextLink href="/slides" className="sx-logo sl-logo" title="Slides home" aria-label="Slides home">
          <Presentation size={20} />
        </NextLink>
        <div className="sx-titlebox">
          <div className="sx-titlerow">
            <input
              ref={titleInput}
              className="sx-title"
              aria-label="Presentation name"
              value={titleDraft ?? meta.file.name}
              readOnly={readOnly}
              onChange={(e) => setTitleDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => titleDraft !== null && void rename(titleDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setTitleDraft(null);
              }}
            />
            <button type="button" className={`sx-ibtn ${meta.file.starred ? "starred" : ""}`} title={meta.file.starred ? "Remove star" : "Star"} aria-label={meta.file.starred ? "Remove star" : "Star"} aria-pressed={!!meta.file.starred} onClick={star}>
              <Star size={17} fill={meta.file.starred ? "currentColor" : "none"} />
            </button>
            <span className={`sx-status ${saveState.state === "error" ? "error" : ""}`} role="status" aria-live="polite">
              {saveState.state === "saving" ? (
                <>
                  <LoaderCircle size={14} className="animate-spin" /> Savingâ€¦
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
        <button type="button" className="sx-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => setPresent(idx)} title="Present (Ctrl+Enter)">
          <Play size={15} /> <span className="sx-hide-phone">Slideshow</span>
        </button>
        <a className="sx-ibtn sx-hide-phone" href={meta.file.webViewLink} target="_blank" rel="noopener noreferrer" title="Open in Google Slides" aria-label="Open in Google Slides">
          <ExternalLink size={17} />
        </a>
        <a className="sx-share" href={meta.file.webViewLink} target="_blank" rel="noopener noreferrer" title="Share in Google Slides">
          <Lock size={15} />
          <span className="sx-hide-phone">Share</span>
        </a>
      </div>

      {!meta.connection.canEdit ? (
        <div className="sx-banner">
          <b>View only.</b> Your Google connection was made with read-only access.
          <a href={`/api/google/connect?back=/slides/${encodeURIComponent(id)}`} style={{ color: "var(--ox-ink)", fontWeight: 600, textDecoration: "underline" }}>
            Reconnect Google to allow editing
          </a>
        </div>
      ) : readOnly ? (
        <div className="sx-banner">
          <b>View only.</b> {meta.file.capabilities?.canEdit === false ? "The owner shared this file with you for viewing." : "Editing Google Slides isn't turned on for your role."}
        </div>
      ) : null}

      <div className="sx-toolbar sx-hide-phone" role="toolbar" aria-label="Slide tools">
        <span style={{ display: "inline-flex" }}>
          {tb("New slide (Ctrl+M)", <Plus size={17} />, () => addSlide())}
          <Dropdown title="Choose a layout" disabled={ro} button={<ChevronDown size={13} />} items={layoutItems} />
        </span>
        {tb("Undo (Ctrl+Z)", <Undo2 size={17} />, undo, { disabled: ro || !eng.canUndo })}
        {tb("Redo (Ctrl+Y)", <Redo2 size={17} />, redo, { disabled: ro || !eng.canRedo })}
        {sep}
        <Dropdown
          title="Zoom"
          button={
            <>
              {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`} <ChevronDown size={13} />
            </>
          }
          items={[{ label: "Fit", checked: zoom === "fit", onClick: () => setZoom("fit") }, ...ZOOMS.map((v) => ({ label: `${Math.round(v * 100)}%`, checked: zoom === v, onClick: () => setZoom(v) }))]}
        />
        {sep}
        {tb("Text box", <Type size={17} />, addText)}
        {tb("Insert image", <ImagePlus size={17} />, () => setDialog({ kind: "image" }))}
        <Dropdown title="Shape" disabled={ro} button={<Shapes size={17} />} items={shapeItems} />
        {tb("Line", <Minus size={17} />, addLine)}
        <Dropdown title="Insert table" disabled={ro} button={<Table size={17} />} items={tableItems} />
        {sep}
        {selEl?.shape && (
          <>
            <Dropdown title="Fill colour" disabled={ro} button={<PaintBucket size={17} />}>
              {(close) => <Palette value={undefined} reset="Transparent" onPick={(h) => (close(), shapeColour("fill", h))} />}
            </Dropdown>
            <Dropdown title="Border colour" disabled={ro} button={<SquareDashed size={17} />}>
              {(close) => <Palette value={undefined} reset="Transparent" onPick={(h) => (close(), shapeColour("border", h))} />}
            </Dropdown>
            {sep}
            <Dropdown
              title="Font"
              disabled={ro}
              button={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 80, justifyContent: "space-between" }}>
                  {ct.fontFamily ?? ct.weightedFontFamily?.fontFamily ?? "Arial"} <ChevronDown size={13} />
                </span>
              }
              items={FONTS.map((f) => ({ label: f, onClick: () => textStyle({ fontFamily: f }, "fontFamily", "Font") }))}
            />
            <Dropdown title="Font size" disabled={ro} button={<span style={{ minWidth: 22 }}>{ct.fontSize?.magnitude ?? 18}</span>} items={SIZES.map((n) => ({ label: String(n), checked: ct.fontSize?.magnitude === n, onClick: () => textStyle({ fontSize: { magnitude: n, unit: "PT" } }, "fontSize", "Font size") }))} />
            {tb("Bold (Ctrl+B)", <Bold size={17} />, () => toggle("bold"), { pressed: !!ct.bold })}
            {tb("Italic (Ctrl+I)", <Italic size={17} />, () => toggle("italic"), { pressed: !!ct.italic })}
            {tb("Underline (Ctrl+U)", <Underline size={17} />, () => toggle("underline"), { pressed: !!ct.underline })}
            <Dropdown
              title="Text colour"
              disabled={ro}
              button={
                <span style={{ position: "relative", display: "inline-grid", placeItems: "center", width: 22, height: 24 }}>
                  <Baseline size={17} />
                  <span className="sx-swatchbar" style={{ background: (ct.foregroundColor && cssColor(pres, slide, ct.foregroundColor)) ?? "#000" }} />
                </span>
              }
            >
              {(close) => <Palette value={undefined} reset="Reset" onPick={(h) => (close(), textStyle(h ? { foregroundColor: { opaqueColor: { rgbColor: fromHex(h) } } } : {}, "foregroundColor", "Text colour"))} />}
            </Dropdown>
            {tb("Align left", <TextAlignStart size={17} />, () => align("START"), { pressed: ct._ps?.alignment === "START" })}
            {tb("Align centre", <TextAlignCenter size={17} />, () => align("CENTER"), { pressed: ct._ps?.alignment === "CENTER" })}
            {tb("Align right", <TextAlignEnd size={17} />, () => align("END"), { pressed: ct._ps?.alignment === "END" })}
            {sep}
          </>
        )}
        {selId && tb("Delete", <Trash size={17} />, deleteSel)}
      </div>

      <div className="sl-main">
        <nav className="sl-strip" aria-label="Slides">
          {slides.map((sl, i) => {
            const th = thumbFor(sl);
            const tw = phone ? 116 : 160;
            return (
              <div
                key={sl.objectId}
                className={`sl-thumb ${sl.objectId === slide?.objectId ? "on" : ""} ${dropAt === i ? "drop" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`Slide ${i + 1}`}
                aria-current={sl.objectId === slide?.objectId}
                draggable={!ro}
                onClick={() => (setCurId(sl.objectId), setSelId(null), setEdit(null))}
                onDoubleClick={() => setPresent(i)}
                onKeyDown={(e) => {
                  if (e.key === "Delete" && !ro) deleteSlide();
                  if (e.key === "ArrowDown" && slides[i + 1]) (e.preventDefault(), setCurId(slides[i + 1].objectId));
                  if (e.key === "ArrowUp" && slides[i - 1]) (e.preventDefault(), setCurId(slides[i - 1].objectId));
                }}
                onDragStart={(e) => {
                  dragFrom.current = i;
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", sl.objectId);
                }}
                onDragOver={(e) => {
                  if (dragFrom.current === null) return;
                  e.preventDefault();
                  setDropAt(i);
                }}
                onDragLeave={() => setDropAt(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragFrom.current;
                  dragFrom.current = null;
                  setDropAt(null);
                  if (from === null || from === i) return;
                  eng.run("Move slide", [{ updateSlidesPosition: { slideObjectIds: [slides[from].objectId], insertionIndex: i } }]);
                }}
                onDragEnd={() => ((dragFrom.current = null), setDropAt(null))}
              >
                <span className="n">{i + 1}</span>
                <span className="box" style={{ height: (tw * PH) / PW }}>
                  <SlideView pres={pres} page={sl} s={tw / PW} mini />
                  {th && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="pic" src={th.url} alt="" loading="lazy" draggable={false} onError={() => setBadThumbs((b) => new Set(b).add(th.key))} />
                  )}
                </span>
              </div>
            );
          })}
          {!ro && (
            <button type="button" className="sx-btn sx-hide-phone" style={{ marginLeft: 24, marginTop: 4 }} onClick={() => addSlide()}>
              + New slide
            </button>
          )}
        </nav>
        <div className="sl-work">
          <div
            ref={stage}
            className="sl-stage"
            tabIndex={0}
            onKeyDown={onStageKey}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest(".se.pick,.sl-h")) return;
              setSelId(null);
              setEdit(null);
            }}
            style={{ position: "relative", outline: "none" }}
          >
            {slide ? (
              <SlideView
                pres={pres}
                page={slide}
                s={s}
                preview={preview}
                edit={edit}
                onRoot={setEditEl}
                onDrawn={onDrawn}
                composing={isComposing}
                onDown={(e, top) => onDown(e, top)}
                onDouble={(top, leaf, cell) => startEdit(top, leaf, cell)}
              >
                {pv && (
                  <div className="sl-selbox" style={{ left: pv.x * s, top: pv.y * s, width: Math.max(2, pv.w * s), height: Math.max(2, pv.h * s), transform: `rotate(${pv.rot}deg)` }}>
                    {pv.resize &&
                      !ro &&
                      !edit &&
                      [
                        ["nw", 0, 0],
                        ["n", 50, 0],
                        ["ne", 100, 0],
                        ["e", 100, 50],
                        ["se", 100, 100],
                        ["s", 50, 100],
                        ["sw", 0, 100],
                        ["w", 0, 50],
                      ].map(([h, x, y]) => <span key={h as string} className="sl-h" style={{ left: `${x}%`, top: `${y}%`, cursor: `${h}-resize` }} onPointerDown={(e) => resizeStart(e, h as string)} />)}
                  </div>
                )}
              </SlideView>
            ) : (
              <p style={{ color: "var(--ix-muted)" }}>This presentation has no slides.</p>
            )}
            {eng.locked && <div className="sl-lock" aria-hidden />}
          </div>
          {showNotes && slide && (
            <div className="sl-notes" style={{ height: 110 }}>
              <textarea
                aria-label="Speaker notes"
                placeholder={notesShape ? (ro ? "No speaker notes" : "Click to add speaker notes") : "This slide has no speaker notes box."}
                value={notesDraft && notesDraft.sid === slide.objectId ? notesDraft.text : notesText}
                readOnly={ro || !notesShape}
                onChange={(e) => {
                  const text = e.target.value;
                  setNotesDraft({ sid: slide.objectId, text });
                  eng.setEditing(true);
                  clearTimeout(notesTimer.current);
                  notesTimer.current = setTimeout(() => commitNotes(text), 600);
                }}
                onBlur={() => {
                  clearTimeout(notesTimer.current);
                  if (notesDraft && notesDraft.sid === slide.objectId) commitNotes(notesDraft.text);
                  setNotesDraft(null);
                  eng.setEditing(!!edit);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {present !== null && <Present pres={pres} base={eng.base} id={id} start={present} thumb={(sl) => thumbFor(sl, "LARGE")?.url ?? null} onClose={(i) => (setPresent(null), slides[i] && setCurId(slides[i].objectId))} />}
      {dialog?.kind === "image" && <ImageDialog fileId={id} onClose={() => setDialog(null)} onMessage={say} onInsert={(u, r) => (setDialog(null), addImage(u, r))} />}
      {dialog?.kind === "trash" && (
        <Modal title="Move to trash?" onClose={() => setDialog(null)}>
          <p style={{ color: "var(--ix-muted)", fontSize: 13.5 }}>&ldquo;{meta.file.name}&rdquo; goes to Google Drive&rsquo;s Trash. You can restore it there for 30 days.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button type="button" className="sx-btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="sx-btn primary"
              style={{ background: "#dc2626", borderColor: "#dc2626" }}
              onClick={async () => {
                setDialog(null);
                try {
                  await eng.flush();
                  await googlePost({ action: "trash", id });
                  router.push("/slides?trashed=1");
                } catch (e) {
                  say((e as Error).message);
                }
              }}
            >
              Move to trash
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div role="status" style={{ position: "fixed", left: "50%", bottom: 64, transform: "translateX(-50%)", zIndex: 95, background: "#323232", color: "#fff", padding: "10px 16px", borderRadius: 6, fontSize: 13.5, maxWidth: "calc(100vw - 32px)", boxShadow: "0 4px 14px rgba(0,0,0,.3)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/** Full-screen slideshow: Google's large slide pictures (drawn here when a picture isn't available), with keys. */
function Present({ pres, start, thumb, onClose }: { pres: Json; base: Json; id: string; start: number; thumb: (sl: Json) => string | null; onClose: (i: number) => void }) {
  const [i, setI] = useState(start);
  const [ui, setUi] = useState(true);
  const [bad, setBad] = useState<Set<number>>(() => new Set());
  const [vw, setVw] = useState({ w: 1280, h: 720 });
  const box = useRef<HTMLDivElement>(null);
  const uiTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const slides: Json[] = pres.slides ?? [];
  const iRef = useRef(i);
  useEffect(() => {
    iRef.current = i;
  }, [i]);
  useEffect(() => {
    const el = box.current;
    el?.requestFullscreen?.().catch(() => {});
    const size = () => setVw({ w: window.innerWidth, h: window.innerHeight });
    size();
    const key = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(e.key)) (e.preventDefault(), setI((x) => Math.min(slides.length - 1, x + 1)));
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(e.key)) (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
      else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(slides.length - 1);
      else if (e.key === "Escape") onClose(iRef.current);
    };
    const fs = () => {
      if (!document.fullscreenElement) onClose(iRef.current);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("resize", size);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", size);
      document.removeEventListener("fullscreenchange", fs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
    // Set up once for the slideshow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sl = slides[i];
  const PW = pres.pageSize?.width?.magnitude ?? 9144000;
  const PH = pres.pageSize?.height?.magnitude ?? 5143500;
  const s = Math.min(vw.w / PW, vw.h / PH);
  const url = sl ? thumb(sl) : null;
  const next = slides[i + 1] ? thumb(slides[i + 1]) : null;
  return (
    <div
      ref={box}
      className={`sl-present ${ui ? "ui" : ""}`}
      role="dialog"
      aria-label="Slideshow"
      onMouseMove={() => {
        setUi(true);
        clearTimeout(uiTimer.current);
        uiTimer.current = setTimeout(() => setUi(false), 2000);
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(".sl-pbar")) return;
        const left = e.clientX < window.innerWidth * 0.3;
        setI((x) => (left ? Math.max(0, x - 1) : Math.min(slides.length - 1, x + 1)));
      }}
    >
      {sl &&
        (url && !bad.has(i) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={`Slide ${i + 1}`} style={{ width: PW * s, height: PH * s }} onError={() => setBad((b) => new Set(b).add(i))} />
        ) : (
          <SlideView pres={pres} page={sl} s={s} mini />
        ))}
      {/* Warm the next picture. */}
      {next && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={next} alt="" style={{ display: "none" }} />
      )}
      <div className="sl-pbar">
        <button type="button" className="sx-ibtn" aria-label="Previous slide" onClick={() => setI((x) => Math.max(0, x - 1))}>
          <ChevronLeft size={18} />
        </button>
        <span>
          {i + 1} / {slides.length}
        </span>
        <button type="button" className="sx-ibtn" aria-label="Next slide" onClick={() => setI((x) => Math.min(slides.length - 1, x + 1))}>
          <ChevronRight size={18} />
        </button>
        <button type="button" className="sx-ibtn" aria-label="Exit slideshow" onClick={() => onClose(i)}>
          <X size={18} />
        </button>
      </div>
    </div>
  );
}

function TB(p: { label: string; icon: React.ReactNode; onClick: () => void; pressed?: boolean; disabled?: boolean; phone?: boolean }) {
  return (
    <button type="button" className={`sx-tb ${p.phone ? "" : "sx-hide-phone"}`} title={p.label} aria-label={p.label} aria-pressed={p.pressed} disabled={p.disabled} onMouseDown={(e) => e.preventDefault()} onClick={p.onClick}>
      {p.icon}
    </button>
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

/** An image by URL, or uploaded from the computer to the person's Drive. */
function ImageDialog(p: { fileId: string; onClose: () => void; onInsert: (url: string, ratio: number | null) => void; onMessage: (t: string) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ratioOf = (src: string) =>
    new Promise<number | null>((res) => {
      const img = new Image();
      img.onload = () => res(img.naturalWidth ? img.naturalHeight / img.naturalWidth : null);
      img.onerror = () => res(null);
      img.src = src;
      setTimeout(() => res(null), 4000);
    });
  async function upload(f: File) {
    setBusy(true);
    const local = URL.createObjectURL(f);
    const r0 = await ratioOf(local);
    URL.revokeObjectURL(local);
    const form = new FormData();
    form.append("file", f);
    const r = await fetch(`/api/google/slides/${encodeURIComponent(p.fileId)}`, { method: "POST", body: form }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok || !d.uri) return p.onMessage(d.error ?? "Couldn't upload the image.");
    p.onInsert(d.uri, r0);
  }
  return (
    <Modal title="Insert image" onClose={p.onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const u = url.trim();
          if (!/^https:\/\//i.test(u)) return p.onMessage("Use an https:// link to an image that's publicly reachable.");
          setBusy(true);
          const r0 = await ratioOf(u);
          setBusy(false);
          p.onInsert(u, r0);
        }}
        style={{ display: "grid", gap: 10 }}
      >
        <label style={{ fontSize: 13 }}>
          By URL
          <input autoFocus aria-label="Image URL" className="sx-input" style={{ width: "100%", marginTop: 4 }} placeholder="https://â€¦" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <p style={{ fontSize: 12, color: "var(--ix-muted)" }}>Or upload one: it&rsquo;s saved to your Drive and shared by link only until Google has inserted it.</p>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="sx-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Workingâ€¦" : "Upload from computer"}
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
