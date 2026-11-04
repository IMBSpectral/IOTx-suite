"use client";

import { useState } from "react";

/** Code entry for the second sign-in step. */
export default function MfaChallenge({ next }: { next: string }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/mfa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", code }) });
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) {
      window.location.href = next;
      return;
    }
    setError(d.error ?? "That didn't work. Try again.");
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="si-sso">
      <label htmlFor="mfa-code">{recovery ? "Recovery code" : "Authentication code"}</label>
      <div>
        <input
          id="mfa-code"
          autoFocus
          autoComplete="one-time-code"
          inputMode={recovery ? "text" : "numeric"}
          placeholder={recovery ? "xxxxx-xxxxx" : "123 456"}
          maxLength={recovery ? 11 : 7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{ letterSpacing: recovery ? undefined : "0.3em", fontSize: 18 }}
        />
        <button className="si-btn si-btn-main" style={{ width: "auto" }} disabled={busy}>
          {busy ? "Checking…" : "Verify"}
        </button>
      </div>
      {error && <p className="si-error" role="alert">{error}</p>}
      <button
        type="button"
        onClick={() => {
          setRecovery((r) => !r);
          setCode("");
          setError(null);
        }}
        style={{ marginTop: 14, background: "none", border: 0, padding: 0, color: "#6d5dfc", cursor: "pointer", fontSize: 13.5 }}
      >
        {recovery ? "Use a code from my app instead" : "Lost your phone? Use a recovery code"}
      </button>
    </form>
  );
}
