"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { Database, KeyRound, Trash2, Users } from "lucide-react";
import CloudOps from "./CloudOps";
import {
  AiSection,
  BackupsSection,
  CloudEnvContext,
  CloudSettingsSection,
  DatabaseSection,
  FunctionsSection,
  JobsSection,
  LogsSection,
  PoliciesSection,
  SqlSection,
  StorageSection,
  UsageSection,
  UsersSection,
  WorkflowsSection,
} from "./CloudAdmin";

type Column = { name: string; type: string; notnull: number; pk: number };
type Access = "public" | "authenticated" | "owner";
type Table = { name: string; columns: Column[]; rows: number; policy: { read: Access; write: Access } };
type State =
  | { enabled: false }
  | {
      enabled: true;
      url: string;
      anonKey: string;
      tables: Table[];
      migrations: { id: string; description: string; status: string; error: string | null; created_at: string; sql: string }[];
      users: { id: string; email: string; created_at: string }[];
      secrets: { name: string; updatedAt: string }[];
      inheritedSecrets?: string[];
      hasLive?: boolean;
      requestedSecrets: { name: string; description: string }[];
    };

const ACCESS: Access[] = ["public", "authenticated", "owner"];
const SECTIONS = [
  ["overview", "Overview"],
  ["database", "Database"],
  ["users", "Users"],
  ["policies", "Policies"],
  ["sql", "SQL editor"],
  ["logs", "Logs"],
  ["storage", "Storage"],
  ["functions", "Functions"],
  ["jobs", "Jobs"],
  ["workflows", "Workflows"],
  ["ai", "AI"],
  ["usage", "Usage"],
  ["backups", "Backups"],
  ["settings", "Settings"],
] as const;
type Section = (typeof SECTIONS)[number][0];

/** Forge Cloud for this project: database tables and access, migrations, app users, secrets. */
export default function CloudPanel({ projectId, onSend }: { projectId: string; onSend?: (text: string) => void }) {
  const [state, setState] = useState<State | null>(null);
  const brand = useBrand();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [browse, setBrowse] = useState<{ table: string; rows: Record<string, unknown>[] } | null>(null);
  const [secret, setSecret] = useState({ name: "", value: "" });
  const [section, setSection] = useState<Section>("overview");
  const [env, setEnv] = useState<"test" | "live">("test");
  const [liveTables, setLiveTables] = useState<Table[] | null>(null);
  const base = `/api/projects/${projectId}/cloud`;
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setState(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, version]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    setVersion((v) => v + 1);
    if (!res.ok) setError(d.error ?? "Something went wrong");
    return res.ok;
  }

  async function openTable(table: string) {
    const d = await (await fetch(`${base}?table=${encodeURIComponent(table)}`)).json();
    setBrowse({ table, rows: d.rows ?? [] });
  }

  if (!state) return <p className="p-4 text-sm" style={muted}>Loading…</p>;
  if (!state.enabled) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <Database className="mx-auto h-7 w-7" style={muted} />
          <h2 className="mt-2 text-base font-semibold">{brand.shortName} Cloud</h2>
          <p className="mt-1 text-sm" style={muted}>
            A database, sign-in for your app&apos;s users, access rules and secure secrets, without setting up a server.
            The agent turns it on when your app needs it, or you can now.
          </p>
          <button onClick={() => act({ action: "enable" })} className="mt-4 rounded-lg px-3.5 py-2 text-sm font-medium text-white" style={{ background: "var(--accent)" }}>
            Enable Cloud
          </button>
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>
      </div>
    );
  }

  const pending = state.migrations.filter((m) => m.status === "pending");
  const refresh = () => setVersion((v) => v + 1);
  const nav = (
    <nav className="-mx-1 flex flex-wrap gap-0.5 border-b pb-2" aria-label="Cloud sections">
      {SECTIONS.map(([id, label]) => (
        <button
          key={id}
          onClick={() => setSection(id)}
          aria-current={section === id ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 text-xs ${section === id ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
          style={section === id ? undefined : muted}
        >
          {label}
        </button>
      ))}
    </nav>
  );
  const envBar = state.hasLive ? (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-xs" role="tablist" aria-label="Environment">
        {(["test", "live"] as const).map((e) => (
          <button
            key={e}
            role="tab"
            aria-selected={env === e}
            onClick={() => {
              setEnv(e);
              if (e === "live")
                fetch(`${base}/admin?view=tables&env=live`)
                  .then((r) => (r.ok ? r.json() : null))
                  .then((d) => d && setLiveTables(d.tables));
            }}
            className={`rounded-md px-2.5 py-1 ${env === e ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
            style={env === e ? undefined : muted}
          >
            {e === "test" ? "Test" : "Live"}
          </button>
        ))}
      </div>
      <p
        className={`rounded-lg px-3 py-1.5 text-xs ${env === "live" ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}
        role="status"
      >
        {env === "live"
          ? "You are in the Live environment. Edits in Live affect users immediately."
          : "You are in the Test environment. The preview uses this data; the published app uses Live."}
      </p>
    </div>
  ) : null;
  if (section !== "overview") {
    return (
      <CloudEnvContext.Provider value={env}>
      <div className="h-full space-y-4 overflow-y-auto p-5 text-sm">
        {nav}
        {envBar}
        {section === "database" && <DatabaseSection key={env} projectId={projectId} tables={env === "live" ? (liveTables ?? []) : state.tables} onChanged={refresh} />}
        {section === "users" && <UsersSection projectId={projectId} />}
        {section === "sql" && <SqlSection projectId={projectId} onChanged={refresh} />}
        {section === "logs" && <LogsSection projectId={projectId} />}
        {section === "storage" && <StorageSection projectId={projectId} />}
        {section === "functions" && <FunctionsSection projectId={projectId} />}
        {section === "jobs" && <JobsSection projectId={projectId} />}
        {section === "workflows" && <WorkflowsSection projectId={projectId} />}
        {section === "backups" && <BackupsSection projectId={projectId} onChanged={refresh} />}
        {section === "policies" && <PoliciesSection projectId={projectId} tables={state.tables} />}
        {section === "ai" && <AiSection projectId={projectId} />}
        {section === "usage" && <UsageSection projectId={projectId} />}
        {section === "settings" && (
          <CloudSettingsSection
            projectId={projectId}
            onDisabled={() => {
              setSection("overview");
              refresh();
            }}
          />
        )}
      </div>
      </CloudEnvContext.Provider>
    );
  }
  return (
    <div className="h-full space-y-6 overflow-y-auto p-5 text-sm">
      {nav}
      <section className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
        <p className="font-medium">{brand.shortName} Cloud is on</p>
        <p className="mt-1 break-all font-mono text-[11px]" style={muted}>
          {state.url}
        </p>
        <p className="mt-1 text-xs" style={muted}>
          The app uses <span className="font-mono">src/integrations/cloud/client.ts</span>. Its key only identifies the project.
        </p>
      </section>

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      <CloudOps projectId={projectId} onSend={onSend} onChanged={() => setVersion((v) => v + 1)} />

      {pending.length > 0 && (
        <section aria-label="Pending migrations" className="rounded-xl border border-amber-500/40 p-4">
          <h3 className="font-medium">Waiting for approval</h3>
          {pending.map((m) => (
            <div key={m.id} className="mt-2">
              <p className="text-xs">{m.description}</p>
              <pre className="mt-1 max-h-40 overflow-auto rounded-lg border p-2 font-mono text-[11px]">{m.sql}</pre>
              <div className="mt-1.5 flex gap-1.5 text-xs">
                <button onClick={() => act({ action: "approve", id: m.id })} className="rounded-md px-2.5 py-1 font-medium text-white" style={{ background: "var(--accent)" }}>
                  Approve
                </button>
                <button onClick={() => act({ action: "reject", id: m.id })} className="rounded-md border px-2.5 py-1">
                  Reject
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section aria-label="Tables">
        <h3 className="mb-2 flex items-center gap-1.5 font-medium">
          <Database className="h-4 w-4" /> Database
        </h3>
        {state.tables.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-xs" style={muted}>
            No tables yet. Ask the agent to store something and it will propose a migration.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border" style={{ background: "var(--panel)" }}>
            {state.tables.map((t) => (
              <li key={t.name} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button onClick={() => openTable(t.name)} className="font-mono text-xs font-medium hover:underline">
                    {t.name}
                  </button>
                  <span className="text-[11px]" style={muted}>
                    {t.rows} {t.rows === 1 ? "row" : "rows"}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px]">
                    {(["read", "write"] as const).map((k) => (
                      <label key={k} className="flex items-center gap-1">
                        {k === "read" ? "Read" : "Write"}
                        <select
                          value={t.policy[k]}
                          onChange={(e) => act({ action: "policy", table: t.name, ...t.policy, [k]: e.target.value })}
                          className="rounded border bg-transparent px-1 py-0.5"
                        >
                          {ACCESS.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-[10px]" style={muted}>
                  {t.columns.map((c) => `${c.name} ${c.type || "ANY"}${c.pk ? " PK" : ""}`).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
        {browse && (
          <div className="mt-3 rounded-xl border p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-mono font-medium">{browse.table}</span>
              <button onClick={() => setBrowse(null)} style={muted}>
                Close
              </button>
            </div>
            {browse.rows.length === 0 ? (
              <p className="text-xs" style={muted}>
                No rows.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead>
                    <tr>
                      {Object.keys(browse.rows[0]).map((k) => (
                        <th key={k} className="border-b px-2 py-1 font-medium">
                          {k}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {browse.rows.map((r, i) => (
                      <tr key={i}>
                        {Object.values(r).map((v, j) => (
                          <td key={j} className="max-w-[200px] truncate border-b px-2 py-1">
                            {v === null ? "null" : String(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section aria-label="Users">
        <h3 className="mb-2 flex items-center gap-1.5 font-medium">
          <Users className="h-4 w-4" /> Users ({state.users.length})
        </h3>
        {state.users.length === 0 ? (
          <p className="text-xs" style={muted}>
            Nobody has signed up to the app yet.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border text-xs">
            {state.users.map((u) => (
              <li key={u.id} className="flex justify-between px-3 py-1.5">
                <span>{u.email}</span>
                <span style={muted}>{new Date(u.created_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Secrets">
        <h3 className="mb-2 flex items-center gap-1.5 font-medium">
          <KeyRound className="h-4 w-4" /> Secrets
        </h3>
        <p className="mb-2 text-xs" style={muted}>
          Store API keys and tokens securely. Values are encrypted and never shown again, to you or the agent.
        </p>
        {state.requestedSecrets.length > 0 && (
          <p className="mb-2 text-xs text-amber-700">
            The agent asked for: {state.requestedSecrets.map((r) => r.name).join(", ")}
          </p>
        )}
        {!!state.inheritedSecrets?.length && (
          <p className="mb-2 text-xs" style={muted}>
            From the workspace: <span className="font-mono">{state.inheritedSecrets.join(", ")}</span>. Add a project
            secret with the same name to override one.{" "}
            <a href="/settings/secrets" className="underline">
              Workspace secrets
            </a>
          </p>
        )}
        <ul className="mb-2 divide-y rounded-xl border text-xs">
          {state.secrets.length === 0 && (
            <li className="px-3 py-2" style={muted}>
              No secrets yet.
            </li>
          )}
          {state.secrets.map((s) => (
            <li key={s.name} className="flex items-center justify-between px-3 py-1.5">
              <span className="font-mono">{s.name}</span>
              <span className="flex items-center gap-2" style={muted}>
                updated {new Date(s.updatedAt).toLocaleDateString()}
                <button onClick={() => act({ action: "deleteSecret", name: s.name })} aria-label={`Delete ${s.name}`} className="text-red-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex gap-1.5 text-xs">
          <input
            value={secret.name}
            onChange={(e) => setSecret({ ...secret, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
            placeholder="NAME"
            aria-label="Secret name"
            className="w-40 rounded-md border bg-transparent px-2 py-1 font-mono"
          />
          <input
            type="password"
            autoComplete="off"
            value={secret.value}
            onChange={(e) => setSecret({ ...secret, value: e.target.value })}
            placeholder="Value"
            aria-label="Secret value"
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 font-mono"
          />
          <button
            disabled={!secret.name || !secret.value}
            onClick={async () => {
              if (await act({ action: "setSecret", ...secret })) setSecret({ name: "", value: "" });
            }}
            className="rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            Save
          </button>
        </div>
      </section>

      {state.migrations.some((m) => m.status !== "pending") && (
        <section aria-label="Migration history">
          <h3 className="mb-2 font-medium">Migration history</h3>
          <ul className="divide-y rounded-xl border text-xs">
            {state.migrations
              .filter((m) => m.status !== "pending")
              .map((m) => (
                <li key={m.id} className="flex justify-between gap-2 px-3 py-1.5">
                  <span className="truncate">{m.description}</span>
                  <span className={m.status === "failed" ? "text-red-600" : ""} style={m.status === "failed" ? undefined : muted}>
                    {m.status}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
