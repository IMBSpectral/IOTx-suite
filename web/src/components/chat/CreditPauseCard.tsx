"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Shown under a turn that paused because the workspace ran out of credits:
 * once credits are back, Resume carries on where it stopped and Finish up
 * gets what's there into a working state.
 */
export default function CreditPauseCard({ onSend }: { onSend: (text: string) => void }) {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/workspace/credits")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => live && d && setBalance(d.balance ?? 0))
        .catch(() => undefined);
    void load();
    // Credits can come back while the page is open (a top-up, the daily grant).
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const ready = (balance ?? 0) > 0;
  const muted = { color: "var(--muted)" };
  return (
    <div className="mt-3 rounded-xl border p-3 text-sm" style={{ background: "var(--panel)" }} role="status">
      <p className="font-medium">{ready ? "Ready to continue" : "Paused: out of credits"}</p>
      <p className="mt-0.5 text-xs" style={muted}>
        Your work paused because you were out of credits.
        {ready ? " Credits are now available again." : " Add credits to carry on; nothing is lost."}
      </p>
      <div className="mt-2 flex justify-end gap-2 text-xs">
        {ready ? (
          <>
            <button onClick={() => onSend("Finish up: get what's built so far into a working state, then stop.")} className="rounded-lg border px-3 py-1.5">
              Finish up
            </button>
            <button onClick={() => onSend("Continue where you left off.")} className="rounded-lg px-3 py-1.5 font-medium text-white" style={{ background: "var(--accent)" }}>
              Resume
            </button>
          </>
        ) : (
          <Link href="/settings/billing" className="rounded-lg px-3 py-1.5 font-medium text-white" style={{ background: "var(--accent)" }}>
            Add credits
          </Link>
        )}
      </div>
    </div>
  );
}
