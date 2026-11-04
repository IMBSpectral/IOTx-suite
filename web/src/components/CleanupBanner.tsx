"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

/** Shown on an abandoned project before clean-up deletes it: "Keep it" or "Protect it". */
export default function CleanupBanner({ projectId, canAnswer }: { projectId: string; canAnswer: boolean }) {
  const [deletesAt, setDeletesAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/cleanup`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setDeletesAt(d.deletesAt))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);

  if (!deletesAt) return null;

  async function answer(choice: "keep" | "protect") {
    setBusy(true);
    const res = await fetch(`/api/projects/${projectId}/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice }),
    });
    setBusy(false);
    if (res.ok) setDeletesAt(null);
  }

  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/[.08] px-3 py-2 text-xs">
      <Trash2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
      <span className="min-w-0 flex-1">
        Nobody has worked on this project in a long time, so it will be deleted on{" "}
        <b>{new Date(deletesAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</b>.
      </span>
      {canAnswer ? (
        <>
          <button disabled={busy} onClick={() => void answer("keep")} className="btn-primary rounded-lg px-2.5 py-1 disabled:opacity-50">
            Keep it
          </button>
          <button disabled={busy} onClick={() => void answer("protect")} className="rounded-lg border px-2.5 py-1 hover:bg-black/[.04] disabled:opacity-50 dark:hover:bg-white/[.06]">
            Protect it
          </button>
        </>
      ) : (
        <span style={{ color: "var(--muted)" }}>Ask a workspace admin to keep it.</span>
      )}
    </div>
  );
}
