"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, Bold, ChevronDown, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered,
  Redo2, RemoveFormatting, TextQuote, Underline, Undo2, Unlink, ALargeSmall, Type,
} from "lucide-react";
import { htmlToText } from "@/lib/mail/compose";

/**
 * Gmail-style rich text for the compose window: a contentEditable body with
 * the browser's own editing commands (so undo and redo cover everything
 * typed, pasted and formatted), a toolbar, Gmail's shortcuts, and paste that
 * keeps basic formatting from Word, Google Docs and web pages while dropping
 * everything else. No editor library: the commands it needs are built in,
 * and what it writes (font, b, i, u, ul/ol, blockquote, a) is what mail
 * clients render best. The server sanitizes again before sending.
 */
export type RichEditorHandle = { html: () => string; text: () => string; focus: () => void; isEmpty: () => boolean };

const FONTS = [
  { label: "Sans Serif", face: "arial, sans-serif" },
  { label: "Serif", face: "'times new roman', serif" },
  { label: "Fixed width", face: "monospace" },
];
// <font size>: Gmail's own sizes. 2 ("small") is the body's normal size.
const SIZES = [
  { label: "Small", size: "1", px: 10 },
  { label: "Normal", size: "2", px: 13 },
  { label: "Large", size: "4", px: 18 },
  { label: "Huge", size: "6", px: 32 },
];
const COLORS = [
  "#000000", "#444444", "#666666", "#999999", "#cccccc", "#ffffff",
  "#e11d48", "#ea580c", "#ca8a04", "#0d9488", "#4f46e5", "#9333ea",
  "#9f1239", "#9a3412", "#854d0e", "#115e59", "#3730a3", "#6b21a8",
];
const ALIGN = [
  { label: "Left", cmd: "justifyLeft", icon: <AlignLeft size={15} /> },
  { label: "Centre", cmd: "justifyCenter", icon: <AlignCenter size={15} /> },
  { label: "Right", cmd: "justifyRight", icon: <AlignRight size={15} /> },
  { label: "Justify", cmd: "justifyFull", icon: <AlignJustify size={15} /> },
];
const QUOTE_STYLE = "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";

// ── Paste: keep structure and basic formatting, drop the rest
const KEEP = new Set(["P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "SUB", "SUP", "A", "UL", "OL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "PRE", "CODE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "SPAN", "FONT", "IMG", "HR"]);
const DROP = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "HEAD", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "XML", "NOSCRIPT", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "FORM", "VIDEO", "AUDIO", "CANVAS"]);
const BLOCKS: Record<string, string> = { H5: "P", H6: "P", SECTION: "DIV", ARTICLE: "DIV", HEADER: "DIV", FOOTER: "DIV", MAIN: "DIV", ASIDE: "DIV", NAV: "DIV", FIGURE: "DIV", FIGCAPTION: "DIV", DT: "DIV", DD: "DIV", DL: "DIV", CENTER: "DIV" };
const STYLE_KEEP = ["font-weight", "font-style", "text-decoration", "text-decoration-line", "color", "background-color", "text-align"];

function cleanStyle(el: HTMLElement) {
  const out: string[] = [];
  for (const p of STYLE_KEEP) {
    const v = el.style.getPropertyValue(p).trim();
    if (!v || /url\(|expression/i.test(v)) continue;
    // Defaults that pasted text carries everywhere would only fight the editor.
    if (p === "color" && /^(rgb\(0, 0, 0\)|#000000|black|windowtext|inherit|initial)$/i.test(v)) continue;
    if (p === "background-color" && /^(transparent|rgba\(0, 0, 0, 0\)|rgb\(255, 255, 255\)|#ffffff|white|inherit|initial)$/i.test(v)) continue;
    if (p === "font-weight" && /^(normal|400|inherit|initial)$/.test(v)) continue;
    if (p === "font-style" && /^(normal|inherit|initial)$/.test(v)) continue;
    if ((p === "text-decoration" || p === "text-decoration-line") && /^(none|inherit|initial)/.test(v)) continue;
    if (p === "text-align" && /^(start|left|inherit|initial)$/.test(v)) continue;
    out.push(`${p}:${v}`);
  }
  return out.join(";");
}

const safeHref = (h: string) => (/^(https?:|mailto:|tel:)/i.test(h.trim()) ? h.trim() : null);

export function cleanPastedHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (src: Node, dst: Node) => {
    for (const n of Array.from(src.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        dst.appendChild(document.createTextNode(n.textContent ?? ""));
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as HTMLElement;
      const tag = el.tagName.toUpperCase();
      if (DROP.has(tag)) continue;
      const style = cleanStyle(el);
      // Google Docs wraps the whole paste in <b style="font-weight:normal">.
      const fakeBold = (tag === "B" || tag === "STRONG") && /^(normal|400)$/.test(el.style.fontWeight);
      const as = BLOCKS[tag] ?? tag;
      if (!KEEP.has(as) || fakeBold || ((as === "SPAN" || as === "FONT") && !style)) {
        walk(el, dst);
        continue;
      }
      if (as === "IMG") {
        const src2 = el.getAttribute("src") ?? "";
        if (!/^https:\/\//i.test(src2)) continue;
        const img = document.createElement("img");
        img.src = src2;
        img.alt = el.getAttribute("alt") ?? "";
        dst.appendChild(img);
        continue;
      }
      const out = document.createElement(as === "FONT" ? "span" : as.toLowerCase());
      if (style) out.setAttribute("style", style);
      if (as === "A") {
        const href = safeHref(el.getAttribute("href") ?? "");
        if (!href) {
          walk(el, dst);
          continue;
        }
        out.setAttribute("href", href);
      }
      if ((as === "TD" || as === "TH") && el.getAttribute("colspan")) out.setAttribute("colspan", el.getAttribute("colspan")!);
      walk(el, out);
      dst.appendChild(out);
    }
  };
  const root = document.createElement("div");
  walk(doc.body, root);
  return root.innerHTML;
}

const linkFor = (s: string) => {
  const v = s.trim();
  if (!v) return "";
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  return `https://${v}`;
};

type MenuId = "font" | "size" | "color" | "align";

const keep = (e: React.MouseEvent) => e.preventDefault(); // toolbar clicks keep the editor's selection

function Tool({ label, keys, pressed, onClick, children }: { label: string; keys?: string; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="mail-tool" title={keys ? `${label} (${keys})` : label} aria-label={label} aria-pressed={pressed} onMouseDown={keep} onClick={onClick}>
      {children}
    </button>
  );
}

function MenuButton({ label, expanded, onToggle, children }: { label: string; expanded: boolean; onToggle: (left: number) => void; children: React.ReactNode }) {
  return (
    <button type="button" className="mail-tool" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={expanded} onMouseDown={keep} onClick={(e) => onToggle(e.currentTarget.offsetLeft)}>
      {children}
      <ChevronDown size={12} />
    </button>
  );
}

export default function RichEditor({ initialHtml, caretAtStart, placeholder, ref }: { initialHtml: string; caretAtStart?: boolean; placeholder?: string; ref?: Ref<RichEditorHandle> }) {
  const el = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [menu, setMenu] = useState<{ id: MenuId; left: number } | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [link, setLink] = useState<null | { text: string; url: string; editing: boolean }>(null);
  const linkTarget = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const div = el.current;
    if (!div) return;
    div.innerHTML = initialHtml;
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("defaultParagraphSeparator", false, "div");
    div.focus();
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(div);
      r.collapse(caretAtStart ?? true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    // The content is set once; later changes come from typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inEditor = (n: Node | null) => !!n && !!el.current?.contains(n);

  const refresh = useCallback(() => {
    const sel = window.getSelection();
    if (!sel?.rangeCount || !inEditor(sel.anchorNode)) return;
    saved.current = sel.getRangeAt(0).cloneRange();
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    setActive({ bold: q("bold"), italic: q("italic"), underline: q("underline"), insertOrderedList: q("insertOrderedList"), insertUnorderedList: q("insertUnorderedList") });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
  }, [refresh]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element | null)?.closest?.(".mail-menu, [aria-haspopup='menu']")) setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const restore = () => {
    const div = el.current;
    if (!div) return;
    const sel = window.getSelection();
    // Already editing here: leave the caret alone (re-placing it would drop a pending bold/italic toggle).
    if (document.activeElement === div && sel?.rangeCount && inEditor(sel.anchorNode)) return;
    div.focus();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
  };

  const exec = (cmd: string, value?: string) => {
    restore();
    document.execCommand(cmd, false, value);
    setMenu(null);
    refresh();
  };

  const quote = () => {
    restore();
    // Toggle: inside a quote, take it out; otherwise quote the block.
    const sel = window.getSelection();
    const inside = sel?.anchorNode && (sel.anchorNode.nodeType === 1 ? (sel.anchorNode as Element) : sel.anchorNode.parentElement)?.closest("blockquote.mail-q");
    if (inside && el.current?.contains(inside)) document.execCommand("outdent");
    else {
      document.execCommand("formatBlock", false, "blockquote");
      const node = window.getSelection()?.anchorNode;
      const bq = (node?.nodeType === 1 ? (node as Element) : node?.parentElement)?.closest("blockquote");
      if (bq && el.current?.contains(bq)) bq.className = "mail-q";
    }
    refresh();
  };

  const anchorAtCaret = () => {
    const sel = window.getSelection();
    const n = sel?.anchorNode;
    const a = (n?.nodeType === 1 ? (n as Element) : n?.parentElement)?.closest("a");
    return a && el.current?.contains(a) ? (a as HTMLAnchorElement) : null;
  };

  const openLink = () => {
    restore();
    const a = anchorAtCaret();
    linkTarget.current = a;
    const sel = window.getSelection();
    saved.current = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : saved.current;
    setMenu(null);
    setLink({ text: a ? a.textContent ?? "" : sel?.toString() ?? "", url: a ? a.getAttribute("href") ?? "" : "", editing: !!a });
  };

  const applyLink = () => {
    if (!link) return;
    const url = linkFor(link.url);
    const a = linkTarget.current;
    restore();
    if (!url) {
      if (a) document.execCommand("unlink");
    } else if (a) {
      a.setAttribute("href", url);
      if (link.text.trim() && link.text !== a.textContent) a.textContent = link.text;
    } else {
      const sel = window.getSelection();
      const text = link.text.trim() || link.url.trim();
      if (!sel?.rangeCount || sel.isCollapsed || (link.text && link.text !== sel.toString())) {
        const node = document.createElement("a");
        node.href = url;
        node.textContent = text;
        document.execCommand("insertHTML", false, node.outerHTML);
      } else document.execCommand("createLink", false, url);
    }
    setLink(null);
    linkTarget.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (!e.shiftKey && !e.altKey && (k === "b" || k === "i" || k === "u")) {
      e.preventDefault();
      exec(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
    } else if (!e.shiftKey && k === "k") {
      e.preventDefault();
      openLink();
    } else if (e.shiftKey && (e.code === "Digit7" || e.code === "Digit8")) {
      e.preventDefault();
      exec(e.code === "Digit7" ? "insertOrderedList" : "insertUnorderedList");
    } else if (e.shiftKey && e.code === "Digit9") {
      e.preventDefault();
      quote();
    } else if (!e.shiftKey && (e.key === "[" || e.key === "]")) {
      e.preventDefault();
      exec(e.key === "[" ? "outdent" : "indent");
    } else if (k === "\\") {
      e.preventDefault();
      exec("removeFormat");
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    e.preventDefault();
    if (html) document.execCommand("insertHTML", false, cleanPastedHtml(html));
    else if (text) document.execCommand("insertText", false, text);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    // Files dropped on the body would otherwise open in the tab.
    if (e.dataTransfer.files.length) e.preventDefault();
  };

  useImperativeHandle(
    ref,
    () => ({
      html: () => {
        const div = el.current;
        if (!div) return "";
        const copy = div.cloneNode(true) as HTMLDivElement;
        // Quotes made with the toolbar look the same everywhere: inline style, no class.
        copy.querySelectorAll("blockquote.mail-q").forEach((b) => {
          b.removeAttribute("class");
          b.setAttribute("style", QUOTE_STYLE);
        });
        return copy.innerHTML;
      },
      text: () => htmlToText(el.current?.innerHTML ?? ""),
      focus: () => el.current?.focus(),
      isEmpty: () => !(el.current?.textContent ?? "").trim() && !el.current?.querySelector("img"),
    }),
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" style={{ background: "#fff" }} onClick={(e) => e.target === e.currentTarget && el.current?.focus()}>
        <div
          ref={el}
          className="mail-editor flex-1"
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label="Message body"
          data-placeholder={placeholder ?? ""}
          spellCheck
          onKeyDown={onKeyDown}
          onKeyUp={refresh}
          onMouseUp={refresh}
          onPaste={onPaste}
          onDrop={onDrop}
          suppressContentEditableWarning
        />
      </div>

      {link && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-sm" style={{ borderColor: "var(--ix-line)", background: "var(--ix-hover)" }} role="group" aria-label={link.editing ? "Edit link" : "Insert link"}>
          <input aria-label="Text to display" placeholder="Text to display" className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1" value={link.text} onChange={(e) => setLink({ ...link, text: e.target.value })} />
          <input
            aria-label="Web address or email"
            placeholder="Web address or email"
            className="min-w-0 flex-[2] rounded-md border bg-transparent px-2 py-1"
            value={link.url}
            autoFocus
            onChange={(e) => setLink({ ...link, url: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLink(null);
                restore();
              }
            }}
          />
          <button type="button" className="rounded-md px-3 py-1 font-medium text-white" style={{ background: "var(--accent)" }} onClick={applyLink}>
            {link.editing ? "Update" : "Insert"}
          </button>
          {link.editing && (
            <button type="button" className="mail-tool" title="Remove link" aria-label="Remove link" onClick={() => { setLink(null); exec("unlink"); }}>
              <Unlink size={15} />
            </button>
          )}
          <button type="button" className="rounded-md border px-3 py-1" onClick={() => { setLink(null); restore(); }}>Cancel</button>
        </div>
      )}

      <div className="relative flex flex-wrap items-center gap-0.5 border-t px-2 py-1" style={{ borderColor: "var(--ix-line)" }} role="toolbar" aria-label="Formatting options">
        <Tool label="Undo" keys="Ctrl+Z" onClick={() => exec("undo")}><Undo2 size={15} /></Tool>
        <Tool label="Redo" keys="Ctrl+Y" onClick={() => exec("redo")}><Redo2 size={15} /></Tool>
        <span className="mail-tool-sep" />
        <MenuButton label="Font" expanded={menu?.id === "font"} onToggle={(left) => setMenu(menu?.id === "font" ? null : { id: "font", left })}><Type size={15} /></MenuButton>
        <MenuButton label="Size" expanded={menu?.id === "size"} onToggle={(left) => setMenu(menu?.id === "size" ? null : { id: "size", left })}><ALargeSmall size={16} /></MenuButton>
        <span className="mail-tool-sep" />
        <Tool label="Bold" keys="Ctrl+B" pressed={!!active.bold} onClick={() => exec("bold")}><Bold size={15} /></Tool>
        <Tool label="Italic" keys="Ctrl+I" pressed={!!active.italic} onClick={() => exec("italic")}><Italic size={15} /></Tool>
        <Tool label="Underline" keys="Ctrl+U" pressed={!!active.underline} onClick={() => exec("underline")}><Underline size={15} /></Tool>
        <MenuButton label="Text colour" expanded={menu?.id === "color"} onToggle={(left) => setMenu(menu?.id === "color" ? null : { id: "color", left })}><Baseline size={15} /></MenuButton>
        <span className="mail-tool-sep" />
        <MenuButton label="Align" expanded={menu?.id === "align"} onToggle={(left) => setMenu(menu?.id === "align" ? null : { id: "align", left })}><AlignLeft size={15} /></MenuButton>
        <Tool label="Numbered list" keys="Ctrl+Shift+7" pressed={!!active.insertOrderedList} onClick={() => exec("insertOrderedList")}><ListOrdered size={15} /></Tool>
        <Tool label="Bulleted list" keys="Ctrl+Shift+8" pressed={!!active.insertUnorderedList} onClick={() => exec("insertUnorderedList")}><List size={15} /></Tool>
        <Tool label="Indent less" keys="Ctrl+[" onClick={() => exec("outdent")}><IndentDecrease size={15} /></Tool>
        <Tool label="Indent more" keys="Ctrl+]" onClick={() => exec("indent")}><IndentIncrease size={15} /></Tool>
        <Tool label="Quote" keys="Ctrl+Shift+9" onClick={quote}><TextQuote size={15} /></Tool>
        <span className="mail-tool-sep" />
        <Tool label="Insert link" keys="Ctrl+K" onClick={openLink}><Link2 size={15} /></Tool>
        <Tool label="Remove formatting" keys={"Ctrl+\\"} onClick={() => exec("removeFormat")}><RemoveFormatting size={15} /></Tool>

        {menu && (
          <div className="mail-menu bottom-full mb-1" role="menu" style={{ left: menu.left }}>
            {menu.id === "font" &&
              FONTS.map((f) => (
                <button key={f.label} type="button" role="menuitem" onMouseDown={keep} onClick={() => exec("fontName", f.face)} style={{ fontFamily: f.face }}>{f.label}</button>
              ))}
            {menu.id === "size" &&
              SIZES.map((s) => (
                <button key={s.label} type="button" role="menuitem" onMouseDown={keep} onClick={() => exec("fontSize", s.size)} style={{ fontSize: Math.min(s.px, 22) }}>{s.label}</button>
              ))}
            {menu.id === "align" &&
              ALIGN.map((a) => (
                <button key={a.cmd} type="button" role="menuitem" onMouseDown={keep} onClick={() => exec(a.cmd)}>{a.icon} {a.label}</button>
              ))}
            {menu.id === "color" && (
              <div className="grid grid-cols-6 gap-1 p-1">
                {COLORS.map((c) => (
                  <button key={c} type="button" role="menuitem" aria-label={`Colour ${c}`} title={c} className="h-5 w-5 rounded-sm border" style={{ background: c, borderColor: "var(--ix-line)" }} onMouseDown={keep} onClick={() => exec("foreColor", c)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
