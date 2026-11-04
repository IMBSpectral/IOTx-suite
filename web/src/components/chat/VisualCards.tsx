"use client";

import { useState, useSyncExternalStore } from "react";
import { useEscape } from "../useEscape";
import { Maximize2, Shapes, X } from "lucide-react";
import type { Step } from "./types";

function subscribe(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  window.addEventListener("forge-theme-change", cb);
  return () => {
    mq.removeEventListener("change", cb);
    window.removeEventListener("forge-theme-change", cb);
  };
}
const darkNow = () =>
  document.documentElement.dataset.theme === "dark" ||
  (!document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);

/** Visual explanations the agent drew in this reply, shown as cards that open full size. */
export default function VisualCards({ projectId, steps }: { projectId: string; steps: Step[] }) {
  const visuals = steps.filter((s): s is Extract<Step, { kind: "visual" }> => s.kind === "visual");
  const dark = useSyncExternalStore(subscribe, darkNow, () => false);
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);
  useEscape(open ? () => setOpen(null) : null);
  if (!visuals.length) return null;
  const src = (id: string) => `/api/projects/${projectId}/visuals/${id}?theme=${dark ? "dark" : "light"}`;
  return (
    <>
      {visuals.map((v) => (
        <figure key={v.id} className="mt-2 overflow-hidden rounded-xl border" style={{ background: "var(--panel)" }}>
          <figcaption className="flex h-9 items-center justify-between border-b px-3 text-[12px]">
            <span className="flex min-w-0 items-center gap-1.5 font-medium">
              <Shapes className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent)" }} />
              <span className="truncate">{v.detail || "Visual explanation"}</span>
            </span>
            <button
              onClick={() => setOpen({ id: v.id, title: v.detail })}
              aria-label="Open visual full size"
              className="rounded p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </figcaption>
          <iframe src={src(v.id)} title={v.detail || "Visual explanation"} sandbox="allow-scripts" loading="lazy" className="block h-64 w-full" />
        </figure>
      ))}
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onClick={() => setOpen(null)} role="dialog" aria-label={open.title}>
          <div className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border shadow-2xl" style={{ background: "var(--panel)" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex h-11 items-center justify-between border-b px-4 text-sm font-medium">
              {open.title}
              <button onClick={() => setOpen(null)} aria-label="Close" className="rounded p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <iframe src={src(open.id)} title={open.title} sandbox="allow-scripts" className="min-h-0 flex-1" />
          </div>
        </div>
      )}
    </>
  );
}
