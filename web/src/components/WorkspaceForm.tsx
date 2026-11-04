"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function WorkspaceForm({
  initialName,
  canEdit,
}: {
  initialName: string;
  canEdit: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function save() {
    const next = name.trim();
    if (!next || next === initialName || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Could not save");
      }
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-sm font-medium">Name</h2>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          disabled={!canEdit || busy}
          aria-label="Workspace name"
          className="flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-60"
          style={{ background: "var(--panel)" }}
        />
        <button
          onClick={save}
          disabled={!canEdit || busy || !name.trim() || name === initialName}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
          style={{ background: "var(--accent)" }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {!canEdit && (
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          Only owners and admins can rename the workspace.
        </p>
      )}
      {saved && (
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          Saved.
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
