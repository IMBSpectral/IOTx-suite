"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { FileDiff } from "@/lib/branch-diff";

/** "View changes": what a draft changes, file by file, as a unified diff. */
export default function DraftDiff({ projectId, draftId, name, onClose }: { projectId: string; draftId: string; name: string; onClose: () => void }) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/drafts/${draftId}/diff`)
      .then(async (r) => {
        const d = await r.json();
        if (!live) return;
        if (!r.ok) return setError(d.error ?? "Couldn't load the changes.");
        setFiles(d.files);
        setOpen(d.files[0]?.path ?? null);
      })
      .catch(() => live && setError("Couldn't load the changes."));
    return () => {
      live = false;
    };
  }, [projectId, draftId]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const current = files?.find((f) => f.path === open) ?? null;
  const totals = files?.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-label={`Changes in ${name}`} onClick={onClose}>
      <div className="flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border shadow-2xl" style={{ background: "var(--panel)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 items-center justify-between border-b px-4 text-sm">
          <span className="truncate font-medium">
            Changes in {name}
            {files && totals && (
              <span className="ml-2 text-xs font-normal" style={{ color: "var(--muted)" }}>
                {files.length} file{files.length === 1 ? "" : "s"} · <span className="text-emerald-600">+{totals.add}</span> <span className="text-red-600">−{totals.del}</span>
              </span>
            )}
          </span>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
            <X className="h-4 w-4" />
          </button>
        </div>
        {error ? (
          <p className="p-6 text-sm text-red-600">{error}</p>
        ) : !files ? (
          <p className="p-6 text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
        ) : files.length === 0 ? (
          <p className="p-6 text-sm" style={{ color: "var(--muted)" }}>This draft doesn&apos;t change any files yet.</p>
        ) : (
          <div className="flex min-h-0 flex-1">
            <ul className="w-64 shrink-0 overflow-y-auto border-r p-1 text-xs" aria-label="Changed files">
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => setOpen(f.path)}
                    className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left ${open === f.path ? "bg-black/[.06] dark:bg-white/[.08]" : "hover:bg-black/[.04] dark:hover:bg-white/[.05]"}`}
                  >
                    <span className={`w-3 shrink-0 font-mono font-bold ${f.status === "added" ? "text-emerald-600" : f.status === "deleted" ? "text-red-600" : "text-amber-600"}`}>
                      {f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={f.path}>{f.path}</span>
                    <span className="shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
                      +{f.additions} −{f.deletions}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-w-0 flex-1 overflow-auto">
              {current?.patch == null ? (
                <p className="p-4 text-xs" style={{ color: "var(--muted)" }}>Binary or very large file: no text diff.</p>
              ) : (
                <pre className="min-w-max p-3 font-mono text-[12px] leading-5">
                  {current.patch
                    .split("\n")
                    .slice(2)
                    .map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.startsWith("+") && !line.startsWith("+++")
                            ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                            : line.startsWith("-") && !line.startsWith("---")
                              ? "bg-red-500/10 text-red-800 dark:text-red-300"
                              : line.startsWith("@@")
                                ? "text-sky-700 dark:text-sky-300"
                                : ""
                        }
                      >
                        {line || " "}
                      </div>
                    ))}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
