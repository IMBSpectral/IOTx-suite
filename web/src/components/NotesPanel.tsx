"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown notes for the project, saved as you type. */
export default function NotesPanel({ projectId, readOnly = false }: { projectId: string; readOnly?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [view, setView] = useState<"write" | "preview">("write");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = `/api/projects/${projectId}/notes`;

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setText(d.text);
        if (d.text) setView("preview");
      });
    return () => {
      live = false;
    };
  }, [base]);

  function change(next: string) {
    setText(next);
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const res = await fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: next }) });
      setStatus(res.ok ? "saved" : "error");
    }, 700);
  }

  if (text === null) return <p className="p-5 text-sm" style={{ color: "var(--muted)" }}>Loading…</p>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-4 text-xs">
        <div className="flex gap-0.5" role="tablist" aria-label="Notes view">
          {(["write", "preview"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`rounded-md px-2 py-1 capitalize ${view === v ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
            >
              {v}
            </button>
          ))}
        </div>
        <span style={{ color: status === "error" ? "#dc2626" : "var(--muted)" }}>
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? "Couldn't save" : "Only people on this project see these notes"}
        </span>
      </div>
      {view === "write" ? (
        <textarea
          value={text}
          onChange={(e) => change(e.target.value)}
          readOnly={readOnly}
          placeholder="Write notes for this project... Markdown works: # headings, - lists, [links](https://…)"
          aria-label="Project notes"
          className="min-h-0 flex-1 resize-none bg-transparent p-5 font-mono text-[13px] leading-relaxed outline-none"
        />
      ) : (
        <div className="prose-chat min-h-0 flex-1 overflow-y-auto p-5 text-sm">
          {text.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          ) : (
            <p style={{ color: "var(--muted)" }}>No notes yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
