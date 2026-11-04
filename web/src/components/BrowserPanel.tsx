"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type State = { state: "live" | "online" | "not in use"; url: string | null; controlledBy: "agent" | "user" | null };
type HistoryRow = { at: string; actor: string; action: string; detail: string };

/** The cloud browser, live: watch the agent, take over (it pauses), click and type, hand back. */
export default function BrowserPanel({ projectId }: { projectId: string }) {
  const base = `/api/projects/${projectId}/browser`;
  const [s, setS] = useState<State | null>(null);
  const [tick, setTick] = useState(0);
  const [url, setUrl] = useState("");
  const [typing, setTyping] = useState("");
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState("");
  const img = useRef<HTMLImageElement>(null);
  const muted = { color: "var(--muted)" };

  const load = useCallback(() => {
    fetch(base)
      .then((r) => r.json())
      .then(setS)
      .catch(() => undefined);
  }, [base]);
  useEffect(() => {
    load();
    const t = setInterval(() => {
      load();
      setTick((n) => n + 1);
    }, 1500);
    return () => clearInterval(t);
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setError("");
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error ?? "That didn't work");
    load();
    setTick((n) => n + 1);
  }

  if (!s) return null;
  const mine = s.controlledBy === "user";
  const label = s.state === "live" ? "Live: the agent is working" : s.state === "online" ? "Online" : "Not in use";
  return (
    <div className="flex h-full flex-col gap-2 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 ${s.state === "live" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-black/[.06] dark:bg-white/[.08]"}`}>{label}</span>
        {s.url && (
          <span className="min-w-0 flex-1 truncate font-mono" style={muted}>
            {s.url}
          </span>
        )}
        {s.state !== "not in use" &&
          (mine ? (
            <button onClick={() => void post({ action: "handback" })} className="rounded-md px-2.5 py-1 font-medium text-white" style={{ background: "var(--accent)" }}>
              Hand back to the agent
            </button>
          ) : (
            <button onClick={() => void post({ action: "takeover" })} className="rounded-md border px-2.5 py-1">
              Take over
            </button>
          ))}
        {s.state !== "not in use" && (
          <button onClick={() => void post({ action: "close" })} className="rounded-md border px-2.5 py-1">
            Close
          </button>
        )}
        <button onClick={() => fetch(`${base}?history=1`).then((r) => r.json()).then((d) => setHistory(d.history))} className="rounded-md border px-2.5 py-1">
          History
        </button>
      </div>
      {mine && (
        <p className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-400" role="status">
          You have control. The agent is paused until you hand it back.
        </p>
      )}
      {error && (
        <p className="text-red-500" role="alert">
          {error}
        </p>
      )}
      {s.state === "not in use" ? (
        <div className="grid flex-1 place-items-center rounded-lg border border-dashed text-center" style={muted}>
          <div className="space-y-2">
            <p>The agent opens a browser here when it needs one, like “check our pricing page on example.com”.</p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void post({ action: "open", url }).then(() => post({ action: "takeover" }));
              }}
            >
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Open a site yourself" aria-label="Address" className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1" />
              <button className="rounded-md border px-2 py-1">Open</button>
            </form>
          </div>
        </div>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={img}
            src={`${base}?shot=1&t=${tick}`}
            alt="The cloud browser"
            className={`w-full rounded-lg border ${mine ? "cursor-pointer" : ""}`}
            onClick={(e) => {
              if (!mine || !img.current) return;
              const r = img.current.getBoundingClientRect();
              // The page is 1280 wide; the image is scaled to fit.
              const scale = 1280 / r.width;
              void post({ action: "click", x: Math.round((e.clientX - r.left) * scale), y: Math.round((e.clientY - r.top) * scale) });
            }}
          />
          {mine && (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void post({ action: "type", text: typing }).then(() => setTyping(""));
              }}
            >
              <input value={typing} onChange={(e) => setTyping(e.target.value)} placeholder="Type or paste into the focused field" aria-label="Text to type" className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1" />
              <button className="rounded-md border px-2 py-1">Type</button>
              <button type="button" onClick={() => void post({ action: "press", key: "Enter" })} className="rounded-md border px-2 py-1">
                Enter
              </button>
              <button type="button" onClick={() => void post({ action: "scroll", dy: 500 })} className="rounded-md border px-2 py-1">
                Scroll
              </button>
            </form>
          )}
        </>
      )}
      {history && (
        <ul className="max-h-48 divide-y overflow-auto rounded-lg border">
          {history.map((h, i) => (
            <li key={i} className="px-2 py-1">
              <span className="font-medium">{h.actor}</span> {h.action} <span style={muted}>{h.detail} · {new Date(h.at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
