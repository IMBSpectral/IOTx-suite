"use client";

import { useEffect, useState } from "react";
import TipAnimation, { type TipTopic } from "./TipAnimation";
import { Loader2, Pause, Play, RefreshCw, TerminalSquare } from "lucide-react";

/** Things worth knowing while the preview boots, one at a time, each with a small animation. */
const TIPS: { topic: TipTopic; text: string }[] = [
  {
    topic: "select",
    text: "Select an element in the preview and describe a change for an instant quick edit.",
  },
  {
    topic: "chat",
    text: "Ask mode answers questions about your app without changing it.",
  },
  {
    topic: "connectors",
    text: "Connect Stripe, email and other services from + in the chat box, then Connectors.",
  },
  {
    topic: "annotate",
    text: "Draw on a screenshot you attach to show exactly what to change.",
  },
  {
    topic: "knowledge",
    text: "Add Knowledge (project rules and facts) and the agent follows it every turn.",
  },
  {
    topic: "mentions",
    text: "Type @ to point the agent at a file, a project or a collection.",
  },
  {
    topic: "responsive",
    text: "Switch the preview to Phone to check how your app looks on mobile.",
  },
  { topic: "secrets", text: "Keep API keys in Secrets, never in the code." },
  {
    topic: "security",
    text: "Run a security scan before you publish; a deep scan reviews all the code.",
  },
  { topic: "payments", text: "Add payments: ask for a Stripe checkout." },
  { topic: "skills", text: "Skills turn prompts you reuse into / commands." },
  {
    topic: "folders",
    text: "Organise projects into folders from the Projects page.",
  },
  {
    topic: "files",
    text: "The Files tab holds your uploads, images and documents in one place.",
  },
];

/** Live tail of the dev container's output. */
function Logs({ projectId }: { projectId: string }) {
  const [logs, setLogs] = useState("");
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/api/projects/${projectId}/sandbox?logs=1`)
        .then((r) => (r.ok ? r.json() : { logs: "" }))
        .then((d) => {
          if (live) setLogs(d.logs || "No output yet.");
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [projectId]);
  return (
    <pre
      className="mt-3 max-h-56 w-full overflow-auto rounded-lg border bg-black/[.03] p-3 text-left font-mono text-[11px]"
      aria-label="Build logs"
    >
      {logs}
    </pre>
  );
}

function LogsToggle({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="mt-4 inline-flex items-center gap-1 text-xs hover:underline"
        style={{ color: "var(--muted)" }}
      >
        <TerminalSquare className="h-3.5 w-3.5" />{" "}
        {open ? "Hide logs" : "View logs"}
      </button>
      {open && <Logs projectId={projectId} />}
    </>
  );
}

/** Narrated boot: what's happening now, plus a rotating tip. */
export function PreviewBooting({ projectId }: { projectId: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, []);
  const stage =
    elapsed < 6
      ? "Starting the dev server…"
      : elapsed < 30
        ? "Installing dependencies…"
        : "Compiling your app…";
  const tip = TIPS[Math.floor(elapsed / 7) % TIPS.length];
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="w-full max-w-md">
        <Loader2
          className="mx-auto h-5 w-5 animate-spin"
          style={{ color: "var(--muted)" }}
        />
        <p className="mt-3 text-sm font-medium" role="status">
          {stage}
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          The first boot takes a minute; after that the preview starts in
          seconds.
        </p>
        <div
          key={tip.topic}
          className="mx-auto mt-5 flex max-w-sm items-center gap-3 rounded-xl border px-3 py-3 text-left text-xs"
          style={{ background: "var(--panel)" }}
          aria-label="Tip"
        >
          <TipAnimation topic={tip.topic} />
          <p>
            <span className="font-medium">Tip · </span>
            {tip.text}
          </p>
        </div>
        <LogsToggle projectId={projectId} />
      </div>
    </div>
  );
}

export function PreviewPaused({ onResume }: { onResume: () => void }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div>
        <Pause className="mx-auto h-6 w-6" style={{ color: "var(--muted)" }} />
        <p className="mt-3 text-sm font-medium">
          We paused your preview while you were away.
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Idle previews are paused to save resources. Nothing in your project
          changed.
        </p>
        <button
          onClick={onResume}
          className="mt-4 rounded-lg px-3.5 py-1.5 text-sm font-medium text-white"
          style={{ background: "var(--accent)" }}
        >
          Keep building
        </button>
      </div>
    </div>
  );
}

export function PreviewStopped({ onStart }: { onStart: () => void }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div>
        <p className="text-sm font-medium">Start the preview to see your app</p>
        <button
          onClick={onStart}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium text-white"
          style={{ background: "var(--accent)" }}
        >
          <Play className="h-3.5 w-3.5" /> Start preview
        </button>
      </div>
    </div>
  );
}

export function PreviewCrashed({
  projectId,
  restarting,
  onRestart,
}: {
  projectId: string;
  restarting: boolean;
  onRestart: () => void;
}) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="w-full max-w-md">
        {restarting ? (
          <>
            <Loader2
              className="mx-auto h-5 w-5 animate-spin"
              style={{ color: "var(--muted)" }}
            />
            <p className="mt-3 text-sm font-medium" role="status">
              Your preview crashed — restarting…
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">Your preview crashed again</p>
            <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
              Check the logs, or ask the agent to fix what&apos;s failing.
            </p>
            <button
              onClick={onRestart}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Restart preview
            </button>
          </>
        )}
        <LogsToggle projectId={projectId} />
      </div>
    </div>
  );
}
