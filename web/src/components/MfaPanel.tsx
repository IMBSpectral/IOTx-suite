"use client";

import { useEffect, useState } from "react";

type Status = { enabled: boolean; enabledAt: string | null; recoveryLeft: number };
type Setup = { secret: string; otpauth: string; qr: string };

/** Settings → Preferences: turn two-step verification on or off, manage recovery codes. */
export default function MfaPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"idle" | "disable" | "recovery">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => fetch("/api/mfa").then((r) => r.json()).then(setStatus).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  async function call(action: string, withCode = true) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/mfa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withCode ? { action, code } : { action }) });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(d.error ?? "Something went wrong.");
      return null;
    }
    setCode("");
    return d;
  }

  const input = "rounded-lg border bg-transparent px-3 py-2 text-sm tracking-widest";
  const btn = "rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50";
  const primary = "rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50";

  if (!status) return null;

  return (
    <section className="rounded-xl border p-5" style={{ background: "var(--panel)" }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Two-step verification</h2>
          <p className="mt-1 max-w-xl text-sm" style={{ color: "var(--muted)" }}>
            After you sign in, also ask for a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). Someone with your password or Google account still can&rsquo;t get in without your phone.
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.enabled ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-700"}`}>
          {status.enabled ? "On" : "Off"}
        </span>
      </div>

      {codes && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
          <b className="text-sm">Save these recovery codes now.</b>
          <p className="mt-1 text-xs">Each works once if you lose your phone. They won&rsquo;t be shown again.</p>
          <div className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-sm sm:grid-cols-5">
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className={btn} onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>Copy</button>
            <button type="button" className={btn} onClick={() => setCodes(null)}>I&rsquo;ve saved them</button>
          </div>
        </div>
      )}

      {!status.enabled && !setup && (
        <button
          type="button"
          className={`${primary} mt-4`}
          style={{ background: "var(--accent)" }}
          disabled={busy}
          onClick={async () => {
            const d = await call("setup", false);
            if (d) setSetup(d);
          }}
        >
          Turn on two-step verification
        </button>
      )}

      {!status.enabled && setup && (
        <div className="mt-4 grid gap-5 sm:grid-cols-[220px_1fr]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={220} height={220} className="rounded-lg border bg-white p-2" />
          <div className="space-y-3 text-sm">
            <p><b>1.</b> Scan the code with your authenticator app.</p>
            <p style={{ color: "var(--muted)" }}>Can&rsquo;t scan? Enter this key in the app: <code className="select-all break-all font-mono text-xs">{setup.secret}</code></p>
            <p><b>2.</b> Enter the 6-digit code it shows.</p>
            <div className="flex flex-wrap gap-2">
              <input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code from your app" />
              <button
                type="button"
                className={primary}
                style={{ background: "var(--accent)" }}
                disabled={busy || code.trim().length < 6}
                onClick={async () => {
                  const d = await call("enable");
                  if (d) {
                    setCodes(d.recoveryCodes);
                    setSetup(null);
                    await load();
                  }
                }}
              >
                Verify and turn on
              </button>
              <button type="button" className={btn} onClick={() => setSetup(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {status.enabled && (
        <div className="mt-4 space-y-3 text-sm">
          <p style={{ color: "var(--muted)" }}>
            On since {status.enabledAt ? new Date(status.enabledAt).toLocaleDateString() : "—"} · {status.recoveryLeft} recovery code{status.recoveryLeft === 1 ? "" : "s"} left
          </p>
          {mode === "idle" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={() => setMode("recovery")}>New recovery codes</button>
              <button type="button" className={btn} onClick={() => setMode("disable")}>Turn off</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input className={input} maxLength={11} placeholder={mode === "disable" ? "Code or recovery code" : "Code from your app"} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Verification code" />
              <button
                type="button"
                className={primary}
                style={{ background: mode === "disable" ? "#dc2626" : "var(--accent)" }}
                disabled={busy || !code.trim()}
                onClick={async () => {
                  const d = await call(mode === "disable" ? "disable" : "recovery");
                  if (d) {
                    if (d.recoveryCodes) setCodes(d.recoveryCodes);
                    setMode("idle");
                    await load();
                  }
                }}
              >
                {mode === "disable" ? "Turn off" : "Make new codes"}
              </button>
              <button type="button" className={btn} onClick={() => { setMode("idle"); setError(null); }}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500" role="alert">{error}</p>}
    </section>
  );
}
