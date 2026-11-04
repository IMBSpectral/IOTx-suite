"use client";

import { useEffect, useState } from "react";

/** Admins: whether members connect tools themselves or ask first (requests land in the action center). */
export default function ConnectorApproval() {
  const [s, setS] = useState<{ approval: boolean; canManage: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/workspace/connectors")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setS({ approval: !!d.approval, canManage: !!d.canManage }));
  }, []);
  if (!s?.canManage) return null;
  return (
    <label className="mb-5 flex items-start gap-2 rounded-xl border p-3 text-sm" style={{ background: "var(--panel)" }}>
      <input
        type="checkbox"
        className="mt-0.5"
        checked={s.approval}
        disabled={busy}
        onChange={async (e) => {
          const approval = e.target.checked;
          setBusy(true);
          const r = await fetch("/api/workspace/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "policy", approval }) });
          setBusy(false);
          if (r.ok) setS({ ...s, approval });
        }}
      />
      <span>
        <span className="font-medium">Members need approval to connect tools</span>
        <span className="block text-xs" style={{ color: "var(--muted)" }}>
          A member&apos;s connection becomes a request in the action center. Their credential is kept encrypted and only used if an admin approves. Owners and admins connect directly.
        </span>
      </span>
    </label>
  );
}
