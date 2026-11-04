"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound } from "lucide-react";

type Key = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  monthlyLimit: number | null;
  usedThisMonth: number;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
};

const SCOPE_TEXT: Record<string, string> = {
  read: "Read projects and builds",
  build: "Send build instructions (uses credits)",
  database: "Query project databases (read-only)",
  deploy: "Publish projects",
};

/** Workspace API keys and how to connect Forge as an MCP server. */
export default function ApiKeysPanel() {
  const [data, setData] = useState<{ keys: Key[]; scopes: string[]; mcpUrl: string } | null>(null);
  const [form, setForm] = useState({ name: "", scopes: ["read"] as string[], limit: "" });
  const [token, setToken] = useState<string | null>(null);
  const [client, setClient] = useState<"claude-code" | "claude-desktop" | "cursor">("claude-code");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };

  const load = useCallback(() => {
    fetch("/api/workspace/api-keys")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Only workspace owners and admins can manage API keys.");
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function post(body: Record<string, unknown>) {
    setError("");
    const r = await fetch("/api/workspace/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "That didn't work");
      return null;
    }
    load();
    return d;
  }

  const shown = token ?? "<your API key>";
  const snippets = data
    ? {
        "claude-code": `claude mcp add --transport http forge ${data.mcpUrl} --header "Authorization: Bearer ${shown}"`,
        "claude-desktop": JSON.stringify(
          { mcpServers: { forge: { command: "npx", args: ["-y", "mcp-remote", data.mcpUrl, "--header", `Authorization: Bearer ${shown}`] } } },
          null,
          2,
        ),
        cursor: JSON.stringify({ mcpServers: { forge: { url: data.mcpUrl, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2),
      }
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <KeyRound className="h-4 w-4" /> API keys &amp; MCP
        </h2>
        <p className="mt-1 text-sm" style={muted}>
          Connect Claude, Cursor and other MCP clients to this workspace. Tool calls can edit projects, deploy apps, query
          databases and use credits, within each key&apos;s scopes and its creator&apos;s own access.
        </p>
      </div>
      {error && (
        <p className="text-sm text-red-500" role="alert">
          {error}
        </p>
      )}
      {token && (
        <div className="rounded-xl border border-emerald-500/40 p-4 text-sm" role="status">
          <p className="font-medium">Copy your key now. It won&apos;t be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border px-2 py-1.5 font-mono text-xs">{token}</code>
            <button onClick={() => void navigator.clipboard?.writeText(token)} className="rounded-lg border px-2 py-1.5" aria-label="Copy key">
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {data && (
        <>
          <form
            className="space-y-3 rounded-xl border p-4 text-sm"
            style={{ background: "var(--panel)" }}
            onSubmit={async (e) => {
              e.preventDefault();
              const d = await post({ action: "create", name: form.name, scopes: form.scopes, monthlyLimit: form.limit ? Number(form.limit) : null });
              if (d?.token) {
                setToken(d.token);
                setForm({ name: "", scopes: ["read"], limit: "" });
              }
            }}
          >
            <p className="font-medium">New key</p>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name, e.g. Claude Desktop" aria-label="Key name" className="w-full rounded-lg border bg-transparent px-3 py-2" />
            <fieldset className="grid gap-1 sm:grid-cols-2">
              <legend className="mb-1 text-xs" style={muted}>
                Scopes
              </legend>
              {data.scopes.map((s) => (
                <label key={s} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.scopes.includes(s)}
                    onChange={(e) => setForm({ ...form, scopes: e.target.checked ? [...form.scopes, s] : form.scopes.filter((x) => x !== s) })}
                  />
                  <span className="font-mono">{s}</span> <span style={muted}>{SCOPE_TEXT[s]}</span>
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-xs">
              Monthly credit limit
              <input value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value.replace(/\D/g, "") })} placeholder="No limit" aria-label="Monthly credit limit" className="w-24 rounded-lg border bg-transparent px-2 py-1" />
            </label>
            <div className="flex justify-end">
              <button className="rounded-lg px-3 py-1.5 font-medium text-white disabled:opacity-50" style={{ background: "var(--accent)" }} disabled={!form.name.trim() || !form.scopes.length}>
                Create key
              </button>
            </div>
          </form>

          <ul className="divide-y rounded-xl border text-sm">
            {data.keys.length === 0 && (
              <li className="px-4 py-3" style={muted}>
                No keys yet.
              </li>
            )}
            {data.keys.map((k) => (
              <li key={k.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 ${k.revoked ? "opacity-50" : ""}`}>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{k.name}</span> <code className="text-xs" style={muted}>{k.prefix}…</code>
                  <span className="block text-xs" style={muted}>
                    {k.scopes.join(", ")} · {k.usedThisMonth}
                    {k.monthlyLimit ? ` / ${k.monthlyLimit}` : ""} credits this month ·{" "}
                    {k.revoked ? "revoked" : k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}
                  </span>
                </span>
                {!k.revoked && (
                  <button
                    onClick={() => {
                      if (confirm(`Revoke ${k.name}? Clients using it stop working at once.`)) void post({ action: "revoke", id: k.id });
                    }}
                    className="rounded-lg border px-2 py-1 text-xs text-red-500"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>

          <section className="space-y-2 text-sm">
            <h3 className="font-medium">Connect an MCP client</h3>
            <p className="text-xs" style={muted}>
              Server URL: <code>{data.mcpUrl}</code>
            </p>
            <div className="flex gap-1 text-xs" role="tablist">
              {(
                [
                  ["claude-code", "Claude Code"],
                  ["claude-desktop", "Claude Desktop"],
                  ["cursor", "Cursor"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={client === k} onClick={() => setClient(k)} className={`rounded-lg px-2.5 py-1 ${client === k ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}>
                  {label}
                </button>
              ))}
            </div>
            <pre className="overflow-x-auto rounded-xl border p-3 font-mono text-[11px]">{snippets?.[client]}</pre>
            <p className="text-xs" style={muted}>
              {client === "claude-code"
                ? "Run it in a terminal."
                : client === "claude-desktop"
                  ? "Add it to claude_desktop_config.json (Settings → Developer → Edit config), then restart Claude Desktop."
                  : "Add it to ~/.cursor/mcp.json."}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
