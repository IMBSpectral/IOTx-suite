"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, MessageSquarePlus, MessagesSquare, Pencil, Trash2 } from "lucide-react";

type Chat = { id: string | null; title: string; messages: number; lastAt: string | null; mine: boolean; by: string | null };

/**
 * The project's chats: the main chat and any others, each its own
 * conversation with the agent. Switching opens ?chat=<id>.
 */
export default function ChatSwitcher({ projectId, chatId, canEdit }: { projectId: string; chatId: string | null; canEdit: boolean }) {
  const router = useRouter();
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [open, setOpen] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/chats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setChats(d.chats))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, version]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const go = (id: string | null) => {
    setOpen(false);
    if (id === chatId) return;
    router.push(id ? `/projects/${projectId}?chat=${id}` : `/projects/${projectId}`);
  };

  async function call(method: string, body?: unknown, query = "") {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/chats${query}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) setError(d.error ?? "That didn't work.");
    setVersion((v) => v + 1);
    return res.ok ? d : null;
  }

  const current = chats?.find((c) => c.id === chatId) ?? { title: chatId ? "Chat" : "Main chat" };
  const shown = (chats ?? []).filter((c) => !onlyMine || c.mine);
  return (
    <div ref={box} className="relative border-b px-3 py-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium hover:bg-black/[.04] dark:hover:bg-white/[.06]"
      >
        <MessagesSquare className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--muted)" }} />
        <span className="truncate">{current.title}</span>
        {chats && chats.length > 1 && <span style={{ color: "var(--muted)" }}>· {chats.length} chats</span>}
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div role="menu" className="absolute left-2 top-full z-40 mt-1 w-80 rounded-xl border p-1 text-xs shadow-xl" style={{ background: "var(--panel)" }}>
          <div className="flex items-center justify-between px-2 py-1">
            <span style={{ color: "var(--muted)" }}>Chats in this project</span>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Mine
            </label>
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {shown.map((c) => (
              <li key={c.id ?? "main"} className="group flex items-center gap-1">
                <button
                  role="menuitem"
                  onClick={() => go(c.id)}
                  className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-black/[.05] dark:hover:bg-white/[.06] ${c.id === chatId ? "font-medium" : ""}`}
                >
                  <span className="truncate">{c.title}</span>
                  <span className="shrink-0" style={{ color: "var(--muted)" }}>
                    {c.messages} msg{c.by && !c.mine ? ` · ${c.by}` : ""}
                  </span>
                </button>
                {canEdit && c.id && (
                  <span className="hidden shrink-0 group-hover:flex">
                    <button
                      aria-label={`Rename ${c.title}`}
                      onClick={() => {
                        const t = window.prompt("Rename chat", c.title);
                        if (t?.trim()) void call("PATCH", { chatId: c.id, title: t.trim() });
                      }}
                      className="rounded p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      aria-label={`Delete ${c.title}`}
                      onClick={async () => {
                        if (!window.confirm(`Delete "${c.title}" and its messages? Code changes it made stay in History.`)) return;
                        if ((await call("DELETE", undefined, `?chatId=${c.id}`)) && c.id === chatId) go(null);
                      }}
                      className="rounded p-1 text-red-500 hover:bg-red-500/[.08]"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <button
              onClick={async () => {
                const d = await call("POST", {});
                if (d?.chat) go(d.chat.id);
              }}
              className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-black/[.05] dark:hover:bg-white/[.06]"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" /> New chat
            </button>
          )}
          {error && <p className="px-2 py-1 text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
