"use client";

import { useState } from "react";
import { BrandMark, useBrand } from "@/components/BrandProvider";

/** The consent card for "Continue with Forge". */
export default function ForgeConsent({ projectId, appName, email, redirectUri, state }: { projectId: string; appName: string; email: string; redirectUri: string; state: string }) {
  const [busy, setBusy] = useState(false);
  const brand = useBrand();
  const [error, setError] = useState("");
  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    location.href = u.toString();
  };
  return (
    <div className="space-y-4 text-sm">
      <div className="flex justify-center">
        <BrandMark size={44} radius={12} />
      </div>
      <h1 className="text-center text-lg font-semibold">Sign in to {appName}</h1>
      <p className="text-center" style={{ color: "var(--muted)" }}>
        {appName} will get your email address, <span className="font-medium">{email}</span>, and nothing else from your {brand.name} account.
      </p>
      {error && (
        <p className="text-red-500" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button onClick={() => back({ forge_error: "cancelled", state })} className="flex-1 rounded-lg border px-3 py-2">
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            const r = await fetch("/api/oauth/forge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, redirectUri }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) {
              setBusy(false);
              return setError(d.error ?? "Couldn't sign you in");
            }
            back({ forge_code: d.code, state });
          }}
          className="flex-1 rounded-lg px-3 py-2 font-medium text-white disabled:opacity-60"
          style={{ background: "var(--accent)" }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
