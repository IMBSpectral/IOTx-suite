"use client";

import { useEffect, useState } from "react";
import { Plug } from "lucide-react";

type Info = { cloud: boolean; enabled: boolean; url: string; createdAt: string | null };

/** The app's MCP server: lets AI clients read and add the app's data with a token. */
export default function McpServerCard({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/mcp`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setInfo(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, version]);

  async function act(action: "enable" | "rotate" | "disable") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(d.error ?? "That didn't work.");
    setToken(d.token ?? null);
    setVersion((v) => v + 1);
  }

  if (!info?.cloud) return null;
  const muted = { color: "var(--muted)" };
  return (
    <section aria-label="MCP server" className="rounded-xl border p-4 text-xs" style={{ background: "var(--panel)" }}>
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Plug className="h-4 w-4" /> MCP server
        </p>
        {info.enabled ? (
          <span className="flex gap-1.5">
            <button onClick={() => act("rotate")} disabled={busy} className="rounded-md border px-2 py-0.5">
              New token
            </button>
            <button onClick={() => act("disable")} disabled={busy} className="rounded-md px-2 py-0.5 text-red-500 hover:bg-red-500/[.08]">
              Turn off
            </button>
          </span>
        ) : (
          <button onClick={() => act("enable")} disabled={busy} className="btn-primary rounded-md px-2.5 py-1">
            Turn on
          </button>
        )}
      </div>
      <p className="mt-1" style={muted}>
        Let AI assistants like Claude or Cursor read and add your app&apos;s data. Every request needs the token; tools: list tables, query a table, add a row.
      </p>
      {info.enabled && (
        <div className="mt-2 space-y-1.5">
          <p>
            URL <code className="select-all break-all rounded bg-black/[.05] px-1 dark:bg-white/[.08]">{info.url}</code>
          </p>
          {token ? (
            <p role="status">
              Token (shown once; copy it now){" "}
              <code className="select-all break-all rounded bg-black/[.05] px-1 dark:bg-white/[.08]">{token}</code>{" "}
              <button onClick={() => void navigator.clipboard.writeText(token)} className="underline">
                Copy
              </button>
            </p>
          ) : (
            <p style={muted}>The token was shown when it was created. Make a new one if you&apos;ve lost it; the old one stops working.</p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
