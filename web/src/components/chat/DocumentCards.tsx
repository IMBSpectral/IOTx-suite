"use client";

import { FileText } from "lucide-react";
import type { Step } from "./types";

/** Documents the agent wrote in this reply; opening one shows it in the Artifacts tab. */
export default function DocumentCards({ steps }: { steps: Step[] }) {
  const docs = steps.filter((s): s is Extract<Step, { kind: "document" }> => s.kind === "document");
  if (!docs.length) return null;
  return (
    <>
      {docs.map((d) => (
        <button
          key={d.id}
          onClick={() => window.dispatchEvent(new CustomEvent("forge:open-artifact", { detail: d.id }))}
          className="mt-2 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left hover:bg-black/[.03] dark:hover:bg-white/[.04]"
          style={{ background: "var(--panel)" }}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: "var(--accent-soft)" }}>
            <FileText className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-[11px]" style={{ color: "var(--muted)" }}>Document</span>
            <span className="block truncate text-sm font-medium">{d.detail || "Document"}</span>
          </span>
          <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>Open</span>
        </button>
      ))}
    </>
  );
}
