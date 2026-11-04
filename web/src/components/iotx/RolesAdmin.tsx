"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MANIFESTS, featuresOf, keyLabel } from "@/lib/iotx/manifests";
import { PLAN_LABEL, PLAN_RANK, openKey, voucherKey, type AppManifest, type Feature, type PlanId } from "@/lib/iotx/types";
import { AppIcon, Icon } from "./icons";
import { useBrand } from "@/components/BrandProvider";

type Role = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: string;
  builtin: string | null;
  template: string | null;
  locked: boolean;
  perms: Record<string, boolean>;
  limits: Record<string, number>;
  scopes: Record<string, string>;
  count: number;
  people: number;
};
type State = {
  plan: PlanId;
  planLabel: string;
  workspaceName: string;
  roles: Role[];
  assignments: { id: string; roleId: string; subjectType: string; subjectId: string }[];
  overrides: { id: string; userId: string; key: string; label: string; effect: string; expiresAt: string | null; expired: boolean; reason: string | null }[];
  members: { userId: string; email: string; name: string | null; role: string; builtin: string }[];
  groups: { id: string; name: string; members: number }[];
  departments: { id: string; name: string; members: number }[];
  templates: { id: string; name: string; description: string }[];
};

async function post(body: Record<string, unknown>) {
  const r = await fetch("/api/permissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Couldn't save that.");
  return d;
}

function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="ix-sw">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} data-perm-switch={label} />
      <i />
    </label>
  );
}

/**
 * Admin → Roles & permissions, generated from the app manifests: roles on
 * the left; per app, the access switch (for the Builder that is the 2-in-1
 * Builder toggle), feature switches and limits, Tally's voucher matrix and
 * data scopes; people and groups; per-person denies and temporary access;
 * and "Preview as" to see the suite as a role before saving.
 */
export default function RolesAdmin() {
  const [s, setS] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [app, setApp] = useState("builder");
  const [tab, setTab] = useState<"perms" | "people" | "exceptions">("perms");
  const [toast, setToast] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const brand = useBrand();

  const load = useCallback(async () => {
    const r = await fetch("/api/permissions?admin=1");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "Couldn't load roles.");
    setS(d);
    setRoleId((id) => id ?? d.roles.find((x: Role) => x.builtin === "member")?.id ?? d.roles[0]?.id);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const role = s?.roles.find((r) => r.id === roleId) ?? null;

  async function act(body: Record<string, unknown>, msg?: string) {
    try {
      const d = await post(body);
      if (msg) setToast(msg);
      await load();
      return d;
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Couldn't save that.");
      await load();
      return null;
    }
  }

  function setPerm(key: string, on: boolean) {
    if (!role || !s) return;
    // Optimistic: flip it now, then save.
    setS({ ...s, roles: s.roles.map((r) => (r.id === role.id ? { ...r, perms: { ...r.perms, [key]: on } } : r)) });
    void act({ action: "updateRole", roleId: role.id, set: { [key]: on } }, `${role.name}: ${keyLabel(key).replace(/\bIOTx\b/g, brand.shortName)} ${on ? "on" : "off"}`);
  }

  if (error)
    return (
      <div className="ix-card" style={{ margin: 20 }}>
        <b>Roles & permissions</b>
        <p className="ix-error">{error}</p>
      </div>
    );
  if (!s || !role) return <div style={{ padding: 24, color: "var(--ix-muted)" }}>Loading roles…</div>;

  return (
    <div className="ix-admin">
      <div className="ix-rolelist" role="tablist" aria-label="Roles">
        <div className="ix-sect ix-hide-phone" style={{ marginTop: 0, padding: "0 10px 6px" }}>
          Roles
        </div>
        {s.roles.map((r) => (
          <button key={r.id} role="tab" aria-selected={r.id === role.id} className={`ix-rolebtn ${r.id === role.id ? "on" : ""}`} onClick={() => setRoleId(r.id)} data-role={r.key}>
            {r.name}
            <span title={`${r.count} switches on`}>{r.count}</span>
          </button>
        ))}
        <div style={{ position: "relative" }}>
          <button className="ix-rolebtn" style={{ color: "var(--accent)" }} onClick={() => setNewOpen((o) => !o)} aria-expanded={newOpen}>
            + New role
          </button>
          {newOpen && (
            <div className="ix-pop" style={{ top: 38, left: 0, right: "auto", width: 270 }}>
              <button
                className="ix-menuitem"
                onClick={async () => {
                  setNewOpen(false);
                  const d = await act({ action: "createRole", name: "New role" }, "Role created. Turn on what it needs.");
                  if (d?.role) setRoleId(d.role.id);
                }}
              >
                Blank role <span className="ix-hint">Ask {brand.shortName} only</span>
              </button>
              <button
                className="ix-menuitem"
                onClick={async () => {
                  setNewOpen(false);
                  const d = await act({ action: "createRole", copyFrom: role.id }, `Copied ${role.name}.`);
                  if (d?.role) setRoleId(d.role.id);
                }}
              >
                Copy of {role.name}
              </button>
              <div className="ix-mlabel">From a template</div>
              {s.templates.map((t) => (
                <button
                  key={t.id}
                  className="ix-menuitem"
                  title={t.description}
                  onClick={async () => {
                    setNewOpen(false);
                    const d = await act({ action: "createRole", template: t.id }, `${t.name} created from its template.`);
                    if (d?.role) setRoleId(d.role.id);
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ix-perm">
        <RoleHeader role={role} s={s} act={act} onDeleted={() => setRoleId(s.roles.find((r) => r.builtin === "member")?.id ?? null)} />
        <div className="ix-tabs" role="tablist">
          {(
            [
              ["perms", "Permissions"],
              ["people", "People & groups"],
              ["exceptions", "Denies & temporary access"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "perms" && <PermsTab role={role} s={s} app={app} setApp={setApp} setPerm={setPerm} act={act} />}
        {tab === "people" && <PeopleTab s={s} act={act} />}
        {tab === "exceptions" && <ExceptionsTab s={s} act={act} />}
      </div>
      {toast && (
        <div className="ix-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function RoleHeader({ role, s, act, onDeleted }: { role: Role; s: State; act: (b: Record<string, unknown>, m?: string) => Promise<unknown>; onDeleted: () => void }) {
  const [name, setName] = useState(role.name);
  useEffect(() => setName(role.name), [role.name, role.id]);
  const kind = role.locked ? "Built-in · always everything" : role.builtin ? "Built-in" : role.kind === "template" ? "From a template" : "Custom role";
  return (
    <>
      <div className="ix-perm-head">
        {role.builtin ? (
          <h2>{role.name}</h2>
        ) : (
          <input
            className="ix-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== role.name && void act({ action: "updateRole", roleId: role.id, name }, "Renamed.")}
            aria-label="Role name"
            style={{ font: "600 18px var(--font-sans)", padding: "2px 8px", maxWidth: 260 }}
          />
        )}
        <span className="ix-chip">{kind}</span>
        <span className="ix-chip muted">Plan: {s.planLabel}</span>
        <span className="ix-chip muted">
          {role.people} {role.people === 1 ? "person" : "people"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="ix-btn"
          id="preview-as"
          onClick={async () => {
            await fetch("/api/permissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", roleId: role.id }) });
            window.location.href = "/home";
          }}
        >
          <Icon name="eye" size={14} /> Preview as {role.name}
        </button>
        {role.builtin && !role.locked && (
          <button className="ix-btn" onClick={() => confirm(`Reset ${role.name} to its defaults?`) && void act({ action: "resetRole", roleId: role.id }, `${role.name} reset.`)}>
            Reset
          </button>
        )}
        {!role.builtin && (
          <button
            className="ix-btn danger"
            onClick={async () => {
              if (!confirm(`Delete the role ${role.name}? People keep their other roles.`)) return;
              await act({ action: "deleteRole", roleId: role.id }, "Role deleted.");
              onDeleted();
            }}
          >
            Delete
          </button>
        )}
      </div>
      {role.description && <p style={{ margin: "6px 0 0", color: "var(--ix-muted)" }}>{role.description}</p>}
    </>
  );
}

function PermsTab({
  role,
  s,
  app,
  setApp,
  setPerm,
  act,
}: {
  role: Role;
  s: State;
  app: string;
  setApp: (a: string) => void;
  setPerm: (k: string, v: boolean) => void;
  act: (b: Record<string, unknown>, m?: string) => Promise<unknown>;
}) {
  const m = MANIFESTS.find((x) => x.id === app)!;
  const open = m.alwaysOpen || !!role.perms[openKey(m.id)];
  return (
    <>
      <div className="ix-apptabs">
        {MANIFESTS.map((x) => (
          <button key={x.id} className={`ix-apptab ${x.id === app ? "on" : ""} ${!x.alwaysOpen && !role.perms[openKey(x.id)] ? "off" : ""}`} onClick={() => setApp(x.id)} data-edit-app={x.id}>
            <AppIcon icon={x.icon} color={x.color} size={18} />
            {x.name}
          </button>
        ))}
      </div>
      {!m.alwaysOpen && (
        <div className={`ix-access ${m.id === "builder" ? "builder" : ""}`}>
          <AppIcon icon={m.icon} color={m.color} size={34} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {m.id === "builder" ? (
              <>
                <b>Builder</b>
                <div className="ix-hint" style={{ fontFamily: "var(--font-sans)" }}>
                  On: the same AI also offers Plan, Build and every builder feature below. Off: Ask and chat only, nothing gets built.
                </div>
              </>
            ) : (
              <>
                <b>Open {m.name}</b>
                <div className="ix-hint" style={{ fontFamily: "var(--font-sans)" }}>
                  When off, it disappears from the sidebar, launcher, search and AI answers.{m.status === "soon" ? " (Coming soon: switches take effect when it joins.)" : ""}
                </div>
              </>
            )}
          </div>
          <Switch checked={open} disabled={role.locked} onChange={(v) => setPerm(openKey(m.id), v)} label={m.id === "builder" ? "Builder" : `Open ${m.name}`} />
        </div>
      )}
      <div style={open ? undefined : { opacity: 0.45, pointerEvents: "none" }} aria-disabled={!open}>
        {m.vouchers && <VoucherMatrix m={m} role={role} setPerm={setPerm} />}
        <FeatureGroups m={m} role={role} plan={s.plan} setPerm={setPerm} act={act} />
        {m.id === "spaces" && <SpacesForRole role={role} />}
        {m.scopes && (
          <div className="ix-fgroup">
            <h5>Data scope</h5>
            {m.scopes.map((sc) => (
              <div className="ix-frow" key={sc.key}>
                <div className="fname">
                  {sc.label}
                  <small>scope: {sc.key}</small>
                </div>
                <select
                  aria-label={sc.label}
                  disabled={role.locked}
                  value={role.scopes[sc.key] ?? sc.options[0]}
                  onChange={(e) => void act({ action: "updateRole", roleId: role.id, scopes: { [sc.key]: e.target.value } }, `${role.name}: ${sc.label} saved`)}
                >
                  {sc.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Which dashboards and folders a role sees. Ticking one gives everyone with the
 * role access to the dashboard or folder itself; the apps inside keep their own rules.
 */
function SpacesForRole({ role }: { role: Role }) {
  type Sp = { id: string; kind: "dashboard" | "folder"; name: string; parentId: string | null; on: boolean; people: number };
  const [list, setList] = useState<Sp[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/spaces?role=${encodeURIComponent(role.id)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setErr(d.error ?? "Couldn't load dashboards and folders.");
    setList(d.spaces);
  }, [role.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const toggle = async (sp: Sp, on: boolean) => {
    setList((l) => l?.map((x) => (x.id === sp.id ? { ...x, on } : x)) ?? null);
    const r = await fetch("/api/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setAccess", id: sp.id, subjectType: "role", subjectId: role.id, on }) });
    if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? "Couldn't save that.");
    window.dispatchEvent(new Event("iotx:spaces"));
    try {
      window.parent?.dispatchEvent(new Event("iotx:spaces"));
    } catch {}
    await load();
  };
  const names = new Map((list ?? []).map((x) => [x.id, x.name]));
  const group = (kind: "dashboard" | "folder", title: string) => {
    const rows = (list ?? []).filter((x) => x.kind === kind);
    return (
      <div className="ix-fgroup" key={kind}>
        <h5>{title}</h5>
        {!rows.length && <div className="ix-hint" style={{ padding: "6px 0" }}>None yet. They are created from the sidebar.</div>}
        {rows.map((sp) => (
          <div className="ix-frow" key={sp.id}>
            <div className="fname">
              {sp.name}
              <small>
                {sp.parentId ? `in ${names.get(sp.parentId) ?? "a folder"}` : "top level"}
                {sp.people ? ` · also shared with ${sp.people} ${sp.people === 1 ? "person" : "people"}` : ""}
              </small>
            </div>
            <Switch checked={role.locked || sp.on} disabled={role.locked} onChange={(v) => void toggle(sp, v)} label={`${role.name} sees ${sp.name}`} />
          </div>
        ))}
      </div>
    );
  };
  if (err) return <p className="ix-error">{err}</p>;
  if (!list) return <div className="ix-hint">Loading dashboards and folders…</div>;
  return (
    <>
      {role.locked && <p className="ix-hint">{role.name} always sees every dashboard and folder.</p>}
      {group("dashboard", "Dashboards this role sees")}
      {group("folder", "Folders this role sees")}
    </>
  );
}

function FeatureGroups({ m, role, plan, setPerm, act }: { m: AppManifest; role: Role; plan: PlanId; setPerm: (k: string, v: boolean) => void; act: (b: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  const groups = useMemo(() => {
    const out = new Map<string, Feature[]>();
    for (const f of m.features) out.set(f.group, [...(out.get(f.group) ?? []), f]);
    return [...out.entries()];
  }, [m]);
  const brand = useBrand();
  // Manifest copy names the AI "IOTx"; show the current brand's name instead.
  const b = (t: string) => t.replace(/\bIOTx\b/g, brand.shortName);
  return (
    <>
      {groups.map(([g, items]) => (
        <div className="ix-fgroup" key={g}>
          <h5>
            {b(g)}
            <span>
              {items.filter((f) => f.type !== "limit" && role.perms[f.key]).length}/{items.filter((f) => f.type !== "limit").length || items.length} on
            </span>
          </h5>
          {items.map((f) => {
            const planLocked = !!f.plan && PLAN_RANK[plan] < PLAN_RANK[f.plan];
            const risk = f.risk ? (
              <>
                {" "}
                <span className="ix-chip risk">risky</span>
              </>
            ) : null;
            if (f.type === "limit") {
              return (
                <div className="ix-frow" key={f.key}>
                  <div className="fname">
                    {f.label}
                    {risk}
                    <small>{f.key}</small>
                  </div>
                  <LimitInput role={role} f={f} act={act} />
                  <span className="ix-hint">{f.unit === "INR" ? "₹" : f.unit}</span>
                </div>
              );
            }
            return (
              <div className="ix-frow" key={f.key}>
                <div className="fname">
                  {b(f.label)}
                  {risk}
                  <small>{f.hint ? `${f.key} · ${f.hint}` : f.key}</small>
                </div>
                {planLocked && <span className="ix-lock">{PLAN_LABEL[f.plan!]} plan · Upgrade</span>}
                <Switch checked={!!role.perms[f.key] && !planLocked} disabled={role.locked || planLocked} onChange={(v) => setPerm(f.key, v)} label={b(f.label)} />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

function LimitInput({ role, f, act }: { role: Role; f: Feature; act: (b: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  const saved = role.limits[f.key];
  const [v, setV] = useState(saved === undefined ? "" : String(saved));
  useEffect(() => setV(saved === undefined ? "" : String(saved)), [saved, role.id]);
  return (
    <input
      type="number"
      min={0}
      value={v}
      disabled={role.locked}
      placeholder="No limit"
      aria-label={`${f.label} (${f.unit})`}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const next = v.trim() === "" ? null : Number(v);
        if ((next ?? undefined) === saved) return;
        void act({ action: "updateRole", roleId: role.id, limits: { [f.key]: next } }, `${role.name}: ${f.label} ${next === null ? "no limit" : next}`);
      }}
    />
  );
}

function VoucherMatrix({ m, role, setPerm }: { m: AppManifest; role: Role; setPerm: (k: string, v: boolean) => void }) {
  const v = m.vouchers!;
  return (
    <div className="ix-fgroup">
      <h5>
        Vouchers<span>per type and action</span>
      </h5>
      <div style={{ overflowX: "auto" }}>
        <table className="ix-vmatrix">
          <thead>
            <tr>
              <th>Voucher type</th>
              {v.actions.map((a) => (
                <th key={a}>{a}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.types.map((t) => (
              <tr key={t}>
                <td>{t}</td>
                {v.actions.map((a) => {
                  const k = voucherKey(t, a);
                  return (
                    <td key={a}>
                      <Switch checked={!!role.perms[k]} disabled={role.locked} onChange={(on) => setPerm(k, on)} label={`${t}: ${a}`} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const BUILTIN_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", guest: "Guest" };

function PeopleTab({ s, act }: { s: State; act: (b: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  const extra = s.roles.filter((r) => !r.builtin);
  const rolesOf = (type: string, id: string) => s.assignments.filter((a) => a.subjectType === type && a.subjectId === id).map((a) => s.roles.find((r) => r.id === a.roleId)!).filter(Boolean);
  const row = (type: "user" | "group" | "department", id: string, label: React.ReactNode, base: string | null) => {
    const has = rolesOf(type, id);
    const free = extra.filter((r) => !has.some((h) => h.id === r.id));
    return (
      <tr key={`${type}:${id}`}>
        <td>{label}</td>
        <td>{base ? <span className="ix-chip muted">{base}</span> : <span className="ix-hint">—</span>}</td>
        <td>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            {has.map((r) => (
              <span key={r.id} className="ix-chip" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                {r.name}
                <button
                  aria-label={`Remove ${r.name}`}
                  onClick={() => void act({ action: "unassign", roleId: r.id, subjectType: type, subjectId: id }, `Removed ${r.name}.`)}
                  style={{ border: 0, background: "none", color: "inherit", cursor: "pointer", padding: 0 }}
                >
                  ×
                </button>
              </span>
            ))}
            {free.length > 0 && (
              <select
                className="ix-input"
                value=""
                aria-label="Add a role"
                onChange={(e) => e.target.value && void act({ action: "assign", roleId: e.target.value, subjectType: type, subjectId: id }, "Role added.")}
              >
                <option value="">+ Add role</option>
                {free.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </td>
      </tr>
    );
  };
  return (
    <>
      <p style={{ color: "var(--ix-muted)", margin: "10px 0" }}>
        Everyone has the built-in role of their workspace membership (change it in Members). Extra roles add up on top. Roles given to a group apply to everyone in it.
      </p>
      {extra.length === 0 && (
        <div className="ix-card" style={{ marginBottom: 12 }}>
          Create a custom role or one from a template (+ New role) to give people more than their built-in role.
        </div>
      )}
      <div className="ix-fgroup">
        <h5>
          People<span>{s.members.length}</span>
        </h5>
        <div style={{ overflowX: "auto" }}>
          <table className="ix-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Built-in role</th>
                <th>Extra roles</th>
              </tr>
            </thead>
            <tbody>
              {s.members.map((m) =>
                row(
                  "user",
                  m.userId,
                  <>
                    <b style={{ display: "block", fontSize: 13 }}>{m.name || m.email}</b>
                    <span className="ix-hint">{m.email}</span>
                  </>,
                  BUILTIN_LABEL[m.builtin] ?? m.role,
                ),
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="ix-fgroup">
        <h5>
          Groups<span>{s.groups.length}</span>
        </h5>
        {s.groups.length === 0 ? (
          <div className="ix-frow" style={{ color: "var(--ix-muted)" }}>
            No groups yet. Make groups in Settings → Members.
          </div>
        ) : (
          <table className="ix-table">
            <tbody>{s.groups.map((g) => row("group", g.id, <b>{g.name}</b>, `${g.members} people`))}</tbody>
          </table>
        )}
      </div>
      <div className="ix-fgroup">
        <h5>
          Departments<span>{s.departments.length}</span>
        </h5>
        {s.departments.length === 0 ? (
          <div className="ix-frow" style={{ color: "var(--ix-muted)" }}>
            No departments yet. Build them in People → Company structure. A role given to a department reaches everyone in it and in its sub-departments.
          </div>
        ) : (
          <table className="ix-table">
            <tbody>{s.departments.map((d) => row("department", d.id, <b>{d.name}</b>, `${d.members} directly · includes sub-departments`))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ExceptionsTab({ s, act }: { s: State; act: (b: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  const brand = useBrand();
  const people = s.members.filter((m) => m.role !== "OWNER");
  const [userId, setUserId] = useState(people[0]?.userId ?? "");
  const [key, setKey] = useState("builder.open");
  const [effect, setEffect] = useState<"deny" | "grant">("grant");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const options = useMemo(
    () =>
      MANIFESTS.map((m) => ({
        app: m.name,
        keys: [...(m.alwaysOpen ? [] : [{ key: openKey(m.id), label: m.id === "builder" ? "Builder (Plan, Build and builder features)" : `Open ${m.name}` }]), ...featuresOf(m).filter((f) => f.type !== "limit").map((f) => ({ key: f.key, label: f.label.replace(/\bIOTx\b/g, brand.shortName) }))],
      })),
    [brand.shortName],
  );
  const who = (id: string) => s.members.find((m) => m.userId === id)?.email ?? id;
  return (
    <>
      <p style={{ color: "var(--ix-muted)", margin: "10px 0" }}>
        A deny wins over every role (for example &quot;never delete vouchers&quot;). A grant gives one person a switch their roles don&apos;t have, until a time you choose (&quot;the SQL editor until Friday&quot;); it ends on its own. The owner always has everything.
      </p>
      <div className="ix-card" style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select className="ix-input" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person">
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name ? `${p.name} (${p.email})` : p.email}
              </option>
            ))}
          </select>
          <select className="ix-input" value={effect} onChange={(e) => setEffect(e.target.value as "deny" | "grant")} aria-label="Deny or grant">
            <option value="grant">Grant</option>
            <option value="deny">Deny</option>
          </select>
          <select className="ix-input" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Permission" style={{ maxWidth: 320 }}>
            {options.map((o) => (
              <optgroup key={o.app} label={o.app}>
                {o.keys.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label className="ix-hint" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            Until
            <input className="ix-input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Until (optional)" />
          </label>
          <input className="ix-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason" style={{ flex: 1, minWidth: 160 }} />
          <button
            className="ix-btn primary"
            disabled={!userId}
            onClick={() =>
              void act(
                { action: "override", userId, key, effect, expiresAt: until ? new Date(until).toISOString() : null, reason },
                `${effect === "deny" ? "Denied" : "Granted"} ${keyLabel(key).replace(/\bIOTx\b/g, brand.shortName)} for ${who(userId)}.`,
              ).then(() => {
                setReason("");
                setUntil("");
              })
            }
          >
            {effect === "deny" ? "Add deny" : "Add grant"}
          </button>
        </div>
      </div>
      <div className="ix-fgroup">
        <h5>
          Exceptions<span>{s.overrides.length}</span>
        </h5>
        {s.overrides.length === 0 ? (
          <div className="ix-frow" style={{ color: "var(--ix-muted)" }}>
            None yet.
          </div>
        ) : (
          s.overrides.map((o) => (
            <div className="ix-frow" key={o.id} style={o.expired ? { opacity: 0.55 } : undefined}>
              <span className={`ix-chip ${o.effect === "deny" ? "risk" : ""}`}>{o.effect === "deny" ? "Deny" : "Grant"}</span>
              <div className="fname">
                {o.label} · {who(o.userId)}
                <small>
                  {o.key}
                  {o.expiresAt ? ` · ${o.expired ? "ended" : "until"} ${new Date(o.expiresAt).toLocaleString()}` : " · no end"}
                  {o.reason ? ` · ${o.reason}` : ""}
                </small>
              </div>
              <button className="ix-btn" onClick={() => void act({ action: "removeOverride", id: o.id }, "Removed.")}>
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
