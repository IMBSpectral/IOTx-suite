"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Approval = { id: string; type: "access" | "publish" | "role" | "connector"; projectId: string; project: string; by: string; detail: string; at: string };
type Anomaly = { id: string; projectId: string; project: string; title: string; detail: string; at: string };
type Sec = { projectId: string; project: string; critical: number; high: number; medium: number; low: number };

/** The admin action center: approvals, anomalies to acknowledge, and security by project. */
export default function ActionCenter() {
  const [data, setData] = useState<{ approvals: Approval[]; anomalies: Anomaly[]; security: Sec[] } | null>(null);
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };

  const load = useCallback(() => {
    fetch("/api/workspace/action-center")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Only workspace owners and admins can see the action center.");
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function decide(a: Approval, decision: "approve" | "decline") {
    setError("");
    if (a.type === "role") {
      const r = await fetch("/api/workspace/members-extra", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "decideRole", id: a.id, approve: decision === "approve" }) });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "That didn't work");
      return load();
    }
    if (a.type === "connector") {
      const r = await fetch("/api/workspace/action-center", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "decideConnector", id: a.id, approve: decision === "approve" }) });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "That didn't work");
      return load();
    }
    const r = await fetch(`/api/projects/${a.projectId}/access-requests`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: a.id, decision }) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "That didn't work");
    load();
  }

  async function ack(id: string) {
    await fetch("/api/workspace/action-center", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "acknowledge", id }) });
    load();
  }

  if (error)
    return (
      <p className="text-sm text-red-500" role="alert">
        {error}
      </p>
    );
  if (!data) return null;
  const card = "divide-y rounded-xl border text-sm";

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          Approval requests <span style={muted}>({data.approvals.length})</span>
        </h2>
        <ul className={card}>
          {data.approvals.length === 0 && (
            <li className="px-4 py-3" style={muted}>
              Nothing waiting.
            </li>
          )}
          {data.approvals.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{a.by}</span> {a.detail}{" "}
                {a.projectId && (
                  <Link href={`/projects/${a.projectId}`} className="underline">
                    {a.project}
                  </Link>
                )}
                <span className="block text-xs" style={muted}>
                  {new Date(a.at).toLocaleString()}
                </span>
              </span>
              {a.type !== "publish" ? (
                <>
                  <button onClick={() => void decide(a, "decline")} className="rounded-lg border px-2.5 py-1 text-xs">
                    Decline
                  </button>
                  <button onClick={() => void decide(a, "approve")} className="rounded-lg px-2.5 py-1 text-xs font-medium text-white" style={{ background: "var(--accent)" }}>
                    Approve
                  </button>
                </>
              ) : (
                <Link href={`/projects/${a.projectId}`} className="rounded-lg border px-2.5 py-1 text-xs">
                  Review and publish
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          Anomalies <span style={muted}>({data.anomalies.length})</span>
        </h2>
        <ul className={card}>
          {data.anomalies.length === 0 && (
            <li className="px-4 py-3" style={muted}>
              Nothing unusual.
            </li>
          )}
          {data.anomalies.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{a.title}</span>
                {a.projectId && (
                  <>
                    {" · "}
                    <Link href={`/projects/${a.projectId}`} className="underline">
                      {a.project}
                    </Link>
                  </>
                )}
                <span className="block text-xs" style={muted}>
                  {a.detail} {new Date(a.at).toLocaleString()}
                </span>
              </span>
              <button onClick={() => void ack(a.id)} className="rounded-lg border px-2.5 py-1 text-xs">
                Acknowledge
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Security by project</h2>
        {data.security.length === 0 ? (
          <p className="rounded-xl border px-4 py-3 text-sm" style={muted}>
            No open findings.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-xs">
              <thead style={muted}>
                <tr>
                  <th className="px-3 py-2 text-left font-normal">Project</th>
                  <th className="px-3 py-2 text-right font-normal">Critical</th>
                  <th className="px-3 py-2 text-right font-normal">High</th>
                  <th className="px-3 py-2 text-right font-normal">Medium</th>
                  <th className="px-3 py-2 text-right font-normal">Low</th>
                </tr>
              </thead>
              <tbody>
                {data.security.map((s) => (
                  <tr key={s.projectId} className="border-t">
                    <td className="px-3 py-2">
                      <Link href={`/projects/${s.projectId}`} className="font-medium hover:underline">
                        {s.project}
                      </Link>
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${s.critical ? "font-semibold text-red-500" : ""}`}>{s.critical}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${s.high ? "text-amber-600" : ""}`}>{s.high}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.medium}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.low}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
