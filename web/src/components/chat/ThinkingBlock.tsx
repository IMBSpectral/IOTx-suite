"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Brain, ChevronRight } from "lucide-react";
import type { Step } from "./types";

/** "Thought for 12s": the agent's summarized reasoning for this turn, collapsed by default. */
export default function ThinkingBlock({ steps }: { steps: Step[] }) {
  const t = steps.find((s): s is Extract<Step, { kind: "thinking" }> => s.kind === "thinking");
  const [open, setOpen] = useState(false);
  if (!t) return null;
  const secs = Math.max(1, Math.round(t.ms / 1000));
  return (
    <div className="mb-2 text-[12px]">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!t.text}
        className="flex items-center gap-1 hover:underline disabled:no-underline"
        style={{ color: "var(--muted)" }}
      >
        {t.text && <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />}
        <Brain className="h-3 w-3" /> Thought for {secs}s
      </button>
      {open && t.text && (
        <div className="prose-chat mt-1.5 border-l-2 pl-3 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
          <ReactMarkdown>{t.text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
