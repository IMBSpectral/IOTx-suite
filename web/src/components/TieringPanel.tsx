"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type App = { id: string; name: string; labels: string[]; published: boolean; cloud: boolean; visits30d: number; tier: string | null };

const EXAMPLE = `tiers:
  - name: Critical
    rules:
      - published: true
        labels: [customer-facing]
  - name: Standard
    rules:
      - published: true
  - name: Sandbox
    default: true
`;

/** App tiering: YAML rules that place apps in tiers, and admin labels on projects. */
export default function TieringPanel() {
  const [data, setData] = useState<{ yaml: string; tiers: string[]; apps: App[] } | null>(null);
  const [yaml, setYaml] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const muted = { color: "var(--muted)" };

  const apply = (d: { yaml: string; tiers: string[]; apps: App[] }) => {
    setData(d);
    setYaml(d.yaml);
    setLabels(Object.fromEntries(d.apps.map((a) => [a.id, a.labels.join(", ")])));
  };
  const load = useCallback(() => {
    fetch("/api/workspace/tiering")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Only workspace owners and admins can manage tiers.");
        apply(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function post(body: Record<string, unknown>, msg: string) {
    setError("");
    setNote("");
    const r = await fetch("/api/workspace/tiering", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "That didn't work");
    setNote(msg);
    if (d.apps) apply(d);
    else load();
  }

  return (
    <div className="space-y-5 text-sm">
      <div>
        <h2 className="text-base font-semibold">App tiers</h2>
        <p className="mt-1" style={muted}>
          Sort the workspace&apos;s apps into tiers with rules: published, cloud, labels (any of), nameContains,
          visitsAtLeast. The first tier with a matching rule wins; a default tier takes the rest.
        </p>
      </div>
      {(note || error) && (
        <p className={error ? "text-red-500" : "text-emerald-600"} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      {data && (
        <>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void post({ action: "rules", yaml }, "Tiers saved.");
            }}
          >
            <textarea value={yaml} onChange={(e) => setYaml(e.target.value)} rows={12} spellCheck={false} aria-label="Tier rules (YAML)" placeholder={EXAMPLE} className="w-full rounded-xl border bg-transparent p-3 font-mono text-xs" />
            <div className="flex justify-end gap-2">
              {!yaml && (
                <button type="button" onClick={() => setYaml(EXAMPLE)} className="rounded-lg border px-3 py-1.5 text-xs">
                  Start from an example
                </button>
              )}
              <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: "var(--accent)" }}>
                Save tiers
              </button>
            </div>
          </form>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-xs">
              <thead style={muted}>
                <tr>
                  <th className="px-3 py-2 text-left font-normal">App</th>
                  <th className="px-3 py-2 text-left font-normal">Tier</th>
                  <th className="px-3 py-2 text-left font-normal">Admin labels</th>
                </tr>
              </thead>
              <tbody>
                {data.apps.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="px-3 py-2">
                      <Link href={`/projects/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                      <span className="block" style={muted}>
                        {a.published ? "Live" : "Not published"}
                        {a.cloud ? " · Cloud" : ""} · {a.visits30d} visits
                      </span>
                    </td>
                    <td className="px-3 py-2">{a.tier ?? <span style={muted}>—</span>}</td>
                    <td className="px-3 py-2">
                      <form
                        className="flex gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void post({ action: "labels", projectId: a.id, labels: (labels[a.id] ?? "").split(",") }, `Labels saved for ${a.name}.`);
                        }}
                      >
                        <input value={labels[a.id] ?? ""} onChange={(e) => setLabels({ ...labels, [a.id]: e.target.value })} placeholder="e.g. customer-facing" aria-label={`Labels for ${a.name}`} className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1" />
                        <button className="rounded-md border px-2 py-1">Save</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
