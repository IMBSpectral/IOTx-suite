"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Clock, TriangleAlert } from "lucide-react";
import type { DomainStatus as Status } from "@/lib/domains";

const POLL_MS = 15_000;

/** A custom domain's DNS status, checked live until it's connected. */
export default function DomainStatus({ projectId, domain }: { projectId: string; domain: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const d = await fetch(`/api/projects/${projectId}/domain`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!live) return;
      if (d?.domain) {
        setStatus(d);
        setCheckedAt(new Date());
        if (d.status !== "active") timer = setTimeout(check, POLL_MS);
      }
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projectId, domain]);

  if (!status) return <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>Checking {domain}…</p>;
  const Icon = status.status === "active" ? CheckCircle2 : status.status === "pending_dns" ? Clock : TriangleAlert;
  const tone =
    status.status === "active" ? "text-emerald-600 dark:text-emerald-400" : status.status === "pending_dns" ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";
  return (
    <div className="mt-3 rounded-lg border p-3 text-xs" role="status" aria-live="polite">
      <p className={`flex items-center gap-1.5 font-medium ${tone}`}>
        <Icon className="h-3.5 w-3.5" />
        {status.status === "active" ? "Connected" : status.status === "pending_dns" ? "Waiting for DNS" : "Points elsewhere"}
      </p>
      <p className="mt-1" style={{ color: "var(--muted)" }}>{status.message}</p>
      {status.status !== "active" && (
        <table className="mt-2 w-full font-mono text-[11px]">
          <thead style={{ color: "var(--muted)" }}>
            <tr>
              <th className="text-left font-normal">Type</th>
              <th className="text-left font-normal">Name</th>
              <th className="text-left font-normal">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{status.expected.type}</td>
              <td>{status.expected.name}</td>
              <td className="break-all select-all">{status.expected.value}</td>
            </tr>
          </tbody>
        </table>
      )}
      {checkedAt && status.status !== "active" && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
          Checked {checkedAt.toLocaleTimeString()} · updates on its own
        </p>
      )}
    </div>
  );
}
