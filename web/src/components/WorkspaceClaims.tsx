"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { Building2 } from "lucide-react";

type Claimable = { id: string; name: string; mode: "request" | "auto" };

/** "Your team is on Forge": workspaces your email's verified domain lets you join. */
export default function WorkspaceClaims() {
  const [list, setList] = useState<Claimable[]>([]);
  const brand = useBrand();
  const [done, setDone] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    fetch("/api/workspace/claims")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setList(d.workspaces))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function claim(w: Claimable) {
    const res = await fetch("/api/workspace/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: w.id }),
    });
    const d = await res.json().catch(() => ({}));
    const text = !res.ok ? (d.error ?? "Couldn't join.") : d.joined ? "Joined: switch to it from the workspace menu." : "Request sent to its admins.";
    setDone((m) => ({ ...m, [w.id]: text }));
  }

  if (!list.length) return null;
  return (
    <div className="relative z-10 mx-auto mb-6 max-w-[672px] space-y-2">
      {list.map((w) => (
        <div key={w.id} className="flex items-center gap-3 rounded-xl border px-3 py-2 text-xs" style={{ background: "var(--panel)" }}>
          <Building2 className="h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
          <span className="min-w-0 flex-1">
            <b>{w.name}</b> is on {brand.name}, and your email is on its domain.
          </span>
          {done[w.id] ? (
            <span style={{ color: "var(--muted)" }}>{done[w.id]}</span>
          ) : (
            <button onClick={() => void claim(w)} className="btn-primary rounded-lg px-3 py-1">
              {w.mode === "auto" ? "Join" : "Ask to join"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
