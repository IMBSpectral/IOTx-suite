"use client";

import { useCallback, useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";

type Org = {
  id: string;
  name: string;
  avatar: string | null;
  settings: { cloudAutoApprove?: boolean; previewSharing?: string; publishRequiresApproval?: boolean };
  enforced: string[];
  admins: { id: string; email: string; name: string | null }[];
  workspaces: { id: string; name: string; plan: string; members: number; projects: number }[];
};
type AuditRow = { id: string; kind: string; detail: string; actor: string; at: string; workspace: string };

const SETTINGS: { key: keyof Org["settings"]; label: string; options: [string, string][] }[] = [
  { key: "cloudAutoApprove", label: "Agent sets up {brand} Cloud", options: [["true", "Automatically"], ["false", "After approval"]] },
  { key: "previewSharing", label: "Preview links", options: [["anyone", "Anyone with the link"], ["password", "Password required"], ["signin", "Sign-in only"], ["off", "Off"]] },
  { key: "publishRequiresApproval", label: "Members publishing", options: [["false", "Can publish"], ["true", "Need an admin's approval"]] },
];

/** Organization admin: name, admins, workspaces, standardized settings, audit log. */
export default function OrgPanel() {
  const brand = useBrand();
  const [data, setData] = useState<{ org: Org | { id: string; name: string } | null; admin?: boolean; canCreate?: boolean } | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [form, setForm] = useState({ name: "", admin: "", workspace: "" });
  const [std, setStd] = useState<{ settings: Record<string, string>; enforced: string[] }>({ settings: {}, enforced: [] });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const muted = { color: "var(--muted)" };

  const load = useCallback(() => {
    fetch("/api/org")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        if (d.admin) {
          const o = d.org as Org;
          setStd({ settings: Object.fromEntries(Object.entries(o.settings).map(([k, v]) => [k, String(v)])), enforced: o.enforced });
          fetch("/api/org?view=audit")
            .then((r) => r.json())
            .then((a) => setAudit(a.events ?? []));
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function post(body: Record<string, unknown>, msg: string) {
    setError("");
    setNote("");
    const r = await fetch("/api/org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "That didn't work");
      return false;
    }
    setNote(msg);
    load();
    return true;
  }

  if (!data) return null;
  const banner = (note || error) && (
    <p className={`text-sm ${error ? "text-red-500" : "text-emerald-600"}`} role={error ? "alert" : "status"}>
      {error || note}
    </p>
  );

  if (!data.org) {
    return (
      <div className="space-y-3 text-sm">
        <h2 className="text-base font-semibold">Organization</h2>
        <p style={muted}>Bring several workspaces under one organization with shared admins, standard settings and one audit log.</p>
        {banner}
        {data.canCreate ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void post({ action: "create", name: form.name }, "Organization created."); }}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Organization name" aria-label="Organization name" className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" />
            <button className="rounded-lg px-3 py-2 font-medium text-white" style={{ background: "var(--accent)" }}>
              Create organization
            </button>
          </form>
        ) : (
          <p style={muted}>Only the workspace owner can create one.</p>
        )}
      </div>
    );
  }
  if (!data.admin) {
    return (
      <p className="text-sm" style={muted}>
        This workspace belongs to {data.org.name}. Its admins manage organization settings.
      </p>
    );
  }
  const org = data.org as Org;
  return (
    <div className="space-y-6 text-sm">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl border text-lg">{org.avatar || org.name.charAt(0)}</span>
        <div>
          <h2 className="text-base font-semibold">{org.name}</h2>
          <p className="text-xs" style={muted}>
            {org.workspaces.length} workspace{org.workspaces.length === 1 ? "" : "s"} · {org.admins.length} admin{org.admins.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      {banner}
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void post({ action: "update", name: (e.currentTarget.elements.namedItem("n") as HTMLInputElement).value, avatar: (e.currentTarget.elements.namedItem("a") as HTMLInputElement).value }, "Saved."); }}>
        <input name="a" defaultValue={org.avatar ?? ""} placeholder="🏢" aria-label="Avatar (emoji)" className="w-14 rounded-lg border bg-transparent px-2 py-2 text-center" />
        <input name="n" defaultValue={org.name} aria-label="Organization name" className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" />
        <button className="rounded-lg border px-3 py-2">Save</button>
      </form>

      <section className="space-y-2">
        <h3 className="font-medium">Admins</h3>
        <ul className="divide-y rounded-xl border">
          {org.admins.map((a) => (
            <li key={a.id} className="flex items-center justify-between px-4 py-2">
              <span>
                {a.name ?? a.email} <span style={muted}>{a.email}</span>
              </span>
              <button onClick={() => void post({ action: "removeAdmin", userId: a.id }, "Admin removed.")} className="text-xs text-red-500">
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void post({ action: "addAdmin", email: form.admin }, `${form.admin} is an admin.`).then((ok) => ok && setForm({ ...form, admin: "" })); }}>
          <input value={form.admin} onChange={(e) => setForm({ ...form, admin: e.target.value })} placeholder="Email of someone in the organization" aria-label="New admin email" className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" />
          <button className="rounded-lg border px-3 py-2">Add admin</button>
        </form>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Workspaces</h3>
        <ul className="divide-y rounded-xl border">
          {org.workspaces.map((w) => (
            <li key={w.id} className="flex items-center justify-between px-4 py-2">
              <span>
                {w.name}{" "}
                <span className="text-xs" style={muted}>
                  {w.plan.toLowerCase()} · {w.members} members · {w.projects} projects
                </span>
              </span>
              <button
                onClick={() => {
                  if (confirm(`Take ${w.name} out of the organization? It keeps its projects; organization settings stop applying.`)) void post({ action: "removeWorkspace", workspaceId: w.id }, `${w.name} left the organization.`);
                }}
                className="text-xs text-red-500"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void post({ action: "createWorkspace", name: form.workspace }, `Workspace ${form.workspace} created.`).then((ok) => ok && setForm({ ...form, workspace: "" })); }}>
          <input value={form.workspace} onChange={(e) => setForm({ ...form, workspace: e.target.value })} placeholder="New workspace name" aria-label="New workspace name" className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" />
          <button className="rounded-lg border px-3 py-2">Create workspace</button>
        </form>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Standard settings</h3>
        <p className="text-xs" style={muted}>
          Applied to every workspace when you save. Enforced settings can&apos;t be changed inside a workspace.
        </p>
        <div className="divide-y rounded-xl border">
          {SETTINGS.map((s) => (
            <div key={s.key} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <span className="flex-1">{s.label.replace("{brand}", brand.shortName)}</span>
              <select
                value={std.settings[s.key] ?? ""}
                onChange={(e) => setStd({ ...std, settings: { ...std.settings, [s.key]: e.target.value } })}
                aria-label={s.label.replace("{brand}", brand.shortName)}
                className="rounded-lg border bg-transparent px-2 py-1 text-xs"
              >
                <option value="">Each workspace decides</option>
                {s.options.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  disabled={!std.settings[s.key]}
                  checked={std.enforced.includes(s.key)}
                  onChange={(e) => setStd({ ...std, enforced: e.target.checked ? [...std.enforced, s.key] : std.enforced.filter((k) => k !== s.key) })}
                />
                Enforce
              </label>
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            const settings = Object.fromEntries(
              Object.entries(std.settings)
                .filter(([, v]) => v !== "")
                .map(([k, v]) => [k, v === "true" ? true : v === "false" ? false : v]),
            );
            void post({ action: "standards", settings, enforced: std.enforced }, "Standard settings applied to every workspace.");
          }}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
          style={{ background: "var(--accent)" }}
        >
          Apply to all workspaces
        </button>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Audit log</h3>
        <ul className="max-h-96 divide-y overflow-auto rounded-xl border text-xs">
          {audit?.length === 0 && (
            <li className="px-4 py-3" style={muted}>
              No events yet.
            </li>
          )}
          {audit?.map((e) => (
            <li key={e.id} className="px-4 py-2">
              <span className="font-medium">{e.workspace}</span> · {e.detail}
              <span className="block" style={muted}>
                {e.actor} · {e.kind} · {new Date(e.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
