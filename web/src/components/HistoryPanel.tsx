"use client";

import { useEffect, useState } from "react";

type Commit = { sha: string; message: string; at: string; draft?: { name: string; turns: number; openFor: number | null } };
type Bookmark = { id: string; sha: string; name: string; createdAt: string };

/** Version history and bookmarks, with restore from either. */
export default function HistoryPanel({
  projectId,
  open,
  onClose,
  onReverted,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onReverted: (sha: string) => void;
}) {
  const [tab, setTab] = useState<"history" | "bookmarks">("history");
  const [commits, setCommits] = useState<Commit[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loading = open && !loaded;
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    Promise.all([
      fetch(`/api/projects/${projectId}/history`).then((r) => r.json()),
      fetch(`/api/projects/${projectId}/bookmarks`).then((r) => r.json()),
    ])
      .then(([h, b]) => {
        if (!live) return;
        setCommits(h.commits ?? []);
        setBookmarks(b.bookmarks ?? []);
      })
      .catch(() => undefined)
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [open, projectId]);

  if (!open) return null;

  const headSha = commits[0]?.sha;

  // A past version opens on its own host; if its build was cleaned up, that page offers a rebuild.
  async function preview(sha: string) {
    const res = await fetch(`/api/projects/${projectId}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.url) window.open(d.url, "_blank", "noopener");
  }

  async function revert(sha: string) {
    setBusy(sha);
    try {
      const res = await fetch(`/api/projects/${projectId}/revert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha }),
      });
      if (res.ok) {
        const d = await res.json();
        onReverted(d.sha);
        onClose();
      }
    } finally {
      setBusy(null);
    }
  }

  async function bookmark(sha: string, message: string) {
    const res = await fetch(`/api/projects/${projectId}/bookmarks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha, name: message.slice(0, 60) }),
    });
    if (res.ok) {
      const { bookmark: b } = await res.json();
      setBookmarks((all) => [b, ...all]);
      setTab("bookmarks");
    }
  }

  async function rename(id: string, name: string) {
    setRenaming(null);
    if (!name.trim()) return;
    setBookmarks((all) => all.map((b) => (b.id === id ? { ...b, name: name.trim() } : b)));
    await fetch(`/api/projects/${projectId}/bookmarks`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: id, name }),
    });
  }

  async function remove(id: string) {
    setBookmarks((all) => all.filter((b) => b.id !== id));
    await fetch(`/api/projects/${projectId}/bookmarks?bookmarkId=${id}`, { method: "DELETE" });
  }

  const tabClass = (t: string) =>
    `rounded-md px-2 py-1 text-xs ${tab === t ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`;

  return (
    <div className="absolute inset-0 z-20 flex">
      <button aria-label="Close history" onClick={onClose} className="flex-1 bg-black/20" />
      <div className="flex w-80 flex-col border-l shadow-xl" style={{ background: "var(--panel)" }}>
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
          <div className="flex gap-0.5" role="tablist">
            <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")} className={tabClass("history")}>
              History
            </button>
            <button role="tab" aria-selected={tab === "bookmarks"} onClick={() => setTab("bookmarks")} className={tabClass("bookmarks")}>
              Bookmarks{bookmarks.length ? ` · ${bookmarks.length}` : ""}
            </button>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-xs" style={{ color: "var(--muted)" }}>
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && (
            <p className="p-2 text-sm" style={{ color: "var(--muted)" }}>
              Loading…
            </p>
          )}

          {!loading && tab === "history" && commits.length === 0 && (
            <p className="p-2 text-sm" style={{ color: "var(--muted)" }}>
              No history yet.
            </p>
          )}
          {tab === "history" &&
            commits.map((c, i) => (
              <div key={c.sha} className="rounded-lg p-2.5 hover:bg-black/[.03] dark:hover:bg-white/[.05]">
                <p className="text-sm leading-snug">{c.message}</p>
                {c.draft && (
                  <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
                    Draft summary: {c.draft.turns} {c.draft.turns === 1 ? "turn" : "turns"}
                    {c.draft.openFor !== null ? ` over ${Math.max(1, Math.round(c.draft.openFor / 60_000))} min` : ""} before it was accepted.
                  </p>
                )}
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px]" style={{ color: "var(--muted)" }}>
                    {c.sha.slice(0, 7)} · {new Date(c.at).toLocaleString()}
                  </span>
                  <span className="flex gap-2">
                    <button onClick={() => preview(c.sha)} className="text-[11px] hover:underline" style={{ color: "var(--muted)" }}>
                      Preview
                    </button>
                    <button
                      onClick={() => bookmark(c.sha, c.message)}
                      className="text-[11px] hover:underline"
                      style={{ color: "var(--muted)" }}
                    >
                      Bookmark
                    </button>
                    {i > 0 ? (
                      <button
                        onClick={() => revert(c.sha)}
                        disabled={busy !== null}
                        className="text-[11px] font-medium hover:underline disabled:opacity-50"
                        style={{ color: "var(--accent)" }}
                      >
                        {busy === c.sha ? "Restoring…" : "Restore"}
                      </button>
                    ) : (
                      <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                        Current
                      </span>
                    )}
                  </span>
                </div>
              </div>
            ))}

          {!loading && tab === "bookmarks" && bookmarks.length === 0 && (
            <p className="p-2 text-sm" style={{ color: "var(--muted)" }}>
              No bookmarks yet. Bookmark a version from History or from a message to come back to it.
            </p>
          )}
          {tab === "bookmarks" &&
            bookmarks.map((b) => (
              <div key={b.id} className="rounded-lg p-2.5 hover:bg-black/[.03] dark:hover:bg-white/[.05]">
                {renaming?.id === b.id ? (
                  <input
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: b.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename(b.id, renaming.name);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={() => void rename(b.id, renaming.name)}
                    aria-label="Bookmark name"
                    className="w-full rounded border bg-transparent px-1.5 py-0.5 text-sm outline-none"
                  />
                ) : (
                  <p className="text-sm leading-snug">{b.name}</p>
                )}
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px]" style={{ color: "var(--muted)" }}>
                    {b.sha.slice(0, 7)} · {new Date(b.createdAt).toLocaleDateString()}
                  </span>
                  <span className="flex gap-2">
                    <button onClick={() => setRenaming({ id: b.id, name: b.name })} className="text-[11px] hover:underline" style={{ color: "var(--muted)" }}>
                      Rename
                    </button>
                    <button onClick={() => remove(b.id)} className="text-[11px] hover:underline" style={{ color: "var(--muted)" }}>
                      Remove
                    </button>
                    {b.sha === headSha ? (
                      <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                        Current
                      </span>
                    ) : (
                      <button
                        onClick={() => revert(b.sha)}
                        disabled={busy !== null}
                        className="text-[11px] font-medium hover:underline disabled:opacity-50"
                        style={{ color: "var(--accent)" }}
                      >
                        {busy === b.sha ? "Restoring…" : "Restore"}
                      </button>
                    )}
                  </span>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
