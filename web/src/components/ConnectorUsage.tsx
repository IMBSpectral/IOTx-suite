"use client";

import { useEffect, useState } from "react";

type Usage = { connection: string; kind: string; requests: number; errors: number };
type Entry = { at: string; projectId: string | null; connection: string; request: string; status: number | null; ms: number };

/** Connector usage per connection and the request log (owners and admins). */
export default function ConnectorUsage() {
  const [data, setData] = useState<{ usage: Usage[]; log: Entry[] } | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [project, setProject] = useState("");
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    fetch(`/api/workspace/connector-logs${project ? `?projectId=${project}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => undefined);
  }, [project]);
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setProjects((Array.isArray(d) ? d : (d.projects ?? [])).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))))
      .catch(() => undefined);
  }, []);

  if (!data) return null;
  const name = (id: string | null) => projects.find((p) => p.id === id)?.name ?? "—";
  return (
    <section className="mt-8 space-y-3 text-sm">
      <h2 className="text-sm font-medium">Connector usage</h2>
      {data.usage.length === 0 ? (
        <p className="text-xs" style={muted}>
          No requests through connectors in the last 30 days.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-3">
          {data.usage.map((u) => (
            <li key={u.connection} className="rounded-xl border px-3 py-2">
              <p className="font-medium">{u.connection}</p>
              <p className="text-xs" style={muted}>
                {u.requests} request{u.requests === 1 ? "" : "s"} in 30 days{u.errors ? ` · ${u.errors} failed` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium">Request log</h3>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className="rounded-lg border bg-transparent px-2 py-1 text-xs">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <ul className="max-h-80 divide-y overflow-auto rounded-xl border text-xs">
        {data.log.length === 0 && (
          <li className="px-4 py-3" style={muted}>
            Nothing yet.
          </li>
        )}
        {data.log.map((e, i) => (
          <li key={i} className="flex flex-wrap gap-x-3 px-4 py-1.5">
            <span className={e.status && e.status < 400 ? "text-emerald-600" : "text-red-500"}>{e.status ?? "failed"}</span>
            <span className="font-medium">{e.connection}</span>
            <code>{e.request}</code>
            <span style={muted}>
              {name(e.projectId)} · {e.ms} ms · {new Date(e.at).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
