"use client";

import { useCallback, useEffect, useState } from "react";

type Settings = { enabled: boolean; tokenPrefix: string | null; tokenCreatedAt: string | null; defaultRole: string; groupRoles: Record<string, string>; welcomeEmail: boolean; baseUrl: string; groups: string[] };

/** SCIM provisioning: connect an identity provider that adds and removes members. */
export default function ScimPanel() {
  const [s, setS] = useState<Settings | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [mapText, setMapText] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const muted = { color: "var(--muted)" };

  const apply = (d: Settings) => {
    setS(d);
    setMapText(Object.entries(d.groupRoles).map(([g, r]) => `${g} = ${r.toLowerCase()}`).join("\n"));
  };
  const load = useCallback(() => {
    fetch("/api/workspace/scim")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Only workspace owners and admins can set up provisioning.");
        apply(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function post(body: Record<string, unknown>, msg = "") {
    setError("");
    setNote("");
    const r = await fetch("/api/workspace/scim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "That didn't work");
      return null;
    }
    if (msg) setNote(msg);
    if (d.baseUrl) apply(d);
    else load();
    return d;
  }

  if (error && !s)
    return (
      <p className="text-sm text-red-500" role="alert">
        {error}
      </p>
    );
  if (!s) return null;
  return (
    <div className="space-y-5 text-sm">
      <div>
        <h2 className="text-base font-semibold">Provisioning (SCIM)</h2>
        <p className="mt-1" style={muted}>
          Let your identity provider (Okta, Microsoft Entra ID, OneLogin…) add people to this workspace, set their role
          from their groups, and remove them when they leave.
        </p>
      </div>
      {(note || error) && (
        <p className={error ? "text-red-500" : "text-emerald-600"} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      <section className="space-y-2 rounded-xl border p-4">
        <p>
          SCIM base URL: <code className="text-xs">{s.baseUrl}</code>
        </p>
        {token ? (
          <div className="rounded-lg border border-emerald-500/40 p-2" role="status">
            <p className="text-xs font-medium">Token (shown once): paste it into your identity provider.</p>
            <code className="block break-all text-xs">{token}</code>
          </div>
        ) : (
          <p className="text-xs" style={muted}>
            {s.enabled ? `Token ${s.tokenPrefix}… created ${new Date(s.tokenCreatedAt!).toLocaleString()}.` : "Provisioning is off."}
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={async () => {
              if (s.enabled && !confirm("Make a new token? The current one stops working at once.")) return;
              const d = await post({ action: "rotate" });
              if (d?.token) setToken(d.token);
            }}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
            style={{ background: "var(--accent)" }}
          >
            {s.enabled ? "Rotate token" : "Turn on and create a token"}
          </button>
          {s.enabled && (
            <button onClick={() => { setToken(null); void post({ action: "disable" }, "Provisioning is off."); }} className="rounded-lg border px-3 py-1.5 text-xs">
              Turn off
            </button>
          )}
        </div>
      </section>
      <section className="space-y-3 rounded-xl border p-4">
        <label className="flex items-center gap-2">
          Default role for new people
          <select value={s.defaultRole} onChange={(e) => void post({ action: "settings", defaultRole: e.target.value }, "Saved.")} className="rounded-lg border bg-transparent px-2 py-1 text-xs">
            <option value="ADMIN">Admin</option>
            <option value="MEMBER">Member</option>
            <option value="VIEWER">Viewer</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.welcomeEmail} onChange={(e) => void post({ action: "settings", welcomeEmail: e.target.checked }, "Saved.")} />
          Send a welcome email to new people
        </label>
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            const groupRoles = Object.fromEntries(
              mapText
                .split("\n")
                .map((l) => l.split("="))
                .filter((p) => p.length === 2 && p[0].trim())
                .map(([g, r]) => [g.trim(), r.trim().toUpperCase()]),
            );
            void post({ action: "settings", groupRoles }, "Group roles saved.");
          }}
        >
          <span className="block">Group → role (one per line, highest role wins)</span>
          <textarea value={mapText} onChange={(e) => setMapText(e.target.value)} rows={4} placeholder={"Engineering = member\nIT Admins = admin"} aria-label="Group to role mapping" className="w-full rounded-lg border bg-transparent p-2 font-mono text-xs" />
          {s.groups.length > 0 && (
            <span className="block text-xs" style={muted}>
              Groups your provider has sent: {s.groups.join(", ")}
            </span>
          )}
          <button className="rounded-lg border px-3 py-1.5 text-xs">Save group roles</button>
        </form>
      </section>
    </div>
  );
}
