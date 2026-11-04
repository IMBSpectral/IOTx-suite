"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users, X } from "lucide-react";

const KEY = "forge-teamup-dismissed";

/**
 * "Team up for free": after a few good builds in a workspace with no one
 * else in it, a one-time nudge to invite teammates. Dismissed for good.
 */
export default function TeamUpCard({ doneTurns }: { doneTurns: number }) {
  const [solo, setSolo] = useState(false);
  // Nothing shows until the members check below, so reading storage here can't mismatch the server render.
  const [dismissed, setDismissed] = useState(() => {
    try {
      return typeof window === "undefined" || localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (dismissed || doneTurns < 3) return;
    let live = true;
    fetch("/api/workspace/members")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setSolo((d?.members?.length ?? 0) === 1))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [dismissed, doneTurns]);

  if (dismissed || !solo || doneTurns < 3) return null;
  return (
    <div className="mx-3 mb-2 flex items-start gap-2.5 rounded-xl border p-3 text-xs" style={{ background: "var(--panel)" }} role="note">
      <Users className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Team up for free</p>
        <p style={{ color: "var(--muted)" }}>Invite teammates to build, review and comment with you. Members share the workspace&apos;s credits.</p>
        <Link href="/settings/members" className="mt-1.5 inline-block rounded-lg border px-2.5 py-1 font-medium">
          Invite teammates
        </Link>
      </div>
      <button
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(KEY, "1");
          } catch {}
        }}
        aria-label="Dismiss"
        className="rounded p-0.5 hover:bg-black/[.05]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
