"use client";

import { useEffect, useRef, useState } from "react";
import { useEscape } from "./useEscape";
import { Loader2, Undo2, X, Zap } from "lucide-react";

type Selected = { selector: string; path: string; text: string };
type Phase =
  | { kind: "idle" }
  | { kind: "working"; step: "Reading the source…" | "Writing the change…" }
  | { kind: "done"; file: string }
  | { kind: "broke"; file: string }
  | { kind: "fallback"; code: string; message: string };

/**
 * Quick edit: describe a change to the selected element and it is applied
 * straight away, without an agent turn. When it can't be done that way the
 * bar says why and offers to hand the request to the agent instead.
 */
export function QuickEditBar({
  projectId,
  selected,
  runtimeError,
  onAskAgent,
  onClose,
  onOpenCode,
}: {
  projectId: string;
  selected: Selected;
  /** Changes when the preview reports a new runtime error. */
  runtimeError: string | null;
  onAskAgent: (instruction: string) => void;
  onClose: () => void;
  /** Opens the element's source file at a line. */
  onOpenCode?: (file: string, line: number) => void;
}) {
  const [instruction, setInstruction] = useState("");
  useEscape(onClose);
  const [locating, setLocating] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const appliedAt = useRef<{ at: number; error: string | null } | null>(null);
  const muted = { color: "var(--muted)" };

  // A new runtime error shortly after a quick edit means the edit broke the preview.
  useEffect(() => {
    const a = appliedAt.current;
    if (!a || phase.kind !== "done" || !runtimeError || runtimeError === a.error) return;
    if (Date.now() - a.at > 10_000) return;
    const file = phase.file;
    const t = setTimeout(() => setPhase({ kind: "broke", file }), 0);
    return () => clearTimeout(t);
  }, [runtimeError, phase]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/projects/${projectId}/quick-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, d: await res.json().catch(() => ({})) };
  }

  async function run() {
    const text = instruction.trim();
    if (!text) return;
    setPhase({ kind: "working", step: "Reading the source…" });
    // The request is one call; the second label reflects the write phase.
    const t = setTimeout(() => setPhase({ kind: "working", step: "Writing the change…" }), 1500);
    const { ok, d } = await post({ action: "edit", instruction: text, selector: selected.selector, text: selected.text });
    clearTimeout(t);
    if (!ok) {
      setPhase({ kind: "fallback", code: d.code ?? "error", message: d.error ?? "Something went wrong." });
      return;
    }
    appliedAt.current = { at: Date.now(), error: runtimeError };
    setPhase({ kind: "done", file: d.file });
  }

  async function undo() {
    setPhase({ kind: "working", step: "Writing the change…" });
    const { ok, d } = await post({ action: "undo" });
    if (!ok) setPhase({ kind: "fallback", code: "error", message: d.error ?? "Couldn't undo." });
    else {
      setPhase({ kind: "idle" });
      setInstruction("");
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Quick edit"
      // Sits above the floating preview toolbar.
      className="absolute bottom-16 left-1/2 z-30 w-[min(520px,calc(100%-2rem))] -translate-x-1/2 rounded-xl border p-3 shadow-xl"
      style={{ background: "var(--panel)" }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px]" style={muted}>
          {selected.selector}
          {selected.text ? ` · “${selected.text.slice(0, 40)}”` : ""}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => onAskAgent("Delete this element from the page, and anything that only existed to support it (handlers, styles, imports).")}
            className="rounded-md px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-500/[.08]"
            title="Remove this element"
          >
            Delete
          </button>
          {onOpenCode && (
            <button
              onClick={async () => {
                setLocating("Finding…");
                const { ok, d } = await post({ action: "locate", selector: selected.selector, text: selected.text });
                if (ok) {
                  setLocating(null);
                  onOpenCode(d.file, d.line);
                } else setLocating(d.error ?? "Not found in the code");
              }}
              className="rounded-md px-1.5 py-0.5 text-[11px] hover:bg-black/[.05]"
              style={muted}
            >
              {locating ?? "Open in code"}
            </button>
          )}
          <button onClick={onClose} aria-label="Close quick edit" className="rounded p-0.5 hover:bg-black/[.05]">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {(phase.kind === "idle" || phase.kind === "fallback") && (
        <div className="flex gap-1.5">
          <input
            autoFocus
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
            placeholder="Describe a change"
            aria-label="Describe a change"
            className="min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          />
          <button
            onClick={run}
            disabled={!instruction.trim()}
            title="Apply instantly, without an agent turn (1 credit)"
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            <Zap className="h-3.5 w-3.5" /> Quick edit
          </button>
          <button
            onClick={() => instruction.trim() && onAskAgent(instruction.trim())}
            disabled={!instruction.trim()}
            className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-40"
          >
            Ask the agent
          </button>
        </div>
      )}

      {phase.kind === "working" && (
        <p className="flex items-center gap-2 text-sm" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {phase.step}
        </p>
      )}

      {phase.kind === "fallback" && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs" role="alert">
          <span style={muted}>
            {phase.code === "needs_agent" ? "This needs the agent. " : ""}
            {phase.message}
          </span>
          {(phase.code === "needs_agent" || phase.code === "no_source") && (
            <button
              onClick={() => onAskAgent(instruction.trim())}
              className="shrink-0 rounded-md px-2 py-1 font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              Send to agent
            </button>
          )}
        </div>
      )}

      {phase.kind === "done" && (
        <div className="flex items-center justify-between gap-2 text-xs" role="status">
          <span>
            Changed <span className="font-mono">{phase.file}</span>
          </span>
          <span className="flex gap-1.5">
            <button onClick={undo} className="flex items-center gap-1 rounded-md border px-2 py-1">
              <Undo2 className="h-3 w-3" /> Undo last quick edit
            </button>
            <button
              onClick={() => {
                setPhase({ kind: "idle" });
                setInstruction("");
              }}
              className="rounded-md border px-2 py-1"
            >
              Another edit
            </button>
          </span>
        </div>
      )}

      {phase.kind === "broke" && (
        <div className="flex items-center justify-between gap-2 text-xs" role="alert">
          <span className="text-red-600">This broke the preview.</span>
          <span className="flex gap-1.5">
            <button onClick={() => setPhase({ kind: "done", file: phase.file })} className="rounded-md border px-2 py-1">
              Keep
            </button>
            <button
              onClick={undo}
              className="rounded-md px-2 py-1 font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              Discard
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export type TextChange = { oldText: string; newText: string; selector: string };

/** Text typed straight into the preview, waiting to be written to source in one go. */
export function PendingTextBar({
  projectId,
  changes,
  onSent,
  onDiscard,
}: {
  projectId: string;
  changes: TextChange[];
  onSent: () => void;
  onDiscard: () => void;
}) {
  const [state, setState] = useState<{ kind: "idle" | "sending" | "error"; text?: string }>({ kind: "idle" });
  const [open, setOpen] = useState(false);

  async function send() {
    setState({ kind: "sending" });
    const res = await fetch(`/api/projects/${projectId}/quick-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "text", changes }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setState({ kind: "error", text: d.error ?? "Couldn't send the changes." });
    if (d.failed?.length) {
      setState({
        kind: "error",
        text: `${d.applied} saved. ${d.failed.length} couldn't be placed: ${d.failed.map((f: { oldText: string; reason: string }) => `“${f.oldText.slice(0, 30)}” (${f.reason})`).join("; ")}`,
      });
    } else setState({ kind: "idle" });
    onSent();
  }

  return (
    <div
      role="region"
      aria-label="Pending changes"
      className="absolute left-1/2 top-3 z-20 w-[min(480px,calc(100%-2rem))] -translate-x-1/2 rounded-xl border px-3 py-2 text-xs shadow-lg"
      style={{ background: "var(--panel)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="font-medium">
          Text changes ({changes.length})
        </button>
        <span className="flex gap-1.5">
          <button onClick={onDiscard} className="rounded-md border px-2 py-1">
            Discard
          </button>
          <button
            onClick={send}
            disabled={state.kind === "sending"}
            className="rounded-md px-2 py-1 font-medium text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {state.kind === "sending" ? "Sending changes…" : "Send changes"}
          </button>
        </span>
      </div>
      {open && (
        <ul className="mt-2 space-y-1">
          {changes.map((c, i) => (
            <li key={i} className="truncate">
              <span className="line-through opacity-60">{c.oldText.slice(0, 40)}</span> → {c.newText.slice(0, 40)}
            </li>
          ))}
        </ul>
      )}
      {state.kind === "error" && (
        <p className="mt-1.5 text-red-600" role="alert">
          {state.text}
        </p>
      )}
    </div>
  );
}
