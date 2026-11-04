"use client";

import { useState } from "react";
import { diffLines } from "diff";
import { GitCompare } from "lucide-react";

/** "What changed since v(n-1)": a revised plan compared line by line with the previous one. */
export default function PlanChanges({ previous, current, version }: { previous: string; current: string; version: number }) {
  const [open, setOpen] = useState(false);
  const parts = open ? diffLines(previous, current) : [];
  return (
    <div className="mt-2 text-[11px]">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1 hover:underline" style={{ color: "var(--muted)" }}>
        <GitCompare className="h-3 w-3" /> Plan v{version} · {open ? "hide" : "compare with"} v{version - 1}
      </button>
      {open && (
        <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border p-2 font-mono text-[11px] leading-5">
          {parts.map((p, i) => (
            <span
              key={i}
              className={p.added ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : p.removed ? "bg-red-500/10 text-red-800 line-through dark:text-red-300" : ""}
              style={p.added || p.removed ? undefined : { color: "var(--muted)" }}
            >
              {p.value}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
