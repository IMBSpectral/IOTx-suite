"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function ProjectMenu({
  projectId,
  name,
  onRenamed,
  initialIsTemplate = false,
}: {
  projectId: string;
  name: string;
  onRenamed: (next: string) => void;
  initialIsTemplate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isTemplate, setIsTemplate] = useState(initialIsTemplate);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState<null | { id: string; kind: string; name: string }[]>(null);
  const [placed, setPlaced] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function rename() {
    const next = draft.trim();
    if (!next || next === name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (res.ok) {
        onRenamed(next);
        router.refresh();
      }
    } finally {
      setBusy(false);
      setRenaming(false);
      setOpen(false);
    }
  }

  async function duplicate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/duplicate`, {
        method: "POST",
      });
      if (res.ok) {
        const { project } = await res.json();
        router.push(`/projects/${project.id}`);
      }
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  /** "Add to dashboard or folder": the ones this person sees and may add to. */
  async function startPlacing() {
    const r = await fetch("/api/spaces");
    const d = await r.json().catch(() => ({}));
    const all = (d.spaces ?? []) as { id: string; kind: string; name: string; mine: boolean }[];
    setPlaced(null);
    setPlacing(all.filter((x) => d.can?.add || x.mine));
  }

  async function place(spaceId: string, spaceName: string) {
    const r = await fetch("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "addItem", spaceId, kind: "project", ref: projectId }),
    });
    const d = await r.json().catch(() => ({}));
    setPlaced(r.ok ? `Added to ${spaceName}` : (d.error ?? "Couldn't add it."));
    try {
      window.parent?.dispatchEvent(new Event("iotx:spaces"));
    } catch {}
  }

  async function destroy() {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (res.ok) router.push("/dashboard");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Project actions"
        className="rounded-lg px-2 py-1 text-xs transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
        style={{ color: "var(--muted)" }}
      >
        •••
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-30 w-52 overflow-hidden rounded-xl border shadow-lg"
          style={{ background: "var(--panel)" }}
        >
          {placing ? (
            <div className="p-1.5" role="group" aria-label="Add to dashboard or folder">
              <div className="px-2 py-1 text-xs" style={{ color: "var(--muted)" }}>
                {placed ?? "Add to dashboard or folder"}
              </div>
              {!placing.length && (
                <div className="px-2 py-1.5 text-sm" style={{ color: "var(--muted)" }}>
                  No dashboards or folders yet. Create one in the sidebar.
                </div>
              )}
              {placing.map((x) => (
                <button
                  key={x.id}
                  role="menuitem"
                  onClick={() => void place(x.id, x.name)}
                  className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                >
                  {x.kind === "dashboard" ? "▦ " : "▸ "}
                  {x.name}
                </button>
              ))}
              <button onClick={() => setPlacing(null)} className="mt-1 block w-full rounded-md px-2 py-1 text-left text-xs" style={{ color: "var(--muted)" }}>
                Back
              </button>
            </div>
          ) : renaming ? (
            <div className="p-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void rename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                aria-label="Project name"
                className="w-full rounded-lg border bg-transparent px-2 py-1.5 text-sm outline-none"
              />
              <div className="mt-1.5 flex justify-end gap-1.5">
                <button
                  onClick={() => setRenaming(false)}
                  className="rounded-md px-2 py-1 text-xs"
                  style={{ color: "var(--muted)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => void rename()}
                  disabled={busy}
                  className="rounded-md px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  setDraft(name);
                  setRenaming(true);
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                Rename
              </button>
              <button
                role="menuitem"
                onClick={duplicate}
                disabled={busy}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-black/[.04] disabled:opacity-50 dark:hover:bg-white/[.06]"
              >
                Duplicate
              </button>
              <button
                role="menuitem"
                onClick={() => void startPlacing()}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                Add to dashboard or folder…
              </button>
              <button
                role="menuitem"
                onClick={async () => {
                  await navigator.clipboard.writeText(`${location.origin}/projects/${projectId}`).catch(() => undefined);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                Copy project link
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={isTemplate}
                onClick={async () => {
                  const next = !isTemplate;
                  setIsTemplate(next);
                  await fetch(`/api/projects/${projectId}`, {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ isTemplate: next }),
                  });
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                {isTemplate ? "✓ Workspace template" : "Use as workspace template"}
              </button>
              <a
                role="menuitem"
                href={`/api/projects/${projectId}/export`}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                Download as ZIP
              </a>
              <button
                role="menuitem"
                onClick={destroy}
                disabled={busy}
                className="block w-full border-t px-3 py-2 text-left text-sm text-red-500 hover:bg-red-500/[.08] disabled:opacity-50"
              >
                Delete project
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
