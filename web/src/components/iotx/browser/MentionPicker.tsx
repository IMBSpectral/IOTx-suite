"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MANIFESTS } from "@/lib/iotx/manifests";
import { usePerms } from "../PermsProvider";
import { AppIcon, Icon } from "../icons";
import type { Tab } from "./store";

/**
 * The suite-wide @: type @ in any text field, in any tab (Mail, Chat, Tasks,
 * the Builder, a Doc, the AI box…), pick an app, then one of its things (a
 * project, a person, a task, a meeting, a file…), and a reference to it goes
 * in. People go in as @Name (so Chat and Tasks notify them, and an email
 * address in a To field); everything else as a link that opens it in the
 * suite and that the AI can read. Pages with their own @ menu turn it off
 * while this runs and offer their extras here under "This page".
 */

type Field = HTMLTextAreaElement | HTMLInputElement | HTMLElement;
type Ref = { key: string; group?: string; label: string; sub?: string; url?: string; kind: "person" | "item" | "local"; email?: string; insert?: string; icon?: string; color?: string };
type LocalSource = () => { title: string; items: { label: string; sub?: string; insert: string }[] };
type Win = Window & { __iotxAtHook?: boolean; __iotxMentionLocal?: LocalSource };
type Open = { tabId: string; win: Win; el: Field; q: string; app: string | null; rect: { left: number; top: number; bottom: number } };

/** The apps @ can reach, and where their things come from. */
const SOURCES: Record<string, { from: "suite" | "workspace"; label?: string }> = {
  builder: { from: "suite" },
  spaces: { from: "suite", label: "Dashboards & folders" },
  teamchat: { from: "workspace" },
  tasks: { from: "workspace" },
  calendar: { from: "workspace" },
  meetings: { from: "workspace" },
  mail: { from: "suite" },
  sheets: { from: "suite" },
  docs: { from: "suite" },
  slides: { from: "suite" },
  read: { from: "suite" },
  chat: { from: "suite", label: "AI chats" },
  people: { from: "suite", label: "People" },
};

const TEXT_INPUT = /^(text|search|email|url|tel|)$/i;
const editable = (el: Element | null | undefined): el is Field => {
  if (!el) return false;
  const h = el as HTMLElement;
  if (h.tagName === "TEXTAREA") return true;
  if (h.tagName === "INPUT") return TEXT_INPUT.test((h as HTMLInputElement).type);
  return !!h.isContentEditable;
};
const isPlain = (el: Field): el is HTMLTextAreaElement | HTMLInputElement => el.tagName === "TEXTAREA" || el.tagName === "INPUT";
/** A To / Cc / recipient box: a person goes in as their email address. */
const isRecipient = (el: Field) => {
  if (!isPlain(el)) return false;
  if ((el as HTMLInputElement).type === "email") return true;
  const by = (el.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? (el.ownerDocument.getElementById(id)?.textContent ?? "") : ""))
    .join(" ");
  return /^\s*(to|cc|bcc)\b|recipient|e-?mail address/i.test(`${el.getAttribute("aria-label") ?? ""} ${by} ${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("name") ?? ""}`);
};

/** The text from the start of the line up to the caret, and the caret's rectangle. */
function beforeCaret(win: Win, el: Field): { text: string; rect: DOMRect | null } | null {
  if (isPlain(el)) {
    const c = el.selectionStart ?? 0;
    if (c !== el.selectionEnd) return null;
    return { text: el.value.slice(0, c), rect: null };
  }
  const sel = win.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (r.startContainer.nodeType !== Node.TEXT_NODE) return { text: "", rect: null };
  const rects = r.getClientRects();
  return { text: (r.startContainer.textContent ?? "").slice(0, r.startOffset), rect: rects[0] ?? null };
}
const TRIGGER = /(^|[\s(\[])@([^\s@\]()]{0,40})$/;

/** Put the reference in place of "@query", as if typed, so the page sees the change. */
function insert(win: Win, el: Field, ref: Ref, host: string) {
  const d = win.document;
  const W = win as unknown as typeof window;
  const origin = window.location.origin;
  const chatHere = /^\/workspace\/chat/.test(host);
  let text: string;
  let html: string | null = null;
  if (ref.kind === "local") text = `${ref.insert} `;
  else if (ref.kind === "person") text = isRecipient(el) && ref.email ? `${ref.email}, ` : `@${ref.label} `;
  else if (chatHere && ref.label.startsWith("#")) text = `${ref.label} `;
  else {
    // The AI boxes and the Builder read short in-suite links; Chat, Tasks, Mail and Docs need the full address to make a link.
    const short = host === "" || /^\/(home\/chat|projects\/)/.test(host);
    const href = ref.url?.startsWith("/") && !short ? origin + ref.url : (ref.url ?? "");
    text = `[@${ref.label}](${href}) `;
    html = `<a href="${href.replace(/"/g, "&quot;")}" data-iotx-ref="1">@${ref.label.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)}</a>&nbsp;`;
  }
  el.focus();
  if (isPlain(el)) {
    const c = el.selectionStart ?? el.value.length;
    const head = el.value.slice(0, c).replace(/@[^\s@\]()]*$/, "");
    const next = head + text + el.value.slice(c);
    const proto = el.tagName === "TEXTAREA" ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, next);
    el.setSelectionRange(head.length + text.length, head.length + text.length);
    el.dispatchEvent(new W.Event("input", { bubbles: true }));
    return;
  }
  const sel = win.getSelection();
  if (sel?.rangeCount) {
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    const before = (node.textContent ?? "").slice(0, r.startOffset);
    const at = before.search(/@[^\s@\]()]*$/);
    if (at >= 0) {
      const range = d.createRange();
      range.setStart(node, at);
      range.setEnd(node, r.startOffset);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  if (!(html && d.execCommand("insertHTML", false, html))) d.execCommand("insertText", false, text);
}

const json = (r: Response) => (r.ok ? r.json() : { items: [] });

export default function MentionPicker({ tabs, winOf }: { tabs: Tab[]; winOf: (id: string) => Window | null }) {
  const perms = usePerms();
  const [open, setOpen] = useState<Open | null>(null);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const openRef = useRef<Open | null>(null);
  const listRef = useRef<Ref[]>([]);
  const selRef = useRef(0);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    openRef.current = open;
    listRef.current = refs;
    selRef.current = sel;
    tabsRef.current = tabs;
  });

  // Tell pages a suite-wide @ is here, so they turn their own @ menus off.
  useEffect(() => {
    (window as unknown as { __iotxMentions?: boolean }).__iotxMentions = true;
    return () => {
      delete (window as unknown as { __iotxMentions?: boolean }).__iotxMentions;
    };
  }, []);

  const apps: Ref[] = [
    ...MANIFESTS.filter((m) => SOURCES[m.id] && m.id !== "spaces" && perms.opens(m.id)).map((m) => ({ key: `app:${m.id}`, label: SOURCES[m.id].label ?? m.name, kind: "item" as const, icon: m.icon, color: m.color, sub: m.desc })),
    { key: "app:spaces", label: "Dashboards & folders", kind: "item", icon: "dashboard", color: "linear-gradient(135deg,#0ea5e9,#6366f1)", sub: "From your sidebar" },
    { key: "app:people", label: "People", kind: "item", icon: "people", color: "#868e96", sub: "Anyone in the workspace" },
  ];

  const choose = useCallback(
    (r: Ref) => {
      const o = openRef.current;
      if (!o) return;
      if (r.key.startsWith("app:")) {
        // Into the app: drop what was typed after @, then type to filter its things.
        const app = r.key.slice(4);
        if (isPlain(o.el)) {
          const W = o.win as unknown as typeof window;
          const c = o.el.selectionStart ?? o.el.value.length;
          const head = o.el.value.slice(0, c).replace(/@[^\s@\]()]*$/, "@");
          const next = head + o.el.value.slice(c);
          const proto = o.el.tagName === "TEXTAREA" ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(o.el, next);
          o.el.setSelectionRange(head.length, head.length);
          o.el.dispatchEvent(new W.Event("input", { bubbles: true }));
        } else if (o.q) {
          const s = o.win.getSelection();
          for (let i = 0; i < o.q.length; i++) s?.modify("extend", "backward", "character");
          o.win.document.execCommand("delete");
        }
        o.el.focus();
        setOpen({ ...o, app, q: "" });
        setSel(0);
        return;
      }
      const host = o.tabId === "frame" ? "" : (tabsRef.current.find((t) => t.id === o.tabId)?.url ?? "");
      setOpen(null);
      insert(o.win, o.el, r, host);
    },
    [],
  );

  // Watch every tab (and the frame itself) for "@" in a text field.
  useEffect(() => {
    const check = (tabId: string, win: Win, el: Field) => {
      const b = beforeCaret(win, el);
      const m = b && TRIGGER.exec(b.text);
      if (!b || !m) return setOpen(null);
      const frame = tabId === "frame" ? null : (window.document.querySelector(`iframe[name="iotx-tab-${tabId}"]`) as HTMLIFrameElement | null);
      const off = frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const box = b.rect ?? el.getBoundingClientRect();
      const rect = { left: off.left + box.left, top: off.top + box.top, bottom: off.top + box.bottom };
      const prev = openRef.current;
      // Inside an app, what's typed after @ filters its things; on a fresh @ it starts over.
      const same = prev && prev.el === el && prev.app;
      setOpen({ tabId, win, el, q: m[2], app: same ? prev!.app : null, rect });
      if (!prev || prev.el !== el) setSel(0);
    };
    const onKey = (e: KeyboardEvent) => {
      const o = openRef.current;
      if (!o) return;
      const list = listRef.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSel((s) => (list.length ? (s + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length : 0));
      } else if ((e.key === "Enter" || e.key === "Tab") && list.length) {
        e.preventDefault();
        e.stopPropagation();
        choose(list[Math.min(selRef.current, list.length - 1)]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(null);
      } else if (e.key === "Backspace" && o.app && !o.q) {
        // Back from an app's things to the list of apps (the @ stays).
        e.preventDefault();
        e.stopPropagation();
        setOpen({ ...o, app: null });
        setSel(0);
      }
    };
    const hook = (tabId: string, win: Win | null) => {
      if (!win || win.__iotxAtHook) return;
      try {
        win.__iotxAtHook = true;
        win.document.addEventListener("input", (e) => editable(e.target as Element) && check(tabId, win, e.target as Field), true);
        win.addEventListener("keydown", onKey, true);
        win.document.addEventListener("mousedown", (e) => {
          const o = openRef.current;
          // A click on the picker itself (it lives in the frame's document) isn't a click away.
          if (o && o.win === win && e.target !== o.el && !(e.target as Element | null)?.closest?.(".ix-at")) setOpen(null);
        });
        // The page scrolling moves the field away from the picker; the picker's own list scrolling doesn't.
        win.addEventListener(
          "scroll",
          (e) => openRef.current?.win === win && !(e.target as Element | null)?.closest?.(".ix-at") && setOpen(null),
          true,
        );
      } catch {}
    };
    hook("frame", window as Win);
    const each = () => {
      for (const t of tabsRef.current) hook(t.id, winOf(t.id) as Win | null);
    };
    each();
    const iv = setInterval(each, 1500);
    return () => clearInterval(iv);
  }, [winOf, choose]);

  // Close when the tab changes.
  const activeIds = tabs.map((t) => t.id).join();
  useEffect(() => {
    const o = openRef.current;
    if (o && o.tabId !== "frame" && !activeIds.includes(o.tabId)) setOpen(null);
  }, [activeIds]);

  // What the list shows: apps (and this page's extras, and quick matches), or one app's things.
  const app = open?.app ?? null;
  const q = open?.q ?? "";
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    const get = (a: string, term: string) => {
      const src = SOURCES[a];
      const base = src.from === "workspace" ? "/workspace/api/mentions" : "/api/mentions";
      return fetch(`${base}?app=${a}&q=${encodeURIComponent(term)}`, { signal: ctl.signal, cache: "no-store" })
        .then(json)
        .then((d: { items?: Omit<Ref, "key">[] }) => (d.items ?? []).map((x) => ({ ...x, key: `${a}:${(x as { id?: string }).id ?? x.label}`, icon: a === "people" || a === "mail" || x.kind === "person" ? "people" : MANIFESTS.find((m) => m.id === a)?.icon ?? "link", color: MANIFESTS.find((m) => m.id === a)?.color ?? "#868e96" })))
        .catch(() => [] as Ref[]);
    };
    const t = setTimeout(async () => {
      if (app) {
        setLoading(true);
        const got = await get(app, q);
        if (!ctl.signal.aborted) {
          setRefs(got);
          setLoading(false);
        }
        return;
      }
      const term = q.toLowerCase();
      let local: Ref[] = [];
      try {
        const src = open.win.__iotxMentionLocal?.();
        if (src) local = src.items.filter((i) => !term || i.label.toLowerCase().includes(term)).slice(0, term ? 6 : 4).map((i, n) => ({ key: `local:${n}:${i.label}`, group: src.title, label: i.label, sub: i.sub, kind: "local", insert: i.insert, icon: "pin", color: "#868e96" }));
      } catch {}
      const shown = apps.filter((a) => !term || a.label.toLowerCase().includes(term)).map((a) => ({ ...a, group: "Apps" }));
      // Apps first; what was typed matching this page's own things puts those first.
      const base = term ? [...local, ...shown] : [...shown, ...local];
      setRefs(base);
      // Typed something that isn't an app: quick matches across people, tasks and projects (a task id like ABC-12 works).
      if (term.length >= 2) {
        const [ppl, tasks, projects] = await Promise.all([get("people", q), perms.opens("tasks") ? get("tasks", q) : [], perms.opens("builder") ? get("builder", q) : []]);
        if (!ctl.signal.aborted) setRefs([...base, ...[...tasks.slice(0, 4), ...ppl.slice(0, 3), ...projects.slice(0, 3)].map((x) => ({ ...x, group: "Matches" }))]);
      }
    }, app ? 120 : 60);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.el, open?.tabId, app, q]);

  if (!open) return null;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const below = vh - open.rect.bottom > 280;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(open.rect.left, (typeof window !== "undefined" ? window.innerWidth : 1200) - 340)),
    ...(below ? { top: open.rect.bottom + 6 } : { bottom: vh - open.rect.top + 6 }),
  };
  const appName = app ? (apps.find((a) => a.key === `app:${app}`)?.label ?? app) : null;
  return (
    <div className="ix-at" style={style} role="listbox" aria-label={appName ? `${appName}: pick one` : "Mention an app or anything in it"} onMouseDown={(e) => e.preventDefault()}>
      <div className="ix-at-head">
        {appName ? (
          <>
            <button type="button" className="ix-at-back" onClick={() => (setOpen({ ...open, app: null }), setSel(0), open.el.focus())} aria-label="Back to apps">
              <Icon name="back" size={13} />
            </button>
            <b>{appName}</b>
            {q && <span className="ix-hint">“{q}”</span>}
          </>
        ) : (
          <span className="ix-hint">{q ? `Apps and matches for “${q}”` : "Pick an app, or keep typing to search"}</span>
        )}
      </div>
      <div className="ix-at-list">
        {refs.length === 0 && <div className="ix-at-empty">{loading ? "Loading…" : app ? "Nothing here matches." : "No matches."}</div>}
        {refs.map((r, i) => [
          r.group && r.group !== refs[i - 1]?.group && (
            <div key={`g:${r.group}`} className="ix-at-group">
              {r.group}
            </div>
          ),
          <button
            key={r.key}
            type="button"
            role="option"
            aria-selected={i === sel}
            className={`ix-at-row ${i === sel ? "on" : ""}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => choose(r)}
          >
            {r.key.startsWith("app:") ? (
              <AppIcon icon={r.icon ?? "link"} color={r.color ?? "#868e96"} size={24} />
            ) : (
              <span className="ix-at-ico" style={{ color: typeof r.color === "string" && r.color.startsWith("#") ? r.color : undefined }}>
                <Icon name={r.icon ?? "link"} size={14} />
              </span>
            )}
            <span className="ix-at-text">
              <span className="ix-at-label">{r.label}</span>
              {r.sub && <span className="ix-at-sub">{r.sub}</span>}
            </span>
            {r.key.startsWith("app:") && <Icon name="chevron" size={12} />}
          </button>,
        ])}
      </div>
    </div>
  );
}
