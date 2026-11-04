"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type Data = {
  audience: string;
  inherited: { email: string; name: string | null; source: string }[];
  viewers: { id: string; email: string }[];
};

/**
 * People who can open a non-public site. Inherited access (workspace,
 * project sharing) is shown but managed elsewhere; site-only viewers can be
 * added and removed here.
 */
export default function SiteMembers({ projectId, audience, canManage }: { projectId: string; audience: string; canManage: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [version, setVersion] = useState(0);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/site-viewers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setData(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, audience, version]);

  async function call(method: "POST" | "DELETE", body: unknown) {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/site-viewers`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) setError(d.error ?? "Something went wrong");
    setVersion((v) => v + 1);
    return res.ok;
  }

  if (!data) return null;
  const inheritedNote = "Access comes from project sharing and can't be removed here";
  return (
    <div className="rounded-lg border p-2.5 text-xs" aria-label="People who can open the site">
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {data.inherited.map((p) => (
          <li key={`${p.email}-${p.source}`} className="flex items-center justify-between gap-2" title={p.source === "Project sharing" ? inheritedNote : "Access comes from the workspace and can't be removed here"}>
            <span className="truncate">{p.name ?? p.email}</span>
            <span className="shrink-0" style={{ color: "var(--muted)" }}>{p.source}</span>
          </li>
        ))}
        {data.viewers.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-2">
            <span className="truncate">{v.email}</span>
            <span className="flex shrink-0 items-center gap-1" style={{ color: "var(--muted)" }}>
              Site only
              {canManage && (
                <button onClick={() => call("DELETE", { viewerId: v.id })} aria-label={`Remove ${v.email}`} className="rounded p-0.5 hover:bg-black/[.05] dark:hover:bg-white/[.08]">
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {canManage && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await call("POST", { email })) setEmail("");
          }}
        >
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="Add someone who can only open the site"
            aria-label="Email of someone who can open the site"
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1"
          />
          <button disabled={!email.trim()} className="rounded-md border px-2 py-1 disabled:opacity-50">
            Add
          </button>
        </form>
      )}
      {error && <p role="alert" className="mt-1 text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
