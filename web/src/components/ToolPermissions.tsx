"use client";

import { useCallback, useEffect, useState } from "react";

type Data = { prefs: { key: string; pref: "ask" | "allow" }[]; grants: { key: string; until: string; uses: number | null }[] };

const label = (key: string) => {
  const [kind, connection, what] = key.split(":");
  return { source: kind === "mcp" ? "MCP tool" : "Connector", connection, what: kind === "connector" ? (what === "read" ? "reading data" : "changing data") : what };
};

/** What the agent may use without asking: saved choices from approval cards, and live temporary approvals. */
export default function ToolPermissions() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };
  const load = useCallback(() => {
    fetch("/api/workspace/tool-permissions")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function set(key: string, pref: "ask" | "allow" | null) {
    setError("");
    const r = await fetch("/api/workspace/tool-permissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set", key, pref }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error ?? "That didn't work");
    load();
  }

  if (!data) return null;
  return (
    <section className="mt-8 space-y-2 text-sm">
      <h2 className="text-sm font-medium">Agent tool permissions</h2>
      <p className="text-xs" style={muted}>
        The agent reads from connected tools freely and asks before it changes anything. Choices made on approval cards
        show up here; switch any of them back to asking.
      </p>
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
      <ul className="divide-y rounded-xl border">
        {data.prefs.length === 0 && data.grants.length === 0 && (
          <li className="px-4 py-3 text-xs" style={muted}>
            No saved choices yet.
          </li>
        )}
        {data.prefs.map((p) => {
          const l = label(p.key);
          return (
            <li key={p.key} className="flex items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{l.connection}</span> <span style={muted}>· {l.source}: {l.what}</span>
              </span>
              <select value={p.pref} onChange={(e) => void set(p.key, e.target.value as "ask" | "allow")} aria-label={`Permission for ${l.connection} ${l.what}`} className="rounded-lg border bg-transparent px-2 py-1 text-xs">
                <option value="ask">Always ask</option>
                <option value="allow">Never ask</option>
              </select>
              <button onClick={() => void set(p.key, null)} className="text-xs hover:underline" style={muted}>
                Reset
              </button>
            </li>
          );
        })}
        {data.grants.map((g) => {
          const l = label(g.key);
          return (
            <li key={`g-${g.key}`} className="flex items-center gap-2 px-4 py-2.5 text-xs">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{l.connection}</span> <span style={muted}>· {l.source}: {l.what}</span>
              </span>
              <span style={muted}>{g.uses === 1 ? "allowed once" : `allowed until ${new Date(g.until).toLocaleTimeString()}`}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
