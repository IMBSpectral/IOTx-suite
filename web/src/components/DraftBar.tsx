"use client";

import { useCallback, useEffect, useState } from "react";
import DraftDiff from "./DraftDiff";

type Draft = {
  id: string;
  name: string;
  status: "BUILDING" | "READY" | "FAILED" | "MERGED" | "REVERTED";
  createdAt: string;
  mergedAt: string | null;
  unseen: boolean;
  ownBackend?: boolean;
  behind?: boolean;
  acceptBlockedReason: string | null;
};

const STATUS: Record<Draft["status"], { label: string; dot: string }> = {
  BUILDING: { label: "Building", dot: "bg-amber-500 animate-pulse" },
  READY: { label: "Ready for review", dot: "bg-emerald-500" },
  FAILED: { label: "Failed", dot: "bg-red-500" },
  MERGED: { label: "Accepted", dot: "bg-zinc-400" },
  REVERTED: { label: "Discarded", dot: "bg-zinc-300" },
};

/**
 * The review strip for drafts.
 *
 * Agent work lands in a draft branch rather than on the project, so this is
 * where the user sees which version the preview shows, switches between open
 * drafts, and accepts, discards or reverts them. `version` is bumped by the
 * editor whenever a build emits a draft event, which keeps this in step with
 * a running build without polling.
 */
export default function DraftBar({
  projectId,
  version,
  onChanged,
}: {
  projectId: string;
  version: number;
  onChanged: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the project uses Forge Cloud, so drafts can test with their own data.
  const [cloud, setCloud] = useState(false);
  // Review before keeping (per project). Off: changes go straight into the working version, so the strip only shows while a draft is open.
  const [review, setReview] = useState(false);
  // "View changes" for the draft being looked at.
  const [diffOf, setDiffOf] = useState<{ id: string; name: string } | null>(null);

  const fetchDrafts = useCallback(
    () =>
      fetch(`/api/projects/${projectId}/drafts`)
        .then((r) => (r.ok ? (r.json() as Promise<{ drafts: Draft[]; current: string | null; cloud?: boolean; review?: boolean }>) : null))
        .catch(() => null),
    [projectId],
  );
  const apply = useCallback((d: { drafts: Draft[]; current: string | null; cloud?: boolean; review?: boolean } | null) => {
    if (!d) return;
    setDrafts(d.drafts);
    setCloud(!!d.cloud);
    setReview(!!d.review);
    setCurrent(d.current);
    setFocus((f) => (f && d.drafts.some((x) => x.id === f) ? f : d.current));
  }, []);
  const load = useCallback(() => fetchDrafts().then(apply), [fetchDrafts, apply]);

  useEffect(() => {
    let live = true;
    fetchDrafts().then((d) => live && apply(d));
    return () => {
      live = false;
    };
  }, [fetchDrafts, apply, version]);

  const act = useCallback(
    async (draftId: string, action: string, extra: Record<string, unknown> = {}) => {
      setBusy(action);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/drafts/${draftId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, ...extra }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(body.error ?? "That didn't work.");
          return;
        }
        await load();
        onChanged();
      } finally {
        setBusy(null);
      }
    },
    [projectId, load, onChanged],
  );

  const open = drafts.filter((d) => d.status !== "MERGED");
  const accepted = drafts.filter((d) => d.status === "MERGED").slice(0, 5);
  if (drafts.length === 0 || (!review && open.length === 0)) return null;

  const focused = drafts.find((d) => d.id === focus) ?? null;

  function choose(value: string) {
    setError(null);
    if (value === "main") {
      setFocus(null);
      if (current) void act("main", "checkout");
      return;
    }
    const d = drafts.find((x) => x.id === value);
    if (!d) return;
    setFocus(d.id);
    // An accepted draft is already part of main; selecting it only offers a revert.
    if (d.status !== "MERGED" && d.id !== current) void act(d.id, "checkout");
  }

  const viewing = focused ?? null;
  const status = viewing ? STATUS[viewing.status] : null;

  return (
    <div className="border-b px-4 py-2" style={{ background: "var(--panel)" }}>
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${status ? status.dot : "bg-zinc-300"}`}
          aria-hidden
        />
        <label className="sr-only" htmlFor="draft-select">
          Version shown in the preview
        </label>
        <select
          id="draft-select"
          value={focus ?? "main"}
          onChange={(e) => choose(e.target.value)}
          disabled={!!busy}
          className="min-w-0 flex-1 truncate rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
        >
          <option value="main">Main — accepted version</option>
          {open.length > 0 && (
            <optgroup label="Drafts">
              {open.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.unseen ? "● " : ""}
                  {d.name} · {STATUS[d.status].label}
                </option>
              ))}
            </optgroup>
          )}
          {accepted.length > 0 && (
            <optgroup label="Recently accepted">
              {accepted.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        {viewing && viewing.status !== "BUILDING" && (
          <button
            onClick={() => setDiffOf({ id: viewing.id, name: viewing.name })}
            className="rounded-md px-2 py-1 text-xs transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            style={{ color: "var(--muted)" }}
          >
            View changes
          </button>
        )}
        {viewing?.status === "READY" && viewing.behind && (
          <button
            onClick={() => act(viewing.id, "sync")}
            disabled={!!busy}
            title="Update the draft to catch up with the project before accepting"
            className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:hover:bg-white/[.06]"
          >
            {busy === "sync" ? "Updating…" : "Update draft"}
          </button>
        )}
        {viewing?.status === "READY" && (
          <>
            <button
              onClick={() => act(viewing.id, "discard")}
              disabled={!!busy}
              className="rounded-md px-2 py-1 text-xs transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:hover:bg-white/[.06]"
              style={{ color: "var(--muted)" }}
            >
              Discard
            </button>
            <button
              onClick={() => act(viewing.id, "accept")}
              disabled={!!busy || !!viewing.behind}
              className="rounded-md bg-[#6d4aff] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy === "accept" ? "Accepting…" : "Accept"}
            </button>
          </>
        )}

        {viewing?.status === "FAILED" && (
          <button
            onClick={() => act(viewing.id, "discard")}
            disabled={!!busy}
            className="rounded-md px-2 py-1 text-xs transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:hover:bg-white/[.06]"
            style={{ color: "var(--muted)" }}
          >
            Discard
          </button>
        )}

        {viewing?.status === "MERGED" && (
          <button
            onClick={() => act(viewing.id, "revert")}
            disabled={!!busy}
            className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:hover:bg-white/[.06]"
          >
            {busy === "revert" ? "Reverting…" : "Revert"}
          </button>
        )}
      </div>

      {viewing?.status === "FAILED" && !error && (
        <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
          This draft didn&apos;t finish. Send a message and the agent will keep working on it.
        </p>
      )}
      {viewing?.status === "READY" && viewing.behind && !error && (
        <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
          Updates available for this draft: the project changed since it was made. Update the draft to catch up
          before accepting.
        </p>
      )}
      {cloud && viewing && viewing.status !== "MERGED" && viewing.status !== "REVERTED" && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: "var(--muted)" }}>
          {viewing.ownBackend ? (
            <>
              <span>This draft has its own backend, filled with example data, so you can test changes separately from your live app.</span>
              <button onClick={() => act(viewing.id, "backend", { on: true })} disabled={!!busy} className="underline disabled:opacity-50">
                {busy === "backend" ? "Working…" : "Refresh example data"}
              </button>
              <button onClick={() => act(viewing.id, "backend", { on: false })} disabled={!!busy} className="underline disabled:opacity-50">
                Use live data
              </button>
            </>
          ) : (
            <>
              <span>The preview of this draft uses your live data.</span>
              <button onClick={() => act(viewing.id, "backend", { on: true })} disabled={!!busy} className="underline disabled:opacity-50">
                {busy === "backend" ? "Setting up…" : "Test with its own backend"}
              </button>
            </>
          )}
        </p>
      )}
      {viewing?.status === "BUILDING" && (
        <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
          The agent is working in this draft. Main is unchanged until you accept it.
        </p>
      )}
      {diffOf && <DraftDiff projectId={projectId} draftId={diffOf.id} name={diffOf.name} onClose={() => setDiffOf(null)} />}
      {error && (
        <p className="mt-1.5 text-[11px] text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
