"use client";

import { useState } from "react";
import { Check, Megaphone, X } from "lucide-react";
import type { Changeset } from "@/lib/marketing";

const LABELS: Record<string, string> = {
  name: "Name",
  headlines: "Headlines",
  descriptions: "Descriptions",
  keywords: "Keywords",
  markets: "Markets",
  languages: "Languages",
  dailyBudget: "Daily budget",
  bidding: "Bidding",
  targetCpa: "Target CPA",
  targetRoas: "Target ROAS",
  finalUrl: "Landing page",
  status: "Status",
};

const OUTCOME: Record<string, { text: string; color: string }> = {
  pending: { text: "Waiting for approval", color: "var(--muted)" },
  applied: { text: "Applied", color: "#059669" },
  partial: { text: "Partly applied", color: "#d97706" },
  failed: { text: "Failed", color: "#dc2626" },
  skipped: { text: "Skipped", color: "#d97706" },
  unconfirmed: { text: "Unconfirmed", color: "#d97706" },
  rejected: { text: "Rejected", color: "var(--muted)" },
};

function show(v: unknown) {
  if (v === null || v === undefined || v === "") return <span style={{ color: "var(--muted)" }}>—</span>;
  if (Array.isArray(v)) {
    return v.length ? (
      <ul className="space-y-0.5">
        {v.map((x, i) => (
          <li key={i}>{String(x)}</li>
        ))}
      </ul>
    ) : (
      <span style={{ color: "var(--muted)" }}>none</span>
    );
  }
  return String(v).replace(/_/g, " ");
}

/**
 * A proposed set of campaign changes: each field Before → After, approved or
 * rejected as a whole, then the outcome of each field.
 */
export default function ChangesetCard({
  projectId,
  changeset,
  campaignName,
  onDecided,
}: {
  projectId: string;
  changeset: Changeset;
  campaignName?: string;
  onDecided?: (cs: Changeset) => void;
}) {
  const [cs, setCs] = useState(changeset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = OUTCOME[cs.status] ?? OUTCOME.pending;

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/marketing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "decide", changesetId: cs.id, approve }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(d.error ?? "Something went wrong.");
    setCs(d.changeset);
    onDecided?.(d.changeset);
  }

  const result = (field: string) => cs.results?.find((r) => r.field === field);

  return (
    <div className="mt-3 rounded-xl border text-xs" style={{ background: "var(--panel)" }} aria-label="Proposed ad changes">
      <div className="flex items-start gap-2 border-b p-3">
        <Megaphone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{cs.summary}</p>
          <p className="mt-0.5" style={{ color: "var(--muted)" }}>
            {campaignName ? `${campaignName} · ` : ""}
            {cs.changes.length} {cs.changes.length === 1 ? "change" : "changes"} ·{" "}
            <span style={{ color: status.color }}>{status.text}</span>
          </p>
        </div>
      </div>
      <table className="w-full table-fixed">
        <thead>
          <tr className="text-left" style={{ color: "var(--muted)" }}>
            <th className="w-24 px-3 py-1.5 font-normal">Field</th>
            <th className="px-3 py-1.5 font-normal">Before</th>
            <th className="px-3 py-1.5 font-normal">After</th>
          </tr>
        </thead>
        <tbody>
          {cs.changes.map((ch) => {
            const r = result(ch.field);
            return (
              <tr key={ch.field} className="border-t align-top">
                <td className="px-3 py-2 font-medium">
                  {LABELS[ch.field] ?? ch.field}
                  {r && (
                    <span
                      className="mt-0.5 block font-normal"
                      style={{ color: r.outcome === "applied" ? "#059669" : r.outcome === "failed" ? "#dc2626" : "#d97706" }}
                      title={r.reason}
                    >
                      {r.outcome}
                      {r.reason ? ` · ${r.reason}` : ""}
                    </span>
                  )}
                </td>
                <td className="break-words px-3 py-2 line-through decoration-black/20" style={{ color: "var(--muted)" }}>
                  {show(ch.before)}
                </td>
                <td className="break-words px-3 py-2">{show(ch.after)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && (
        <p className="border-t px-3 py-2 text-red-600" role="alert">
          {error}
        </p>
      )}
      {cs.status === "pending" && (
        <div className="flex justify-end gap-1.5 border-t p-2.5">
          <button onClick={() => decide(false)} disabled={busy} className="flex items-center gap-1 rounded-lg border px-3 py-1.5">
            <X className="h-3 w-3" /> Reject
          </button>
          <button
            onClick={() => decide(true)}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg px-3 py-1.5 font-medium text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            <Check className="h-3 w-3" /> Approve
          </button>
        </div>
      )}
    </div>
  );
}
