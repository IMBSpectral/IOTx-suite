"use client";

import { useState } from "react";
import { ChevronRight, RotateCcw, Wrench } from "lucide-react";
import type { Step } from "./types";

const LABEL: Record<string, string> = {
  write_file: "Wrote a file",
  delete_file: "Deleted a file",
  read_file: "Read a file",
  run_command: "Ran a command",
  generate_image: "Generated an image",
  query_database: "Queried the database",
  http_request: "Made a web request",
  connector_request: "Called a connector",
  mcp_call: "Called an MCP tool",
  create_visual: "Drew a visual",
  create_document: "Wrote a document",
};

/**
 * The turn's tool calls, each a card with its Input and Output, collapsed by
 * default. Calls that changed files carry a checkpoint: "Restore to here" puts
 * the project back exactly as it was right after that step.
 */
export default function ToolCalls({
  steps,
  projectId,
  canRestore = false,
}: {
  steps: Step[];
  projectId?: string;
  canRestore?: boolean;
}) {
  const calls = steps.filter(
    (s): s is Extract<Step, { kind: "call" }> => s.kind === "call",
  );
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function restore(sha: string, step: number) {
    if (
      !projectId ||
      !confirm(
        `Restore the project to how it was right after step ${step}? This is saved as a new version, so you can undo it.`,
      )
    )
      return;
    setRestoring(sha);
    setNote("");
    const res = await fetch(`/api/projects/${projectId}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha, checkpoint: true }),
    });
    const d = await res.json().catch(() => ({}));
    setRestoring(null);
    if (!res.ok) return setNote(d.error ?? "Couldn't restore.");
    // The preview and code follow the new version.
    window.location.reload();
  }
  if (!calls.length) return null;
  return (
    <div className="mt-2 text-[11px]">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 hover:underline"
        style={{ color: "var(--muted)" }}
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Wrench className="h-3 w-3" /> {calls.length} tool call
        {calls.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {calls.map((c, i) => (
            <li
              key={i}
              className="rounded-lg border"
              style={{ background: "var(--panel)" }}
            >
              <button
                onClick={() => setExpanded(expanded === i ? null : i)}
                aria-expanded={expanded === i}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
              >
                <ChevronRight
                  className={`h-3 w-3 shrink-0 transition-transform ${expanded === i ? "rotate-90" : ""}`}
                />
                <span className="font-medium">{LABEL[c.tool] ?? c.tool}</span>
                <code
                  className="min-w-0 flex-1 truncate"
                  style={{ color: "var(--muted)" }}
                >
                  {c.tool}
                </code>
                {c.failed && (
                  <span className="shrink-0 text-red-600">failed</span>
                )}
              </button>
              {expanded === i && (
                <div className="space-y-1.5 border-t px-2.5 py-2">
                  <div>
                    <p className="font-medium">Input</p>
                    <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/[.04] p-1.5 font-mono dark:bg-white/[.05]">
                      {c.input || "—"}
                    </pre>
                  </div>
                  <div>
                    <p className="font-medium">Output</p>
                    <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/[.04] p-1.5 font-mono dark:bg-white/[.05]">
                      {c.output || "—"}
                    </pre>
                  </div>
                  {canRestore && c.checkpoint && (
                    <button
                      onClick={() => void restore(c.checkpoint!, i + 1)}
                      disabled={restoring !== null}
                      title={`Checkpoint ${c.checkpoint.slice(0, 7)}`}
                      className="flex items-center gap-1 rounded-md border px-2 py-0.5 disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />{" "}
                      {restoring === c.checkpoint
                        ? "Restoring…"
                        : "Restore to here"}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p role="alert" className="mt-1 text-red-600">
          {note}
        </p>
      )}
    </div>
  );
}
