"use client";

import { useEffect, useState } from "react";
import { Database, KeyRound } from "lucide-react";
import { useBrand } from "@/components/BrandProvider";
import type { Step } from "./types";

type Migration = { id: string; description: string; sql: string; status: string; error: string | null };

/**
 * Approval cards for Forge Cloud, under the agent's latest reply: turn Cloud
 * on, approve or reject a migration, add a secret. Approving tells the agent
 * to continue.
 */
export default function CloudCards({
  projectId,
  steps,
  onContinue,
}: {
  projectId: string;
  steps: Step[];
  onContinue: (text: string) => void;
}) {
  const brand = useBrand();
  const CLOUD = `${brand.shortName} Cloud`;
  const cloud = steps.find((s) => s.kind === "cloud");
  const migrations = steps.filter((s): s is Extract<Step, { kind: "migration" }> => s.kind === "migration");
  const secrets = steps.filter((s): s is Extract<Step, { kind: "secret" }> => s.kind === "secret");
  const [state, setState] = useState<{ enabled: boolean; migrations: Migration[]; secrets: string[] } | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const relevant = !!cloud || migrations.length > 0 || secrets.length > 0;

  useEffect(() => {
    if (!relevant) return;
    let live = true;
    fetch(`/api/projects/${projectId}/cloud`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setState({
          enabled: d.enabled,
          migrations: d.migrations ?? [],
          secrets: (d.secrets ?? []).map((x: { name: string }) => x.name),
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, relevant, version]);

  if (!relevant || !state) return null;

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/cloud`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    setVersion((v) => v + 1);
    if (!res.ok) {
      setError(d.error ?? "Something went wrong");
      return false;
    }
    return true;
  }

  const card = "mt-3 rounded-xl border p-3 text-sm";
  const muted = { color: "var(--muted)" };

  return (
    <div>
      {cloud?.kind === "cloud" && (
        <div className={card} style={{ background: "var(--panel)" }}>
          <p className="flex items-center gap-1.5 font-medium">
            <Database className="h-4 w-4" /> {cloud.auto ? `${CLOUD} is on for this app` : `Approve ${CLOUD} to continue building your app`}
          </p>
          <p className="mt-1 text-xs" style={muted}>
            {cloud.detail} Cloud adds a database, sign-in for your app&apos;s users and secure storage for API keys.
          </p>
          {state.enabled ? (
            <p className="mt-2 text-xs font-medium text-emerald-600">{CLOUD} is on.</p>
          ) : (
            <button
              disabled={!!busy}
              onClick={async () => {
                if (await act("enable", { action: "enable" })) onContinue(`I enabled ${CLOUD}. Continue building.`);
              }}
              className="mt-2 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {busy === "enable" ? "Enabling…" : "Approve and enable Cloud"}
            </button>
          )}
        </div>
      )}

      {migrations.map((m) => {
        const row = state.migrations.find((x) => x.id === m.id);
        const status = row?.status ?? "pending";
        return (
          <div key={m.id} className={card} style={{ background: "var(--panel)" }}>
            <p className="flex items-center gap-1.5 font-medium">
              <Database className="h-4 w-4" /> {status === "pending" ? "Waiting for user to approve migration" : `Migration ${status}`}
            </p>
            <p className="mt-1 text-xs" style={muted}>
              {m.detail}
            </p>
            {row && (
              <button onClick={() => setShowSql(showSql === m.id ? null : m.id)} className="mt-1 text-xs hover:underline" style={muted}>
                {showSql === m.id ? "Hide SQL" : "Review SQL"}
              </button>
            )}
            {showSql === m.id && row && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg border p-2 font-mono text-[11px]">{row.sql}</pre>
            )}
            {row?.error && <p className="mt-1 text-xs text-red-600">{row.error}</p>}
            {status === "pending" && (
              <div className="mt-2 flex gap-1.5">
                <button
                  disabled={!!busy}
                  onClick={async () => {
                    const ok = await act(`approve-${m.id}`, { action: "approve", id: m.id });
                    onContinue(
                      ok
                        ? `I approved the migration "${m.detail}". Continue building.`
                        : `The migration "${m.detail}" failed. Look at the error and propose a fixed one.`,
                    );
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  {busy === `approve-${m.id}` ? "Applying…" : "Approve"}
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => act(`reject-${m.id}`, { action: "reject", id: m.id })}
                  className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        );
      })}

      {secrets.map((s) => {
        const stored = state.secrets.includes(s.name);
        return (
          <div key={s.name} className={card} style={{ background: "var(--panel)" }}>
            <p className="flex items-center gap-1.5 font-medium">
              <KeyRound className="h-4 w-4" /> Add {s.name}
            </p>
            <p className="mt-1 text-xs" style={muted}>
              {s.detail} Stored encrypted in {CLOUD} Secrets; the agent never sees the value.
            </p>
            {stored ? (
              <p className="mt-2 text-xs font-medium text-emerald-600">Saved.</p>
            ) : (
              <div className="mt-2 flex gap-1.5">
                <input
                  type="password"
                  autoComplete="off"
                  value={values[s.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [s.name]: e.target.value })}
                  placeholder={s.name}
                  aria-label={`Value for ${s.name}`}
                  className="min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none"
                />
                <button
                  disabled={!!busy || !values[s.name]}
                  onClick={async () => {
                    if (await act(`secret-${s.name}`, { action: "setSecret", name: s.name, value: values[s.name] })) {
                      setValues({ ...values, [s.name]: "" });
                      onContinue(`I added ${s.name}. Continue building.`);
                    }
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  style={{ background: "var(--accent)" }}
                >
                  Save secret
                </button>
              </div>
            )}
          </div>
        );
      })}

      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
