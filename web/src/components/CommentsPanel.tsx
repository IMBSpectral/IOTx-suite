"use client";

import { useEffect, useState } from "react";
import {
  Check,
  MessageSquarePlus,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { CommentView, ThreadView } from "@/lib/comments";

const REACTIONS = ["👍", "❤️", "🎉", "👀", "✅"];

export type PendingPin = {
  locator: string;
  selector: string;
  text: string;
  shot?: string;
};

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Mentions read as mentions; the text is otherwise plain. */
function Body({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {text.split(/(@[\w.@-]+)/g).map((part, i) =>
        part.startsWith("@") ? (
          <span key={i} className="font-medium text-[#6d4aff]">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/**
 * Comment threads pinned to preview elements. Threads are numbered in the
 * order the pins show them; the editor draws the pins inside the preview.
 */
export default function CommentsPanel({
  projectId,
  pending,
  onPendingDone,
  activeId,
  setActiveId,
  missing,
  onThreads,
  onSendToChat,
  onClose,
}: {
  projectId: string;
  pending: PendingPin | null;
  onPendingDone: () => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  missing: Set<string>;
  onThreads: (threads: ThreadView[]) => void;
  onSendToChat: (thread: ThreadView) => void;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [version, setVersion] = useState(0);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"date" | "unread">("date");
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${projectId}/comments`;

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(base)
        .then((r) => (r.ok ? r.json() : { threads: [] }))
        .then((d) => {
          if (!live) return;
          setThreads(d.threads);
          onThreads(d.threads);
        });
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // onThreads is a stable setter from the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, version]);

  const reload = () => setVersion((v) => v + 1);

  async function call(url: string, method: string, body?: unknown) {
    setError(null);
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d.error ?? "Something went wrong");
      return null;
    }
    reload();
    return d;
  }

  async function createThread() {
    if (!pending || !draft.trim()) return;
    const d = await call(base, "POST", {
      body: draft,
      locator: pending.locator,
      selector: pending.selector,
      elementText: pending.text,
      elementShot: pending.shot,
    });
    if (d) {
      setDraft("");
      onPendingDone();
      setActiveId(d.id);
    }
  }

  const needle = q.trim().toLowerCase();
  const visible = threads
    .filter((t) => showResolved || !t.resolvedAt)
    .filter(
      (t) =>
        !needle ||
        [t, ...t.replies].some(
          (c) =>
            c.body.toLowerCase().includes(needle) ||
            c.author.name.toLowerCase().includes(needle),
        ),
    )
    .sort((a, b) =>
      sort === "unread" ? Number(b.unread) - Number(a.unread) : 0,
    );
  // Pin numbers follow the unfiltered order of open threads.
  const numberOf = new Map(
    threads.filter((t) => !t.resolvedAt).map((t, i) => [t.id, i + 1]),
  );
  const active = threads.find((t) => t.id === activeId) ?? null;
  const muted = { color: "var(--muted)" };

  const renderComment = (c: CommentView, root?: ThreadView) => (
    <div key={c.id} className="group">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">
          {c.author.name}
          {c.author.guest && (
            <span className="ml-1 font-normal" style={muted}>
              · guest{c.author.via ? ` via ${c.author.via}` : ""}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[10px]" style={muted}>
          {ago(c.createdAt)}
          {c.editedAt ? " · edited" : ""}
        </span>
      </div>
      {editing?.id === c.id ? (
        <div className="mt-1">
          <textarea
            value={editing.text}
            onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
            rows={2}
            aria-label="Edit comment"
            className="w-full resize-none rounded-md border bg-transparent px-2 py-1 text-sm outline-none"
          />
          <div className="mt-1 flex justify-end gap-1 text-xs">
            <button onClick={() => setEditing(null)} style={muted}>
              Cancel
            </button>
            <button
              onClick={async () => {
                if (
                  await call(`${base}/${c.id}`, "PATCH", { body: editing.text })
                )
                  setEditing(null);
              }}
              className="font-medium"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-0.5">
          <Body text={c.body} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {c.reactions.map((r) => (
          <button
            key={r.emoji}
            onClick={() => call(`${base}/${c.id}`, "PATCH", { react: r.emoji })}
            aria-pressed={r.mine}
            className={`rounded-full border px-1.5 text-[11px] ${r.mine ? "border-[#6d4aff] bg-[#6d4aff]/10" : ""}`}
          >
            {r.emoji} {r.count}
          </button>
        ))}
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {REACTIONS.filter(
            (e) => !c.reactions.some((r) => r.emoji === e && r.mine),
          ).map((e) => (
            <button
              key={e}
              onClick={() => call(`${base}/${c.id}`, "PATCH", { react: e })}
              aria-label={`React ${e}`}
              className="rounded px-0.5 text-xs hover:bg-black/[.05]"
            >
              {e}
            </button>
          ))}
          {c.mine && (
            <button
              onClick={() => setEditing({ id: c.id, text: c.body })}
              aria-label="Edit"
              className="rounded p-0.5 hover:bg-black/[.05]"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {c.mine && (
            <button
              onClick={() => {
                if (
                  confirm(
                    root
                      ? "Delete this thread and its replies?"
                      : "Delete this reply?",
                  )
                ) {
                  void call(`${base}/${c.id}`, "DELETE").then(
                    () => root && setActiveId(null),
                  );
                }
              }}
              aria-label="Delete"
              className="rounded p-0.5 text-red-500 hover:bg-red-500/[.08]"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>
    </div>
  );

  return (
    <aside
      aria-label="Comments"
      className="absolute bottom-0 right-0 top-0 z-20 flex w-80 flex-col border-l shadow-xl"
      style={{ background: "var(--panel)" }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Comments</span>
        <span className="flex items-center gap-1">
          <button
            onClick={() => call(base, "POST", { action: "read" })}
            className="text-[11px] hover:underline"
            style={muted}
          >
            Mark all as read
          </button>
          <button
            onClick={onClose}
            aria-label="Close comments"
            className="rounded p-1 hover:bg-black/[.05]"
          >
            <X className="h-4 w-4" />
          </button>
        </span>
      </div>

      {pending && (
        <div className="border-b p-3">
          <p className="mb-1 truncate text-[11px]" style={muted}>
            On <span className="font-mono">{pending.selector}</span>
            {pending.text ? ` · “${pending.text.slice(0, 40)}”` : ""}
          </p>
          {pending.shot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pending.shot}
              alt="Element at annotation time"
              className="mb-2 max-h-28 rounded border object-contain"
            />
          )}
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" &&
              (e.metaKey || e.ctrlKey) &&
              void createThread()
            }
            rows={3}
            placeholder="Add a comment. Use @ to mention someone."
            aria-label="New comment"
            className="w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
          />
          <div className="mt-1 flex justify-end gap-1.5 text-xs">
            <button onClick={onPendingDone} style={muted}>
              Cancel
            </button>
            <button
              onClick={createThread}
              disabled={!draft.trim()}
              className="rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-40"
              style={{ background: "var(--accent)" }}
            >
              Comment
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="px-3 pt-2 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      {active ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <button
            onClick={() => setActiveId(null)}
            className="mb-2 text-xs hover:underline"
            style={muted}
          >
            ← All comments
          </button>
          {missing.has(active.id) && !active.resolvedAt && (
            <p className="mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700">
              The annotated element was removed, changed, or is not currently
              visible.
            </p>
          )}
          <p className="mb-2 truncate text-[11px]" style={muted}>
            #{numberOf.get(active.id) ?? "–"} ·{" "}
            <span className="font-mono">{active.selector}</span>
          </p>
          {active.hasShot && (
            <figure className="mb-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${base}?shot=${active.id}`}
                alt="Element at annotation time"
                className="max-h-40 rounded border object-contain"
              />
              <figcaption className="mt-0.5 text-[10px]" style={muted}>
                Element at annotation time
              </figcaption>
            </figure>
          )}
          {renderComment(active, active)}
          <div className="mt-3 space-y-3 border-l pl-3">
            {active.replies.map((r) => renderComment(r))}
          </div>
          <div className="mt-3 flex gap-1.5">
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={async (e) => {
                if (
                  e.key === "Enter" &&
                  reply.trim() &&
                  (await call(base, "POST", {
                    body: reply,
                    parentId: active.id,
                  }))
                )
                  setReply("");
              }}
              placeholder="Reply"
              aria-label="Reply"
              className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
            />
            <button
              onClick={async () => {
                if (
                  reply.trim() &&
                  (await call(base, "POST", {
                    body: reply,
                    parentId: active.id,
                  }))
                )
                  setReply("");
              }}
              aria-label="Send reply"
              className="rounded-lg border px-2"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-3 flex gap-1.5 text-xs">
            <button
              onClick={() =>
                call(`${base}/${active.id}`, "PATCH", {
                  resolved: !active.resolvedAt,
                })
              }
              className="flex items-center gap-1 rounded-md border px-2 py-1"
            >
              <Check className="h-3 w-3" />{" "}
              {active.resolvedAt ? "Reopen" : "Resolve"}
            </button>
            <button
              onClick={() => onSendToChat(active)}
              className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              <MessageSquarePlus className="h-3 w-3" /> Send to chat
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-1.5 border-b p-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search comments"
              aria-label="Search comments"
              className="w-full rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
            />
            <div className="flex items-center justify-between text-[11px]">
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as "date" | "unread")}
                aria-label="Sort comments"
                className="rounded border bg-transparent px-1 py-0.5"
              >
                <option value="date">Newest</option>
                <option value="unread">Unread first</option>
              </select>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setShowResolved(e.target.checked)}
                />
                Show resolved
              </label>
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 && (
              <li className="px-3 py-8 text-center text-xs" style={muted}>
                {threads.length
                  ? "No comments match."
                  : "Turn on Comment and click an element in the preview to leave the first comment."}
              </li>
            )}
            {visible.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setActiveId(t.id)}
                  className={`block w-full border-b px-3 py-2 text-left hover:bg-black/[.03] ${t.resolvedAt ? "opacity-60" : ""}`}
                >
                  <span className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {t.unread && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#6d4aff]"
                          aria-label="Unread"
                        />
                      )}
                      <span className="shrink-0 font-semibold">
                        #{numberOf.get(t.id) ?? "✓"}
                      </span>
                      <span className="truncate font-medium">
                        {t.author.name}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px]" style={muted}>
                      {ago(t.createdAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-sm">
                    {t.body}
                  </span>
                  <span className="mt-0.5 block text-[10px]" style={muted}>
                    {t.replies.length
                      ? `${t.replies.length} ${t.replies.length === 1 ? "reply" : "replies"}`
                      : "No replies"}
                    {t.resolvedAt ? " · Resolved" : ""}
                    {missing.has(t.id) && !t.resolvedAt
                      ? " · Element not found"
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
