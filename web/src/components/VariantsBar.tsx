"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers } from "lucide-react";

type Group = {
  id: string;
  prompt: string;
  variants: { id: string; n: number; state: "queued" | "building" | "ready" | "failed" | "gone"; headSha: string | null }[];
};

const STATE: Record<string, string> = { queued: "Waiting", building: "Building…", ready: "Ready", failed: "Failed", gone: "Removed" };

/** The open set of variants: preview each one and keep the one you like. */
export default function VariantsBar({ projectId, version, onChanged }: { projectId: string; version: number; onChanged: () => void }) {
  const [group, setGroup] = useState<Group | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const base = `/api/projects/${projectId}/variants`;

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setGroup(d?.group ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, version, tick]);

  // While variants are still building, check back every few seconds.
  const pending = group?.variants.some((v) => v.state === "queued" || v.state === "building");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, [pending]);

  const post = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      setBusy(label);
      setError(null);
      const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      setBusy(null);
      if (!res.ok) return setError(d.error ?? "Something went wrong");
      setTick((x) => x + 1);
      onChanged();
    },
    [base, onChanged],
  );

  async function preview(sha: string) {
    const res = await fetch(`/api/projects/${projectId}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.url) window.open(d.url, "_blank", "noopener");
  }

  if (!group) return null;
  return (
    <section aria-label="Variants" className="mx-3 mt-2 rounded-xl border p-3 text-xs" style={{ background: "var(--panel)" }}>
      <p className="flex items-center gap-1.5 font-medium">
        <Layers className="h-3.5 w-3.5" /> {group.variants.length} variants
        <span className="truncate font-normal" style={{ color: "var(--muted)" }}>
          · {group.prompt}
        </span>
      </p>
      <ul className="mt-2 space-y-1.5">
        {group.variants.map((v) => (
          <li key={v.id} className="flex items-center gap-2">
            <span className="w-16 shrink-0 font-medium">Variant {v.n}</span>
            <span className={`flex-1 ${v.state === "failed" ? "text-red-600" : ""}`} style={v.state === "failed" ? undefined : { color: "var(--muted)" }}>
              {STATE[v.state]}
            </span>
            {v.state === "ready" && v.headSha && (
              <button onClick={() => void preview(v.headSha!)} className="rounded-md border px-2 py-0.5">
                Preview
              </button>
            )}
            <button
              onClick={() => post({ action: "choose", groupId: group.id, draftId: v.id }, v.id)}
              disabled={!!busy || pending || v.state !== "ready"}
              className="rounded-md px-2 py-0.5 font-medium text-white disabled:opacity-40"
              style={{ background: "var(--accent)" }}
            >
              {busy === v.id ? "Keeping…" : "Use this"}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between">
        <span style={{ color: "var(--muted)" }}>{pending ? "Variants build one after another." : "Keep one; the others are discarded."}</span>
        <button onClick={() => post({ action: "discard", groupId: group.id }, "discard")} disabled={!!busy || pending} className="hover:underline disabled:opacity-40">
          Discard all
        </button>
      </div>
      {error && (
        <p className="mt-1 text-red-600" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
