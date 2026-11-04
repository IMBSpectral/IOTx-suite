"use client";

import { useState } from "react";

/** Join a workspace from an invite link, then switch to it. */
export default function JoinWorkspaceButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="space-y-2">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          const r = await fetch("/api/workspace/members-extra", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "join", token }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            setBusy(false);
            return setError(d.error ?? "Couldn't join");
          }
          await fetch("/api/workspace/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: d.workspaceId }) }).catch(() => undefined);
          location.href = "/dashboard";
        }}
        className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        style={{ background: "var(--accent)" }}
      >
        {busy ? "Joining…" : "Join workspace"}
      </button>
      {error && (
        <p className="text-sm text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
