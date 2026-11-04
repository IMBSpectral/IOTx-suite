"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { CheckCircle2, Plug, RefreshCw, XCircle } from "lucide-react";

type Def = {
  custom?: boolean;
  kind: string;
  name: string;
  description: string;
  type: "standard" | "seamless";
  docs: string | null;
  fields: { key: string; label: string; secret: boolean; placeholder: string }[];
};
type Connection = {
  id: string;
  kind: string;
  name: string;
  label: string;
  scope: "workspace" | "project";
  projectId: string | null;
  account: string | null;
  status: "ok" | "failed";
  error: string | null;
  checkedAt: string | null;
};

/**
 * Connect the tools you use every day. In a project, connections can be
 * limited to that project; from Settings they belong to the workspace.
 */
export default function ConnectorsPanel({
  projectId,
  prefill,
}: {
  projectId?: string;
  /** Open a connector's form straight away, e.g. after pasting its credential. */
  prefill?: { kind: string; value?: string };
}) {
  const [catalog, setCatalog] = useState<Def[]>([]);
  const brand = useBrand();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [version, setVersion] = useState(0);
  const [form, setForm] = useState<{ kind: string; values: Record<string, string>; label: string; scope: "workspace" | "project" } | null>(
    prefill ? { kind: prefill.kind, values: prefill.value ? { token: prefill.value } : {}, label: "", scope: projectId ? "project" : "workspace" } : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [myRequests, setMyRequests] = useState<{ id: string; name: string; label: string | null; at: string }[]>([]);
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    let live = true;
    fetch(`/api/workspace/connectors${projectId ? `?projectId=${projectId}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setCatalog(d.catalog);
        setConnections(d.connections);
        setMyRequests(d.myRequests ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, version]);

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    setNote(null);
    const res = await fetch("/api/workspace/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    setVersion((v) => v + 1);
    if (d.requested) setNote(d.message ?? "Sent to your workspace admins for approval.");
    if (!res.ok) setError(d.error ?? "Something went wrong");
    else if (d.ok === false) setError(d.error ?? "The check failed");
    return res.ok;
  }

  const def = form ? catalog.find((c) => c.kind === form.kind) : null;

  return (
    <div className="space-y-6 text-sm">
      {connections.length > 0 && (
        <section aria-label="Connected">
          <h3 className="mb-2 font-medium">Connected</h3>
          <ul className="divide-y rounded-xl border" style={{ background: "var(--panel)" }}>
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-medium">
                    {c.status === "ok" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-label="Working" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-red-500" aria-label="Failing" />
                    )}
                    {c.name} · {c.label}
                  </span>
                  <span className="block text-[11px]" style={muted}>
                    {c.scope === "project" ? "This project only" : "Whole workspace"}
                    {c.account ? ` · ${c.account}` : ""}
                    {c.checkedAt ? ` · checked ${new Date(c.checkedAt).toLocaleString()}` : ""}
                  </span>
                  {c.error && <span className="block text-[11px] text-red-600">{c.error}</span>}
                </span>
                <span className="flex gap-1.5 text-xs">
                  <button disabled={!!busy} onClick={() => act(`check-${c.id}`, { action: "check", id: c.id })} className="flex items-center gap-1 rounded-md border px-2 py-1">
                    <RefreshCw className={`h-3 w-3 ${busy === `check-${c.id}` ? "animate-spin" : ""}`} /> Check
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() => confirm(`Disconnect ${c.name} (${c.label})? Projects using it lose access.`) && act(`rm-${c.id}`, { action: "disconnect", id: c.id })}
                    className="rounded-md px-2 py-1 text-red-500 hover:bg-red-500/[.08]"
                  >
                    Disconnect
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="text-xs text-emerald-700" role="status">
          {note}
        </p>
      )}
      {myRequests.length > 0 && (
        <section aria-label="Waiting for approval">
          <h3 className="mb-2 font-medium">Waiting for an admin</h3>
          <ul className="divide-y rounded-xl border text-xs" style={{ background: "var(--panel)" }}>
            {myRequests.map((r) => (
              <li key={r.id} className="px-3 py-2">
                {r.name}
                {r.label ? ` · ${r.label}` : ""} <span style={muted}>· asked {new Date(r.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {form && def && (
        <section className="rounded-xl border p-4" style={{ background: "var(--panel)" }} aria-label={`Connect ${def.name}`}>
          <h3 className="font-medium">Connect {def.name}</h3>
          <p className="mt-0.5 text-xs" style={muted}>
            {def.description} The credential is encrypted, checked against {def.name}, and only ever sent to {def.name}&apos;s API.
            {def.docs && (
              <>
                {" "}
                <a href={def.docs} target="_blank" rel="noreferrer" className="underline">
                  Get one here
                </a>
                .
              </>
            )}
          </p>
          <div className="mt-3 space-y-2">
            {def.fields.map((f) => (
              <label key={f.key} className="block text-xs">
                {f.label}
                <input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  value={form.values[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, values: { ...form.values, [f.key]: e.target.value } })}
                  placeholder={f.placeholder}
                  className="mt-1 w-full rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none"
                />
              </label>
            ))}
            <label className="block text-xs">
              Name (optional)
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="e.g. Marketing workspace"
                className="mt-1 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-xs outline-none"
              />
            </label>
            {projectId && (
              <label className="flex items-center gap-2 text-xs">
                <select
                  value={form.scope}
                  onChange={(e) => setForm({ ...form, scope: e.target.value as "workspace" | "project" })}
                  className="rounded-md border bg-transparent px-1.5 py-1"
                >
                  <option value="project">This project only</option>
                  <option value="workspace">Whole workspace</option>
                </select>
              </label>
            )}
          </div>
          <div className="mt-3 flex justify-end gap-1.5 text-xs">
            <button onClick={() => setForm(null)} className="rounded-md px-2.5 py-1" style={muted}>
              Cancel
            </button>
            <button
              disabled={!!busy}
              onClick={async () => {
                if (await act("connect", { action: "connect", kind: form.kind, values: form.values, label: form.label, scope: form.scope, projectId })) setForm(null);
              }}
              className="rounded-md px-3 py-1 font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {busy === "connect" ? "Checking…" : "Connect"}
            </button>
          </div>
        </section>
      )}

      <section aria-label="Available connectors">
        <h3 className="mb-2 font-medium">Available</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {catalog.map((c) => (
            <li key={c.kind} className="flex items-start justify-between gap-2 rounded-xl border p-3" style={{ background: "var(--panel)" }}>
              <span>
                <span className="flex items-center gap-1.5 font-medium">
                  <Plug className="h-3.5 w-3.5" /> {c.name}
                </span>
                <span className="mt-0.5 block text-[11px]" style={muted}>
                  {c.description}
                </span>
              </span>
              {c.custom && !projectId && (
                <button
                  onClick={() => {
                    if (confirm(`Remove the custom connector ${c.name}? Existing connections stop working.`)) void act(`del-${c.kind}`, { action: "deleteDef", kind: c.kind });
                  }}
                  className="shrink-0 text-[10px] text-red-500"
                >
                  Remove
                </button>
              )}
              {c.type === "standard" ? (
                <button
                  onClick={() => setForm({ kind: c.kind, values: {}, label: "", scope: projectId ? "project" : "workspace" })}
                  className="shrink-0 rounded-md border px-2 py-1 text-xs"
                >
                  Connect
                </button>
              ) : (
                <span className="shrink-0 text-[10px]" style={muted} title={`Signs in with OAuth, which needs ${brand.name} deployed with an OAuth app`}>
                  Needs OAuth
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
      {!projectId && <CustomConnectorForm onSave={(def) => act("save-def", { action: "saveDef", def })} />}
    </div>
  );
}

/** "Connect your own API" or "Connect your own MCP": adds a connector to the workspace's registry. */
function CustomConnectorForm({ onSave }: { onSave: (def: Record<string, string>) => Promise<boolean> }) {
  const [type, setType] = useState<"api" | "mcp">("api");
  const [d, setD] = useState({ name: "", description: "", baseUrl: "", headerName: "Authorization", headerValue: "Bearer {{token}}", check: "", tokenLabel: "API key", url: "" });
  const input = "w-full rounded-lg border bg-transparent px-2 py-1.5 text-xs";
  return (
    <section aria-label="Custom connector" className="space-y-2 rounded-xl border p-3 text-xs">
      <div className="flex gap-1" role="tablist">
        {(
          [
            ["api", "Connect your own API"],
            ["mcp", "Connect your own MCP"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={type === k} onClick={() => setType(k)} className={`rounded-md px-2 py-1 ${type === k ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}>
            {l}
          </button>
        ))}
      </div>
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onSave({ ...d, type })) setD({ ...d, name: "", description: "", baseUrl: "", check: "", url: "" });
        }}
      >
        <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Name, e.g. Our CRM" aria-label="Connector name" className={input} />
        <input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="What it's for (optional)" aria-label="Description" className={input} />
        {type === "api" ? (
          <>
            <input value={d.baseUrl} onChange={(e) => setD({ ...d, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" aria-label="API base URL" className={input} />
            <input value={d.check} onChange={(e) => setD({ ...d, check: e.target.value })} placeholder="Check path, e.g. /me (optional)" aria-label="Check path" className={input} />
            <input value={d.headerName} onChange={(e) => setD({ ...d, headerName: e.target.value })} aria-label="Auth header name" className={input} />
            <input value={d.headerValue} onChange={(e) => setD({ ...d, headerValue: e.target.value })} aria-label="Auth header value (use {{token}})" className={input} />
            <input value={d.tokenLabel} onChange={(e) => setD({ ...d, tokenLabel: e.target.value })} aria-label="What the key is called" className={input} />
          </>
        ) : (
          <input value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://mcp.example.com/mcp" aria-label="MCP server URL" className={`${input} sm:col-span-2`} />
        )}
        <div className="flex justify-end sm:col-span-2">
          <button className="rounded-lg border px-3 py-1.5">Add to the catalog</button>
        </div>
      </form>
    </section>
  );
}
