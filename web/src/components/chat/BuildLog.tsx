"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type Line = { t: number; kind: string; text: string };

/** A turn's job log: every step the build took, with timings. */
export default function BuildLog({ buildId, onClose }: { buildId: string; onClose: () => void }) {
  const [data, setData] = useState<{ status: string; durationMs: number | null; error: string | null; lines: Line[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/builds/${buildId}/log`)
      .then(async (r) => {
        const d = await r.json();
        if (!live) return;
        if (r.ok) setData(d);
        else setError(d.error ?? "Couldn't load the log.");
      })
      .catch(() => live && setError("Couldn't load the log."));
    return () => {
      live = false;
    };
  }, [buildId]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const tone: Record<string, string> = { error: "text-red-500", file: "text-emerald-600 dark:text-emerald-400", tool: "text-sky-600 dark:text-sky-400" };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-label="Build log" onClick={onClose}>
      <div className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border shadow-2xl" style={{ background: "var(--panel)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 items-center justify-between border-b px-4 text-sm">
          <span className="font-medium">
            Build log
            {data && (
              <span className="ml-2 text-xs font-normal" style={{ color: "var(--muted)" }}>
                {data.status.toLowerCase()}
                {data.durationMs ? ` · ${Math.round(data.durationMs / 1000)}s` : ""} · {data.lines.length} events
              </span>
            )}
          </span>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-[#0d0d10] p-3 font-mono text-[11.5px] leading-5 text-zinc-300">
          {error && <p className="text-red-400">{error}</p>}
          {!data && !error && <p className="text-zinc-500">Loading…</p>}
          {data?.lines.map((l, i) => (
            <div key={i} className="flex gap-3">
              <span className="w-14 shrink-0 text-right text-zinc-600">{(l.t / 1000).toFixed(1)}s</span>
              <span className="w-12 shrink-0 text-zinc-500">{l.kind}</span>
              <span className={`min-w-0 whitespace-pre-wrap break-words ${tone[l.kind] ?? ""}`}>{l.text}</span>
            </div>
          ))}
          {data?.error && <p className="mt-2 text-red-400">Build error: {data.error}</p>}
        </div>
      </div>
    </div>
  );
}
