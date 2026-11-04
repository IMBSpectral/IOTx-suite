"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useBrand } from "@/components/BrandProvider";
import { usePerms } from "../PermsProvider";
import { Icon } from "../icons";
import { AiReply, UserBubble, askStream, type Msg, type SuiteAction } from "../ai";
import { tabApp } from "../tabs";
import { spacesChanged } from "./SpacesNav";
import type { Tab } from "./store";

/**
 * The floating assistant: one button over every tab (the Builder included)
 * that opens an AI panel. Each message carries the open tabs, what they show
 * and their fields, so the AI can read tab 3 and fill tab 1. It lives in the
 * frame, so it stays put while you switch tabs.
 */

type Field = HTMLTextAreaElement | HTMLInputElement | HTMLElement;
type TabWin = Window & { __iotxLastField?: Field; __iotxFieldHook?: boolean };

const POS_KEY = "iotx.ai.pos";
const CHAT_KEY = "iotx.ai.chat";
const TEXT_INPUT = /^(text|search|email|url|tel|number|)$/i;
const editable = (el: Element | null | undefined): el is Field => {
  if (!el) return false;
  const h = el as HTMLElement;
  if (h.tagName === "TEXTAREA") return !(h as HTMLTextAreaElement).readOnly && !(h as HTMLTextAreaElement).disabled;
  if (h.tagName === "INPUT") return TEXT_INPUT.test((h as HTMLInputElement).type) && !(h as HTMLInputElement).readOnly && !(h as HTMLInputElement).disabled;
  return h.isContentEditable;
};
const visible = (el: HTMLElement) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
const fieldName = (el: Field) =>
  (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || (el.isContentEditable ? "text editor" : el.tagName.toLowerCase())).slice(0, 100);

function fieldsOf(d: Document): Field[] {
  return [...d.querySelectorAll<HTMLElement>("textarea, input, [contenteditable=''], [contenteditable='true']")].filter((e) => editable(e) && visible(e)) as Field[];
}

/** Remember the field last used in a tab, so "fill it in" lands where the person was typing. */
function hookFields(w: TabWin) {
  if (w.__iotxFieldHook) return;
  w.__iotxFieldHook = true;
  w.document.addEventListener("focusin", (e) => {
    if (editable(e.target as Element)) w.__iotxLastField = e.target as Field;
  });
}

/** Puts text into a tab's field as if typed, so React and editors see the change. */
function fillIn(w: TabWin, text: string, field?: string, replace?: boolean) {
  const d = w.document;
  const all = fieldsOf(d);
  const want = field?.toLowerCase();
  let el: Field | undefined = want ? all.find((f) => fieldName(f).toLowerCase().includes(want)) : undefined;
  if (!el && w.__iotxLastField && d.contains(w.__iotxLastField) && editable(w.__iotxLastField)) el = w.__iotxLastField;
  if (!el && editable(d.activeElement)) el = d.activeElement as Field;
  el ??= all.find((f) => f.tagName === "TEXTAREA") ?? all.find((f) => f.isContentEditable) ?? all[0];
  if (!el) return false;
  el.focus();
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const input = el as HTMLTextAreaElement;
    const proto = el.tagName === "TEXTAREA" ? (w as unknown as typeof window).HTMLTextAreaElement.prototype : (w as unknown as typeof window).HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const value = replace || !input.value ? text : `${input.value}${input.value.endsWith("\n") || el.tagName === "INPUT" ? (el.tagName === "INPUT" ? " " : "") : "\n"}${text}`;
    if (set) set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new (w as unknown as typeof window).Event("input", { bubbles: true }));
    input.dispatchEvent(new (w as unknown as typeof window).Event("change", { bubbles: true }));
  } else {
    if (replace) d.execCommand("selectAll");
    d.execCommand("insertText", false, text);
  }
  return true;
}

/** What one tab shows, read for the assistant. */
function snapshot(t: Tab, active: boolean, w: TabWin | null) {
  // The app's name too ("New chat · AI Chat"), so "the AI Chat tab" finds it.
  const app = tabApp(t.url).name;
  const base = { id: t.id, title: app && app !== t.title ? `${t.title} · ${app}` : t.title, url: t.url, active };
  if (!w) return base;
  try {
    hookFields(w);
    const body = w.document.body;
    const text = (body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 40_000);
    const fields = fieldsOf(w.document).slice(0, 20).map(fieldName);
    return { ...base, text, fields };
  } catch {
    return base;
  }
}

const OPEN_KEY = "iotx-float-ai";

export default function FloatingAI({
  tabs,
  activeId,
  winOf,
  openTab,
  activate,
  reload,
}: {
  tabs: Tab[];
  activeId: string;
  winOf: (id: string) => Window | null;
  openTab: (url: string) => void;
  activate: (id: string) => void;
  reload: (id: string) => void;
}) {
  const brand = useBrand();
  const perms = usePerms();
  const router = useRouter();
  // Stays open across reloads of the suite in this browser tab.
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [view, setView] = useState<"chat" | "memory">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  // The conversation survives a refresh: its id is kept on this device and its messages reloaded.
  const [chatId, setChatId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CHAT_KEY);
    } catch {
      return null;
    }
  });
  const restored = useRef(false);
  useEffect(() => {
    try {
      if (chatId) localStorage.setItem(CHAT_KEY, chatId);
      else localStorage.removeItem(CHAT_KEY);
    } catch {}
    if (restored.current || !chatId) return;
    restored.current = true;
    fetch(`/api/assistant?chat=${encodeURIComponent(chatId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.messages) setMessages((now) => (now.length ? now : d.messages));
        else setChatId(null);
      })
      .catch(() => undefined);
  }, [chatId]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memory, setMemory] = useState<{ id: string; fact: string; source: string }[] | null>(null);
  const [newFact, setNewFact] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const latest = useRef({ tabs, activeId });
  useEffect(() => {
    latest.current = { tabs, activeId };
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {}
    // The panel floats over the tabs, so "this tab" is always the active one.
    if (open) requestAnimationFrame(() => box.current?.focus());
  }, [open]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);

  // Alt+A opens and closes it, from the frame or (forwarded) from any tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    const hook = () => {
      for (const t of latest.current.tabs) {
        const w = winOf(t.id) as (TabWin & { __iotxAiKey?: boolean }) | null;
        if (!w || w.__iotxAiKey) continue;
        try {
          w.__iotxAiKey = true;
          w.addEventListener("keydown", onKey);
          hookFields(w);
        } catch {}
      }
    };
    hook();
    const iv = setInterval(hook, 2000);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearInterval(iv);
    };
  }, [winOf]);

  const flash = (s: string) => {
    setNotice(s);
    setTimeout(() => setNotice((n) => (n === s ? null : n)), 3500);
  };

  const act = useCallback(
    (a: SuiteAction) => {
      const { tabs: now } = latest.current;
      if (a.kind === "shell") return (spacesChanged(), router.refresh());
      if (a.kind === "open") return openTab(a.url);
      if (a.kind === "reload") {
        for (const t of now) if (t.url.includes(a.match)) reload(t.id);
        return;
      }
      const t = now.find((x) => x.id === a.tabId);
      const w = t ? (winOf(t.id) as TabWin | null) : null;
      if (!t || !w) return flash("That tab isn't loaded any more, so nothing was filled.");
      const ok = fillIn(w, a.text, a.field, a.replace);
      if (!ok) return flash(`No field to fill in "${t.title}".`);
      activate(t.id);
      flash(`Filled in "${t.title}". Check it there before sending.`);
    },
    [activate, openTab, reload, router, winOf],
  );

  // The AI Chat page (inside a tab) borrows these, so it can read and fill tabs too.
  useEffect(() => {
    const top = window as Window & { __iotxSuite?: { tabs: () => unknown[]; act: (a: SuiteAction) => void } };
    top.__iotxSuite = {
      tabs: () => {
        const { tabs: now, activeId: here } = latest.current;
        return now.map((t) => snapshot(t, t.id === here, t.live ? (winOf(t.id) as TabWin | null) : null));
      },
      act,
    };
    return () => void delete top.__iotxSuite;
  }, [act, winOf]);

  const send = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || busy) return;
      setBusy(true);
      setError(null);
      setText("");
      const { tabs: now, activeId: here } = latest.current;
      const snaps = now.map((t) => snapshot(t, t.id === here, t.live ? (winOf(t.id) as TabWin | null) : null));
      const liveId = `live-${Date.now()}`;
      setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content }, { id: liveId, role: "assistant", content: "", live: true, status: null, steps: [] }]);
      const patch = (p: Partial<Msg>) => setMessages((all) => all.map((x) => (x.id === liveId ? { ...x, ...p } : x)));
      // Actions run once the reply is done, so a fill never races the text being written.
      const actions: SuiteAction[] = [];
      const d = await askStream({ chatId, content, tabs: snaps }, { onUpdate: patch, onChat: setChatId, onAction: (a) => actions.push(a) });
      setBusy(false);
      if (d.chatId) setChatId(d.chatId);
      if (!d.reply) {
        setMessages((all) => all.filter((x) => x.id !== liveId || !!x.content).map((x) => (x.id === liveId ? { ...x, live: false } : x)));
        setError(d.error);
        return;
      }
      setMessages((all) => all.map((x) => (x.id === liveId ? d.reply! : x)));
      for (const a of actions) act(a);
    },
    [act, busy, chatId, winOf],
  );

  const insertHere = (t: string) => {
    const id = latest.current.activeId;
    act({ kind: "fill", tabId: id, text: t });
  };

  const loadMemory = useCallback(async () => {
    const r = await fetch("/api/assistant?memory=1").catch(() => null);
    const d = r?.ok ? await r.json() : null;
    setMemory(d?.memory ?? []);
  }, []);
  useEffect(() => {
    if (open && view === "memory") void loadMemory();
  }, [open, view, loadMemory]);
  const forget = async (id: string) => {
    setMemory((m) => m?.filter((x) => x.id !== id) ?? null);
    await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "forget", memoryId: id }) }).catch(() => null);
  };
  const addFact = async (e: React.FormEvent) => {
    e.preventDefault();
    const fact = newFact.trim();
    if (!fact) return;
    setNewFact("");
    const r = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remember", fact }) }).catch(() => null);
    const d = r?.ok ? await r.json() : null;
    if (d?.memory) setMemory((m) => [d.memory, ...(m ?? [])]);
  };

  // Draggable anywhere on the screen: the button by itself, the panel by its header.
  // pos is the gap to the right and bottom edges, remembered on this device.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
      if (typeof p?.x === "number" && typeof p?.y === "number") return p;
    } catch {}
    return { x: 20, y: 20 };
  });
  const dragged = useRef(false);
  const startDrag = (e: React.PointerEvent<HTMLElement>, box: HTMLElement | null) => {
    if (e.button !== 0 || !box) return;
    if (box !== e.currentTarget && (e.target as Element).closest("button, input, textarea, a")) return;
    const el = e.currentTarget;
    const { width, height } = box.getBoundingClientRect();
    const from = { cx: e.clientX, cy: e.clientY, ...pos };
    dragged.current = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - from.cx;
      const dy = ev.clientY - from.cy;
      if (!dragged.current && Math.hypot(dx, dy) < 4) return;
      dragged.current = true;
      const x = Math.min(Math.max(8, from.x - dx), window.innerWidth - width - 8);
      const y = Math.min(Math.max(8, from.y - dy), window.innerHeight - height - 8);
      setPos({ x, y });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setPos((p) => {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(p));
        } catch {}
        return p;
      });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const panel = useRef<HTMLElement>(null);

  if (!perms.can("home.ask")) return null;
  const fromTitle = tabs.find((t) => t.id === activeId)?.title;

  if (!open)
    return (
      <button
        type="button"
        className="ix-fab"
        style={{ right: pos.x, bottom: pos.y }}
        onPointerDown={(e) => startDrag(e, e.currentTarget)}
        onClick={() => {
          if (!dragged.current) setOpen(true);
          dragged.current = false;
        }}
        title={`Ask ${brand.shortName} (Alt+A). Drag to move.`}
        aria-label={`Ask ${brand.shortName}`}
      >
        <Icon name="sparkle" size={22} />
      </button>
    );

  // The panel opens where the button is, kept on screen.
  const side = (v: number, room: string) => `max(8px, min(${v}px, calc(${room} - 8px)))`;
  return (
    <section
      ref={panel}
      className="ix-float"
      role="dialog"
      aria-label={`${brand.shortName} assistant`}
      style={{ right: side(pos.x, "100vw - min(420px, 100vw - 32px)"), bottom: side(pos.y, "100vh - min(640px, 100vh - 32px)") }}
    >
      <header className="ix-float-head" onPointerDown={(e) => startDrag(e, panel.current)} title="Drag to move">

        <span className="ix-float-mark" aria-hidden>
          <Icon name="sparkle" size={15} />
        </span>
        <b>{view === "memory" ? "What I remember" : `Ask ${brand.shortName}`}</b>
        <span className="ix-sp" />
        <button type="button" className="ix-act" title={view === "memory" ? "Back to chat" : "Memory"} aria-label={view === "memory" ? "Back to chat" : "Memory"} aria-pressed={view === "memory"} onClick={() => setView(view === "memory" ? "chat" : "memory")}>
          <Icon name="memory" size={15} />
        </button>
        <button
          type="button"
          className="ix-act"
          title="New chat"
          aria-label="New chat"
          disabled={busy}
          onClick={() => {
            setMessages([]);
            setChatId(null);
            setError(null);
            setView("chat");
          }}
        >
          <Icon name="add" size={15} />
        </button>
        <button type="button" className="ix-act" title="Close (Alt+A)" aria-label="Close" onClick={() => setOpen(false)}>
          <Icon name="close" size={15} />
        </button>
      </header>

      {view === "memory" ? (
        <div className="ix-float-body">
          <p className="ix-hint" style={{ margin: 0 }}>
            {brand.shortName} remembers these across chats and uses them in every answer. It also reads its own recent actions from the audit log.
          </p>
          <form onSubmit={addFact} style={{ display: "flex", gap: 6 }}>
            <input className="ix-input" value={newFact} onChange={(e) => setNewFact(e.target.value)} placeholder="Add something to remember…" maxLength={500} aria-label="Add a memory" style={{ flex: 1 }} />
            <button className="ix-btn" disabled={!newFact.trim()}>
              Add
            </button>
          </form>
          {memory === null ? (
            <span className="ix-hint">Loading…</span>
          ) : memory.length === 0 ? (
            <span className="ix-hint">Nothing yet. Tell it &quot;remember that…&quot;, or add a fact above.</span>
          ) : (
            memory.map((m) => (
              <div key={m.id} className="ix-mem">
                <span style={{ flex: 1 }}>{m.fact}</span>
                <button type="button" className="ix-act" title="Forget this" aria-label={`Forget: ${m.fact}`} onClick={() => void forget(m.id)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="ix-float-body">
          {messages.length === 0 && (
            <div className="ix-hint" style={{ display: "grid", gap: 6 }}>
              <span>
                Ask anything. {brand.shortName} can see your {tabs.length === 1 ? "open tab" : `${tabs.length} open tabs`}, read one and fill another, edit your Sheets, Docs and Slides, and remember what matters.
              </span>
              {[
                tabs.length > 1 ? `Read tab ${tabs.length} and put a short summary into this tab` : "Summarise what's on this tab",
                "Make a sheet of this month's tasks",
                "Remember that I prefer short answers",
              ].map((s) => (
                <button key={s} type="button" className="ix-suggest" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <UserBubble key={m.id} m={m} onEdit={busy ? undefined : (t) => (setText(t), box.current?.focus())} />
            ) : (
              <AiReply
                key={m.id}
                m={m}
                name={brand.shortName}
                onInsert={insertHere}
                insertLabel={fromTitle ? `Put into "${fromTitle}"` : "Put into the tab you were in"}
                onRetry={
                  busy
                    ? undefined
                    : () => {
                        const q = [...messages.slice(0, i)].reverse().find((x) => x.role === "user");
                        if (q) void send(q.content);
                      }
                }
              />
            ),
          )}
          {error && (
            <div className="ix-error" role="alert">
              {error}
            </div>
          )}
          <div ref={end} />
        </div>
      )}

      {notice && (
        <div className="ix-float-note" role="status">
          {notice}
        </div>
      )}
      {view === "chat" && (
        <div className="ix-float-ask">
          <textarea
            ref={box}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(text);
              }
            }}
            placeholder={fromTitle ? `Ask about "${fromTitle}" or any tab…` : `Ask ${brand.shortName}…`}
            aria-label={`Ask ${brand.shortName}`}
          />
          <button type="button" className="ix-send" onClick={() => void send(text)} disabled={busy || !text.trim()} aria-label="Send">
            <Icon name="send" size={15} />
          </button>
        </div>
      )}
    </section>
  );
}
