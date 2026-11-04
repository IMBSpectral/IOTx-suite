"use client";

import { Plus, X } from "lucide-react";

export type EnvRow = { name: string; value: string };

/** Name/value rows for environment variables. */
export default function EnvRows({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const set = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            value={r.name}
            onChange={(e) => set(i, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
            placeholder="VITE_API_URL"
            aria-label={`Variable ${i + 1} name`}
            className="w-2/5 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs"
          />
          <input
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder="value"
            type="password"
            autoComplete="off"
            aria-label={`Variable ${i + 1} value`}
            className="min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs"
          />
          <button onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove variable ${i + 1}`} className="rounded-lg px-1.5 hover:bg-black/[.05]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { name: "", value: "" }])} className="flex items-center gap-1 text-xs hover:underline" style={{ color: "var(--muted)" }}>
        <Plus className="h-3 w-3" /> Add variable
      </button>
      <p className="text-[11px]" style={{ color: "var(--muted)" }}>
        Stored in the app&apos;s .env, never committed. Names starting with VITE_ are readable in the app&apos;s code and visible to
        visitors; keep secret keys in Cloud secrets.
      </p>
    </div>
  );
}
