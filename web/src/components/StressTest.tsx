"use client";

import { useState } from "react";
import { Gauge } from "lucide-react";
import type { StressResult } from "@/lib/stress";

/** Health → Stress test: load the published app for a few seconds and see how it holds up. */
export default function StressTest({ projectId }: { projectId: string }) {
  const [path, setPath] = useState("/");
  const [concurrency, setConcurrency] = useState(10);
  const [seconds, setSeconds] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StressResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/stress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, concurrency, seconds }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(d.error ?? "The test couldn't run.");
    setResult(d.result);
  }

  const muted = { color: "var(--muted)" };
  return (
    <section aria-label="Stress test" className="rounded-xl border p-4 text-xs" style={{ background: "var(--panel)" }}>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Gauge className="h-4 w-4" /> Stress test
      </p>
      <p className="mt-1" style={muted}>
        Send many requests to your published app at once and see response times and errors. Only your own published site can be tested.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          Path
          <input value={path} onChange={(e) => setPath(e.target.value)} className="w-32 rounded-md border bg-transparent px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          At once
          <input type="number" min={1} max={50} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="w-20 rounded-md border bg-transparent px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          Seconds
          <input type="number" min={1} max={30} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="w-20 rounded-md border bg-transparent px-2 py-1" />
        </label>
        <button onClick={run} disabled={busy} className="btn-primary rounded-lg px-3 py-1.5 disabled:opacity-50">
          {busy ? `Running for ${seconds}s…` : "Run stress test"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-red-600">
          {error}
        </p>
      )}
      {result && (
        <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Stress test results">
          {(
            [
              ["Requests", `${result.requests} (${result.rps}/s)`],
              ["Errors", `${result.errors}${result.requests ? ` (${Math.round((result.errors / result.requests) * 100)}%)` : ""}`],
              ["Median", `${result.latencyMs.p50} ms`],
              ["p90 / p99", `${result.latencyMs.p90} / ${result.latencyMs.p99} ms`],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-lg border px-2.5 py-2">
              <dt style={muted}>{k}</dt>
              <dd className="mt-0.5 text-sm font-medium tabular-nums">{v}</dd>
            </div>
          ))}
          <p className="col-span-full" style={muted}>
            {result.url} · {result.concurrency} at once for {result.seconds}s · status codes {Object.entries(result.statuses).map(([s, n]) => `${s}×${n}`).join(", ")}
          </p>
        </dl>
      )}
    </section>
  );
}
