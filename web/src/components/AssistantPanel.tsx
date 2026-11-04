"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUpRight, FolderPlus, Loader2, Plus, Send, Trash2, X } from "lucide-react";
import { useBrand } from "@/components/BrandProvider";

type Step = { kind: "sent" | "created" | "looked"; label: string; projectId?: string };
type Msg = { id: string; role: "user" | "assistant"; content: string; steps?: Step[] | null };
type Chat = { id: string; title: string; updatedAt: string };

/** Suggestions when a project is in the conversation ("project landing"). */
const projectPrompts = (shortName: string) => [
  "What's in this project?",
  "Review my app for issues",
  `What is ${shortName} changing right now?`,
  "Suggest what to build next",
];

export default function AssistantPanel({
  projects,
  files = [],
  initialPrompt = "",
}: {
  projects: { id: string; name: string }[];
  /** Chat files from the workspace's projects, addable as context. */
  files?: { projectId: string; uploadId: string; name: string }[];
  /** Pre-filled from a dashboard suggestion (?prompt=…). */
  initialPrompt?: string;
}) {
  const brand = useBrand();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState(initialPrompt);
  const [context, setContext] = useState<string[]>([]);
  // Files and earlier chats added to the conversation.
  const [fileCtx, setFileCtx] = useState<{ projectId: string; uploadId: string; name: string }[]>([]);
  const [chatCtx, setChatCtx] = useState<{ id: string; title: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const muted = { color: "var(--muted)" };
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));

  useEffect(() => {
    let live = true;
    fetch("/api/assistant")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setChats(d.chats);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [version]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function openChat(id: string) {
    setChatId(id);
    setError(null);
    const d = await (await fetch(`/api/assistant?chat=${id}`)).json();
    setMessages(d.messages ?? []);
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content }]);
    const res = await fetch("/api/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId,
        content,
        projectIds: context,
        files: fileCtx.map(({ projectId, uploadId }) => ({ projectId, uploadId })),
        chatIds: chatCtx.map((c) => c.id),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(d.error ?? "Something went wrong");
      return;
    }
    setChatId(d.chatId);
    setMessages((m) => [...m, d.reply]);
    setVersion((v) => v + 1);
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-56 shrink-0 flex-col border-r md:flex" aria-label="Chats">
        <button
          onClick={() => {
            setChatId(null);
            setMessages([]);
            setContext([]);
          }}
          className="m-2 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" /> New chat
        </button>
        <ul className="min-h-0 flex-1 overflow-y-auto px-1">
          {chats.map((c) => (
            <li key={c.id} className="group flex items-center">
              <button
                onClick={() => openChat(c.id)}
                className={`flex-1 truncate rounded-lg px-2.5 py-1.5 text-left text-xs ${chatId === c.id ? "bg-black/[.05]" : "hover:bg-black/[.03]"}`}
              >
                {c.title}
              </button>
              <button
                onClick={async () => {
                  await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", chatId: c.id }) });
                  if (chatId === c.id) {
                    setChatId(null);
                    setMessages([]);
                  }
                  setVersion((v) => v + 1);
                }}
                aria-label={`Delete ${c.title}`}
                className="hidden rounded p-1 text-red-500 group-hover:block"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {messages.length === 0 && (
            <div className="mx-auto mt-16 max-w-lg text-center">
              <h2 className="text-xl font-semibold">How can I help?</h2>
              <p className="mt-1 text-sm" style={muted}>
                Ask about any project, get a review, plan what&apos;s next, start a new app or send work into one.
              </p>
            </div>
          )}
          <div className="mx-auto max-w-2xl space-y-4">
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "ml-auto max-w-[85%] rounded-2xl border px-3.5 py-2 text-sm" : "text-sm"}>
                {m.role === "assistant" && m.steps && m.steps.length > 0 && (
                  <ul className="mb-2 space-y-0.5 text-[11px]" style={muted}>
                    {m.steps.map((s, i) => (
                      <li key={i} className="flex items-center gap-1">
                        {s.projectId ? (
                          <Link href={`/projects/${s.projectId}`} className="flex items-center gap-0.5 hover:underline">
                            {s.label} <ArrowUpRight className="h-3 w-3" />
                          </Link>
                        ) : (
                          s.label
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {m.role === "assistant" ? (
                  <div className="prose-chat leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{m.content}</p>
                )}
              </div>
            ))}
            {busy && (
              <p className="flex items-center gap-2 text-sm" style={muted} role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </p>
            )}
            {error && (
              <p className="text-xs text-red-500" role="alert">
                {error}
              </p>
            )}
            <div ref={endRef} />
          </div>
        </div>

        <div className="border-t px-6 py-3">
          <div className="mx-auto max-w-2xl">
            {context.length > 0 && messages.length === 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {projectPrompts(brand.shortName).map((p) => (
                  <button key={p} onClick={() => void send(p)} className="rounded-full border px-3 py-1 text-xs hover:bg-black/[.03]">
                    {p}
                  </button>
                ))}
              </div>
            )}
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs" aria-label="Context">
              {context.map((id) => (
                <span key={id} className="flex items-center gap-1 rounded-full border px-2 py-0.5">
                  {nameOf.get(id) ?? "Project"}
                  <button onClick={() => setContext(context.filter((x) => x !== id))} aria-label={`Remove ${nameOf.get(id)}`}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {fileCtx.map((f) => (
                <span key={f.uploadId} className="flex items-center gap-1 rounded-full border px-2 py-0.5">
                  {f.name}
                  <button onClick={() => setFileCtx(fileCtx.filter((x) => x.uploadId !== f.uploadId))} aria-label={`Remove ${f.name}`}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {chatCtx.map((c) => (
                <span key={c.id} className="flex items-center gap-1 rounded-full border px-2 py-0.5">
                  Chat: {c.title}
                  <button onClick={() => setChatCtx(chatCtx.filter((x) => x.id !== c.id))} aria-label={`Remove chat ${c.title}`}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {files.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    const f = files.find((x) => x.uploadId === e.target.value);
                    if (f && !fileCtx.some((x) => x.uploadId === f.uploadId) && fileCtx.length < 5) setFileCtx([...fileCtx, f]);
                  }}
                  aria-label="Add a file to the conversation"
                  className="rounded-md bg-transparent py-0.5"
                  style={muted}
                >
                  <option value="">Add a file</option>
                  {files.map((f) => (
                    <option key={f.uploadId} value={f.uploadId}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
              {chats.filter((c) => c.id !== chatId).length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    const c = chats.find((x) => x.id === e.target.value);
                    if (c && !chatCtx.some((x) => x.id === c.id) && chatCtx.length < 5) setChatCtx([...chatCtx, { id: c.id, title: c.title }]);
                  }}
                  aria-label="Add an earlier chat to the conversation"
                  className="rounded-md bg-transparent py-0.5"
                  style={muted}
                >
                  <option value="">Add an earlier chat</option>
                  {chats
                    .filter((c) => c.id !== chatId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                </select>
              )}
              <label className="flex items-center gap-1" style={muted}>
                <FolderPlus className="h-3.5 w-3.5" />
                <select
                  value=""
                  onChange={(e) => e.target.value && !context.includes(e.target.value) && setContext([...context, e.target.value])}
                  aria-label="Add a project to the conversation"
                  className="rounded-md bg-transparent py-0.5"
                >
                  <option value="">Add a project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex gap-2 rounded-2xl border p-2" style={{ background: "var(--panel)" }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={2}
                placeholder={`Ask about your projects, or tell ${brand.shortName} what to build…`}
                aria-label="Message the assistant"
                className="min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none"
              />
              <button
                onClick={() => void send(input)}
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="self-end rounded-lg p-2 text-white disabled:opacity-40"
                style={{ background: "var(--accent)" }}
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
