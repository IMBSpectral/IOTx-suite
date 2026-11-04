"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePerms } from "./PermsProvider";
import { useBrand } from "@/components/BrandProvider";
import { AskBox } from "./HomeView";
import { Icon } from "./icons";
import { useTabTitle } from "./tabs";
import { AiReply, PENDING_ASK, UserBubble, askStream, type Msg, type SuiteAction } from "./ai";

type Chat = { id: string; title: string; updatedAt: string };

/**
 * AI Chat inside the shell: conversations with IOTx (the workspace
 * assistant). With Builder on, the same box can switch to Plan or Build and
 * the assistant may start projects; without it, it only chats.
 */
export default function ChatView({ chatId: initialChat, prompt, autoSend }: { chatId: string | null; prompt?: string; autoSend?: boolean }) {
  const perms = usePerms();
  const brand = useBrand();
  const router = useRouter();
  const [chatId, setChatId] = useState<string | null>(initialChat);
  const [title, setTitle] = useState<string>("New chat");
  useTabTitle(title);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

  useEffect(() => {
    fetch("/api/assistant")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setChats(d.chats))
      .catch(() => undefined);
  }, [chatId]);

  useEffect(() => {
    setChatId(initialChat);
    if (!initialChat) {
      setMessages([]);
      setTitle("New chat");
      return;
    }
    fetch(`/api/assistant?chat=${initialChat}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setMessages(d.messages ?? []);
        setTitle(d.chat?.title ?? "Chat");
      })
      .catch(() => undefined);
  }, [initialChat]);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;
      setBusy(true);
      setError(null);
      const liveId = `live-${Date.now()}`;
      setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content }, { id: liveId, role: "assistant", content: "", live: true, status: null, steps: [] }]);
      if (!chatId) setTitle(content.slice(0, 60));
      const patch = (p: Partial<Msg>) => setMessages((all) => all.map((x) => (x.id === liveId ? { ...x, ...p } : x)));
      // Inside the suite's browser, the AI can read and fill the other open tabs too.
      let suite: { tabs: () => unknown[]; act: (a: SuiteAction) => void } | undefined;
      try {
        suite = (window.top as (Window & { __iotxSuite?: typeof suite }) | null)?.__iotxSuite;
      } catch {}
      const actions: SuiteAction[] = [];
      const d = await askStream({ chatId, content, ...(suite ? { tabs: suite.tabs() } : {}) }, { onUpdate: patch, onAction: (a) => actions.push(a) });
      setBusy(false);
      if (suite) for (const a of actions) suite.act(a);
      if (!d.reply) {
        setMessages((all) => all.filter((x) => x.id !== liveId || !!x.content).map((x) => (x.id === liveId ? { ...x, live: false } : x)));
        setError(d.error);
        return;
      }
      if (!chatId && d.chatId) {
        setChatId(d.chatId);
        window.history.replaceState(null, "", `/home/chat?chat=${d.chatId}`);
        router.refresh();
      }
      setMessages((all) => all.map((x) => (x.id === liveId ? d.reply! : x)));
    },
    [busy, chatId, router],
  );

  useEffect(() => {
    if (!autoSend || sentInitial.current) return;
    let text = prompt ?? "";
    try {
      text = sessionStorage.getItem(PENDING_ASK) || text;
      sessionStorage.removeItem(PENDING_ASK);
    } catch {}
    if (!text) return;
    sentInitial.current = true;
    window.history.replaceState(null, "", "/home/chat");
    void send(text);
  }, [autoSend, prompt, send]);

  /** Ask a question again: the last question before this reply. */
  const retry = (i: number) => {
    const q = [...messages.slice(0, i)].reverse().find((x) => x.role === "user");
    if (q) void send(q.content);
  };
  const edit = (text: string) => window.dispatchEvent(new CustomEvent("iotx:ask", { detail: { text, mode: "chat" } }));

  return (
    <div className="ix-chat">
      <div className="ix-aurora" style={{ opacity: 0.45 }} aria-hidden />
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ font: "600 18px var(--font-sans)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        <span className="ix-hint">{messages.length ? `${messages.length} messages` : perms.builder ? "Chat, Plan or Build" : "Chat"}</span>
        <Link href="/home/chat?new=1" className="ix-btn" onClick={() => setMessages([])}>
          <Icon name="add" size={13} /> New chat
        </Link>
      </div>

      {messages.length === 0 && !busy && (
        <div className="ix-card" style={{ position: "relative" }}>
          <b>Ask {brand.shortName} anything</b>
          <p style={{ margin: "4px 0 0", color: "var(--ix-muted)" }}>
            {perms.builder
              ? "Discuss an idea, ask about your projects, or switch the box below to Plan or Build to start an app."
              : "Discuss ideas, get explanations, draft text and ask about the projects shared with you. Building isn't turned on for your role; an admin can turn on Builder."}
          </p>
          {chats.length > 0 && (
            <div style={{ marginTop: 12, display: "grid", gap: 4 }}>
              <span className="ix-mlabel" style={{ padding: 0 }}>
                Earlier chats
              </span>
              {chats.slice(0, 8).map((c) => (
                <Link key={c.id} href={`/home/chat?chat=${c.id}`} className="ix-step">
                  <i>
                    <Icon name="chatline" size={10} />
                  </i>
                  {c.title}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {messages.map((m, i) =>
        m.role === "user" ? (
          <UserBubble key={m.id} m={m} onEdit={busy ? undefined : edit} />
        ) : (
          <AiReply key={m.id} m={m} name={brand.shortName} onRetry={busy ? undefined : () => retry(i)} />
        ),
      )}
      {error && (
        <div className="ix-error" role="alert" style={{ position: "relative" }}>
          {error}
        </div>
      )}
      <div ref={end} />
      <div style={{ marginTop: "auto", position: "sticky", bottom: 12 }}>
        <AskBox onChat={(t) => void send(t)} defaultMode="chat" placeholder={perms.builder ? `Ask ${brand.shortName}, or switch to Plan or Build…` : `Ask ${brand.shortName}…`} autoFocus key={chatId ?? "new"} />
      </div>
    </div>
  );
}
