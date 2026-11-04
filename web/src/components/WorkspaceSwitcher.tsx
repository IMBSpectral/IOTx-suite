"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown } from "lucide-react";

type Ws = { id: string; name: string; plan: string };

/** Sidebar header: the active workspace, and a menu to switch to another. */
export default function WorkspaceSwitcher({ current, workspaces }: { current: Ws; workspaces: Ws[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function choose(id: string) {
    setOpen(false);
    if (id === current.id) return;
    const res = await fetch("/api/workspace/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: id }),
    });
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Workspace: ${current.name}. Switch workspace`}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 text-left hover:bg-black/[.05] dark:hover:bg-white/[.06]"
      >
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs font-semibold text-white"
          style={{ background: "var(--accent)" }}
        >
          {current.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{current.name}</span>
        {workspaces.length > 1 && <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--muted)" }} />}
      </button>
      {open && workspaces.length > 1 && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 w-56 rounded-xl border p-1 shadow-xl"
          style={{ background: "var(--panel)" }}
        >
          {workspaces.map((w) => (
            <button
              key={w.id}
              role="menuitemradio"
              aria-checked={w.id === current.id}
              onClick={() => choose(w.id)}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-black/[.04]"
            >
              <span className="truncate">{w.name}</span>
              <span className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--muted)" }}>
                {w.plan.charAt(0) + w.plan.slice(1).toLowerCase()}
                {w.id === current.id && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
