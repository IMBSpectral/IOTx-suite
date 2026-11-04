"use client";

import StressTest from "./StressTest";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { HealthFinding, HealthRun } from "@/lib/monitoring";
import type { FixQueued } from "./SecurityCenter";

type State = {
  on: boolean;
  frequency: "daily" | "weekly";
  ignored: string[];
  fixing: string[];
  latest: HealthRun | null;
  open: HealthFinding[];
  history: { at: string; trigger: string; count: number; error: string | null }[];
};

const SEV: Record<HealthFinding["severity"], { label: string; dot: string }> = {
  critical: { label: "Critical", dot: "#dc2626" },
  high: { label: "High", dot: "#ea580c" },
  medium: { label: "Medium", dot: "#ca8a04" },
  low: { label: "Low", dot: "#78716c" },
};

export function useHealth(projectId: string, version: number) {
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/monitoring`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setState(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, version]);
  return state;
}

/** Monitoring: activate scheduled health runs, read the brief, fix or ignore findings. */
export default function HealthPanel({ projectId, onFixQueued }: { projectId: string; onFixQueued: (f: FixQueued) => void }) {
  const [version, setVersion] = useState(0);
  const state = useHealth(projectId, version);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const muted = { color: "var(--muted)" };

  async function act(body: Record<string, unknown>, label = String(body.action)) {
    setBusy(label);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/monitoring`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) setError(d.error ?? "Something went wrong");
    else if (d.buildId) onFixQueued(d as FixQueued);
    setVersion((v) => v + 1);
  }

  if (!state) return <p className="p-4 text-sm" style={muted}>Loading…</p>;
  const ignoredFindings = state.latest?.findings.filter((f) => state.ignored.includes(f.key)) ?? [];

  return (
    <div className="h-full space-y-6 overflow-y-auto p-5">
      <section className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Project monitoring</h2>
            <p className="mt-0.5 text-xs" style={muted}>
              Spot issues before your users do: the live site, runtime errors, security, dependencies, SEO and
              performance are checked on a schedule, and you&apos;re notified about new problems.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs">
            <input
              type="checkbox"
              role="switch"
              aria-label="Activate monitoring"
              checked={state.on}
              onChange={(e) => act({ action: "configure", on: e.target.checked }, "configure")}
            />
            {state.on ? "On" : "Off"}
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5">
            Frequency
            <select
              value={state.frequency}
              onChange={(e) => act({ action: "configure", frequency: e.target.value }, "configure")}
              className="rounded-md border bg-transparent px-1.5 py-1"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <button
            onClick={() => act({ action: "run" })}
            disabled={!!busy}
            className="flex items-center gap-1 rounded-md border px-2.5 py-1 disabled:opacity-50"
          >
            {busy === "run" && <Loader2 className="h-3 w-3 animate-spin" />} Run checks now
          </button>
          <button
            onClick={() => act({ action: "seo" })}
            disabled={!!busy}
            className="flex items-center gap-1 rounded-md border px-2.5 py-1 disabled:opacity-50"
          >
            {busy === "seo" && <Loader2 className="h-3 w-3 animate-spin" />} SEO review
          </button>
          <span style={muted}>Checks are free; fixes use credits.</span>
        </div>
      </section>

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      <section aria-label="Health brief">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {state.latest ? `Brief · ${new Date(state.latest.at).toLocaleString()}` : "No runs yet"}
          </h3>
          {state.open.length > 1 && (
            <button
              onClick={() => act({ action: "fix", keys: state.open.filter((f) => !state.fixing.includes(f.key)).map((f) => f.key) }, "fix-all")}
              disabled={!!busy}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              Fix all
            </button>
          )}
        </div>
        {state.latest?.error && (
          <p className="mb-2 text-xs" style={muted}>
            Some checks didn&apos;t complete: {state.latest.error}
          </p>
        )}
        {state.latest && state.open.length === 0 && (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm" style={muted}>
            No open issues. Everything checked out.
          </p>
        )}
        <ul className="space-y-2">
          {state.open.map((f) => {
            const fixing = state.fixing.includes(f.key);
            const open = expanded === f.key;
            return (
              <li key={f.key} className="rounded-xl border px-3 py-2.5" style={{ background: "var(--panel)" }}>
                <div className="flex items-start justify-between gap-2">
                  <button
                    onClick={() => setExpanded(open ? null : f.key)}
                    aria-expanded={open}
                    className="flex min-w-0 items-start gap-2 text-left"
                  >
                    {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                    <span className="min-w-0">
                      <span className="block text-sm">{f.title}</span>
                      <span className="flex items-center gap-1.5 text-[11px]" style={muted}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: SEV[f.severity].dot }} aria-hidden />
                        {SEV[f.severity].label} · {f.category}
                      </span>
                    </span>
                  </button>
                  <span className="flex shrink-0 gap-1.5 text-xs">
                    {fixing ? (
                      <span style={muted}>This issue is already being fixed</span>
                    ) : (
                      <>
                        <button onClick={() => act({ action: "ignore", key: f.key }, "ignore")} className="rounded-md border px-2 py-1">
                          Ignore
                        </button>
                        <button
                          onClick={() => act({ action: "fix", keys: [f.key] }, `fix-${f.key}`)}
                          disabled={!!busy}
                          className="rounded-md px-2 py-1 font-medium text-white disabled:opacity-50"
                          style={{ background: "var(--accent)" }}
                        >
                          Fix
                        </button>
                      </>
                    )}
                  </span>
                </div>
                {open && (
                  <p className="mt-2 whitespace-pre-wrap break-words pl-5 text-xs" style={muted}>
                    {f.detail || "No more details."}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {ignoredFindings.length > 0 && (
        <section aria-label="Ignored findings">
          <h3 className="mb-2 text-sm font-medium">Ignored</h3>
          <ul className="divide-y rounded-xl border text-sm">
            {ignoredFindings.map((f) => (
              <li key={f.key} className="flex items-center justify-between px-3 py-2">
                <span className="truncate" style={muted}>
                  {f.title}
                </span>
                <button onClick={() => act({ action: "unignore", key: f.key }, "unignore")} className="text-xs hover:underline">
                  Undo ignore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.history.length > 0 && (
        <section aria-label="Run history">
          <h3 className="mb-2 text-sm font-medium">Run history</h3>
          <ul className="divide-y rounded-xl border text-xs">
            {state.history.map((h) => (
              <li key={h.at} className="flex items-center justify-between px-3 py-1.5">
                <span>{new Date(h.at).toLocaleString()}</span>
                <span style={muted}>
                  {h.trigger === "schedule" ? "Scheduled" : h.trigger === "seo" ? "SEO review" : "Manual"} · {h.count}{" "}
                  {h.count === 1 ? "finding" : "findings"}
                  {h.error ? " · incomplete" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <StressTest projectId={projectId} />
    </div>
  );
}
