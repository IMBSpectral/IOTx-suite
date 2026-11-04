"use client";

import { useEffect, useState } from "react";

type Peer = { userId: string; name: string | null };

// Heartbeat comfortably inside the server's liveness window, so a peer never
// flickers out between beats.
const BEAT_MS = 20_000;

export default function PresenceBar({ projectId }: { projectId: string }) {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    let cancelled = false;

    const beat = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/presence`, {
          method: "POST",
        });
        if (!res.ok || cancelled) return;
        const d = await res.json();
        if (!cancelled) setPeers(d.active ?? []);
      } catch {
        // A missed beat is not worth surfacing; the next one recovers.
      }
    };

    void beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId]);

  if (peers.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1"
      title={`${peers.length} other ${peers.length === 1 ? "person" : "people"} here`}
    >
      {peers.slice(0, 3).map((p) => (
        <span
          key={p.userId}
          aria-hidden
          className="grid h-6 w-6 place-items-center rounded-full border-2 text-[10px] font-semibold text-white"
          style={{ background: "var(--accent)", borderColor: "var(--panel)" }}
        >
          {(p.name ?? "?").charAt(0).toUpperCase()}
        </span>
      ))}
      {peers.length > 3 && (
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>
          +{peers.length - 3}
        </span>
      )}
      <span className="sr-only">
        {peers.length} other {peers.length === 1 ? "person is" : "people are"} viewing
        this project
      </span>
    </div>
  );
}
