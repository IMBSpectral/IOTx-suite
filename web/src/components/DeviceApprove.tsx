"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { MonitorSmartphone } from "lucide-react";

/** Approve or deny a device's sign-in, by the code it shows. */
export default function DeviceApprove({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const brand = useBrand();
  const [pending, setPending] = useState<{ clientName: string; userCode: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function look(c: string) {
    setError(null);
    const res = await fetch(`/api/device/approve?code=${encodeURIComponent(c)}`);
    const d = await res.json().catch(() => ({}));
    if (res.ok) setPending(d);
    else setError(d.error ?? "That code isn't valid.");
  }

  // A link from the device (?code=…) looks the code up straight away.
  useEffect(() => {
    if (!initialCode) return;
    let live = true;
    fetch(`/api/device/approve?code=${encodeURIComponent(initialCode)}`)
      .then(async (res) => {
        const d = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok) setPending(d);
        else setError(d.error ?? "That code isn't valid.");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [initialCode]);

  async function decide(approve: boolean) {
    setBusy(true);
    const res = await fetch("/api/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pending?.userCode, approve }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(d.error ?? "Something went wrong");
    setDone(approve ? `${d.clientName} is signed in. You can go back to it.` : `Denied. ${d.clientName} wasn't signed in.`);
    setPending(null);
  }

  return (
    <div className="mx-auto mt-[12vh] w-full max-w-sm rounded-2xl border p-6 text-center shadow-sm" style={{ background: "var(--panel)" }}>
      <MonitorSmartphone className="mx-auto h-8 w-8" style={{ color: "var(--accent)" }} />
      <h1 className="mt-3 text-lg font-semibold">Sign in a device</h1>
      {done ? (
        <p className="mt-3 text-sm" role="status">{done}</p>
      ) : pending ? (
        <>
          <p className="mt-3 text-sm">
            <b>{pending.clientName}</b> wants to sign in to your {brand.name} account.
          </p>
          <p className="mt-1 font-mono text-lg tracking-widest">{pending.userCode}</p>
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Only approve if you started this on your own device and the code matches.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button disabled={busy} onClick={() => decide(false)} className="rounded-lg border px-4 py-1.5 text-sm">
              Deny
            </button>
            <button disabled={busy} onClick={() => decide(true)} className="btn-primary rounded-lg px-4 py-1.5 text-sm">
              Approve
            </button>
          </div>
        </>
      ) : (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void look(code);
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH"
            aria-label="Code shown on the device"
            className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-center font-mono tracking-widest"
          />
          <button className="btn-primary rounded-lg px-3 text-sm">Continue</button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
