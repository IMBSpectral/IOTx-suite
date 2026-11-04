"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { useTabTitle } from "./tabs";

type Dept = { id: string; name: string; parentId: string | null; headId: string | null; color: string | null; order: number };
type Person = {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  joinedWorkspace: string;
  mfa: boolean;
  departmentId: string | null;
  managerId: string | null;
  title: string | null;
  location: string | null;
  phone: string | null;
  employeeCode: string | null;
  joinedOn: string | null;
  hr: boolean;
};
type Data = { departments: Dept[]; people: Person[]; canEdit: boolean; me: string };

const COLORS = ["#6366f1", "#0d9488", "#ea580c", "#db2777", "#0891b2", "#65a30d", "#ca8a04", "#7c3aed"];
const ROLE: Record<string, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "Viewer", GUEST: "Guest" };
const nameOf = (p?: Person | null) => (p ? p.name || p.email.split("@")[0] : "");
const initials = (p?: Person | null) =>
  nameOf(p)
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

function Avatar({ p, size = 28 }: { p?: Person | null; size?: number }) {
  if (p?.image) return <img className="ix-ppl-av" src={p.image} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  return (
    <span className="ix-ppl-av" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initials(p)}
    </span>
  );
}

/** Everything under a department, itself included. */
const under = (depts: Dept[], id: string) => {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of depts) if (d.parentId && out.has(d.parentId) && !out.has(d.id)) out.add(d.id), (grew = true);
  }
  return out;
};
const pathOf = (depts: Dept[], id: string | null) => {
  const out: string[] = [];
  for (let d = depts.find((x) => x.id === id); d && out.length < 8; d = depts.find((x) => x.id === d!.parentId)) out.unshift(d.name);
  return out.join(" › ");
};

/**
 * People: the company structure (departments as an org chart, with heads,
 * drag-and-drop for people and departments) and the employee directory
 * (search, filters, paging, bulk move, CSV). Owners and admins edit; everyone
 * else sees it, with HR details only for themselves and their reports.
 */
export default function CompanyStructure({ initialTab = "chart" }: { initialTab?: "chart" | "people" | "team" | "timeoff" | "worktime" | "reports" }) {
  useTabTitle("People");
  const [tab, setTab] = useState(initialTab);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: "dept"; dept: Partial<Dept> } | { kind: "person"; userId: string } | { kind: "add" } | { kind: "setup" } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/structure", { cache: "no-store" }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (!r?.ok || !d) return setError(d?.error ?? "Couldn't load the company structure.");
    setError(null);
    setData(d);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const act = useCallback(
    async (body: Record<string, unknown>, ok?: string) => {
      const r = await fetch("/api/structure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      if (!r?.ok) {
        setNote(d.error ?? "That didn't work. Try again.");
        return false;
      }
      if (ok) setNote(ok);
      await load();
      return true;
    },
    [load],
  );
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(t);
  }, [note]);

  if (error) return <p className="ix-error" style={{ padding: 24 }}>{error}</p>;
  if (!data) return <div style={{ padding: 24, color: "var(--ix-muted)" }}>Loading the company structure…</div>;

  return (
    <div className="ix-ppl">
      <header className="ix-ppl-head">
        <div>
          <h1>People</h1>
          <p>
            {data.people.length} {data.people.length === 1 ? "person" : "people"} · {data.departments.length} {data.departments.length === 1 ? "department" : "departments"}
          </p>
        </div>
        <div className="ix-seg" role="group" aria-label="View">
          <button type="button" aria-pressed={tab === "chart"} onClick={() => setTab("chart")}>
            Company structure
          </button>
          <button type="button" aria-pressed={tab === "people"} onClick={() => setTab("people")}>
            Employees
          </button>
          <button type="button" aria-pressed={tab === "team"} onClick={() => setTab("team")}>
            My team
          </button>
          <button type="button" aria-pressed={tab === "timeoff"} onClick={() => setTab("timeoff")}>
            Time off
          </button>
          <button type="button" aria-pressed={tab === "worktime"} onClick={() => setTab("worktime")}>
            Work time
          </button>
          <button type="button" aria-pressed={tab === "reports"} onClick={() => setTab("reports")}>
            Reports
          </button>
        </div>
        {data.canEdit && (
          <>
            <button type="button" className="ix-btn" onClick={() => setEditing({ kind: "setup" })} title="Company name, departments, people and roles in one go">
              <Icon name="sparkle" size={14} /> Set up
            </button>
            <button type="button" className="ix-btn" onClick={() => setEditing({ kind: "dept", dept: { parentId: null } })}>
              <Icon name="add" size={14} /> Department
            </button>
            <button type="button" className="ix-btn primary" onClick={() => setEditing({ kind: "add" })}>
              <Icon name="people" size={14} /> Add people
            </button>
          </>
        )}
      </header>
      {note && (
        <div className="ix-ppl-note" role="status">
          {note}
        </div>
      )}
      {tab === "chart" ? (
        <OrgChart data={data} act={act} onEdit={setEditing} />
      ) : tab === "people" ? (
        <Directory data={data} act={act} onOpen={(userId) => setEditing({ kind: "person", userId })} />
      ) : tab === "team" ? (
        <MyTeam data={data} onOpen={(userId) => setEditing({ kind: "person", userId })} />
      ) : tab === "timeoff" ? (
        <TimeOff data={data} />
      ) : tab === "worktime" ? (
        <WorkTime data={data} />
      ) : (
        <Reports data={data} />
      )}
      {editing?.kind === "dept" && <DeptEditor data={data} dept={editing.dept} act={act} onClose={() => setEditing(null)} />}
      {editing?.kind === "person" && <PersonPanel data={data} userId={editing.userId} act={act} onClose={() => setEditing(null)} />}
      {editing?.kind === "add" && <AddPeople data={data} reload={load} onClose={() => setEditing(null)} />}
      {editing?.kind === "setup" && <OrgSetup data={data} reload={load} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ── Org chart ────────────────────────────────────────────────────────────────

type Act = (b: Record<string, unknown>, ok?: string) => Promise<boolean>;

function OrgChart({ data, act, onEdit }: { data: Data; act: Act; onEdit: (e: { kind: "dept"; dept: Partial<Dept> } | { kind: "person"; userId: string } | { kind: "setup" }) => void }) {
  const { departments: depts, people, canEdit } = data;
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [over, setOver] = useState<string | null>(null);
  const kids = (id: string | null) => depts.filter((d) => d.parentId === id);
  const roots = kids(null);
  const loose = people.filter((p) => !p.departmentId);

  const drop = async (e: React.DragEvent, target: string | null) => {
    e.preventDefault();
    setOver(null);
    const raw = e.dataTransfer.getData("text/plain");
    const [kind, id] = raw.split(":");
    if (kind === "person" && id) {
      const p = people.find((x) => x.userId === id);
      if (p?.departmentId === target) return;
      await act({ action: "move", userIds: [id], departmentId: target }, `${nameOf(p)} moved to ${target ? depts.find((d) => d.id === target)?.name : "no department"}.`);
    } else if (kind === "dept" && id && id !== target) {
      await act({ action: "updateDept", id, parentId: target }, "Department moved.");
    }
  };
  const dropProps = (target: string | null) =>
    canEdit
      ? {
          onDragOver: (e: React.DragEvent) => (e.preventDefault(), setOver(target ?? "__root")),
          onDragLeave: () => setOver(null),
          onDrop: (e: React.DragEvent) => void drop(e, target),
        }
      : {};

  const Node = ({ d }: { d: Dept }) => {
    const head = people.find((p) => p.userId === d.headId);
    const direct = people.filter((p) => p.departmentId === d.id);
    const all = under(depts, d.id);
    const total = people.filter((p) => p.departmentId && all.has(p.departmentId)).length;
    const children = kids(d.id);
    const color = d.color || COLORS[depts.indexOf(d) % COLORS.length];
    const expanded = open.has(d.id);
    return (
      <li>
        <div
          className={`ix-org-card ${over === d.id ? "over" : ""}`}
          style={{ ["--dc" as string]: color }}
          draggable={canEdit}
          onDragStart={(e) => e.dataTransfer.setData("text/plain", `dept:${d.id}`)}
          {...dropProps(d.id)}
        >
          <div className="ix-org-top">
            <b title={d.name}>{d.name}</b>
            {canEdit && (
              <span className="ix-org-tools">
                <button type="button" title="Add a sub-department" aria-label={`Add a sub-department to ${d.name}`} onClick={() => onEdit({ kind: "dept", dept: { parentId: d.id } })}>
                  <Icon name="add" size={13} />
                </button>
                <button type="button" title="Edit department" aria-label={`Edit ${d.name}`} onClick={() => onEdit({ kind: "dept", dept: d })}>
                  <Icon name="edit" size={13} />
                </button>
              </span>
            )}
          </div>
          {head ? (
            <button type="button" className="ix-org-head" onClick={() => onEdit({ kind: "person", userId: head.userId })}>
              <Avatar p={head} size={30} />
              <span>
                <b>{nameOf(head)}</b>
                <small>{head.title || "Head of department"}</small>
              </span>
            </button>
          ) : (
            <div className="ix-org-nohead">No head yet</div>
          )}
          <button type="button" className="ix-org-count" onClick={() => setOpen((s) => (s.has(d.id) ? (s.delete(d.id), new Set(s)) : new Set(s.add(d.id))))} aria-expanded={expanded}>
            <Icon name="people" size={13} /> {direct.length} here{total > direct.length ? ` · ${total} in all` : ""}
            <Icon name="chevron" size={12} />
          </button>
          {expanded && (
            <div className="ix-org-people">
              {direct.length === 0 && <small className="dim">{canEdit ? "Drag people here." : "No one here directly."}</small>}
              {direct.map((p) => (
                <button
                  key={p.userId}
                  type="button"
                  className="ix-org-chip"
                  draggable={canEdit}
                  onDragStart={(e) => (e.stopPropagation(), e.dataTransfer.setData("text/plain", `person:${p.userId}`))}
                  onClick={() => onEdit({ kind: "person", userId: p.userId })}
                  title={p.title ?? p.email}
                >
                  <Avatar p={p} size={20} /> {nameOf(p)}
                </button>
              ))}
            </div>
          )}
        </div>
        {children.length > 0 && (
          <ul>
            {children.map((c) => (
              <Node key={c.id} d={c} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="ix-org-wrap">
      {depts.length === 0 ? (
        <div className="ix-card ix-org-empty">
          <h2>Build your company structure</h2>
          <p>Add departments (for example Management → Plant → Production → Shift A), give each a head, then drag people into them. Roles given to a department in Admin reach everyone in it.</p>
          {canEdit ? (
            <div className="ix-org-starters">
              <button type="button" className="ix-btn primary" onClick={() => onEdit({ kind: "setup" })}>
                <Icon name="sparkle" size={14} /> Set up your organisation
              </button>
              {[
                ["Management", "Sales", "Accounts", "Production", "HR"],
                ["Leadership", "Engineering", "Design", "Marketing", "Operations"],
              ].map((set) => (
                <button key={set[0]} type="button" className="ix-btn" onClick={async () => { for (const name of set) await act({ action: "createDept", name }); }}>
                  Start with {set.join(", ")}
                </button>
              ))}
            </div>
          ) : (
            <p className="dim">Ask an owner or admin to set it up.</p>
          )}
        </div>
      ) : (
        <div className="ix-org-scroll">
          <ul className="ix-org">
            <li>
              <div className={`ix-org-root ${over === "__root" ? "over" : ""}`} {...dropProps(null)}>
                <Icon name="dashboard" size={15} /> Company
              </div>
              <ul>
                {roots.map((d) => (
                  <Node key={d.id} d={d} />
                ))}
              </ul>
            </li>
          </ul>
        </div>
      )}
      {loose.length > 0 && (
        <section className={`ix-card ix-org-loose ${over === "__root" ? "over" : ""}`} {...dropProps(null)}>
          <h2>
            Not in a department <span>{loose.length}</span>
          </h2>
          {canEdit && <p className="dim">Drag a person onto a department card to place them.</p>}
          <div className="ix-org-people">
            {loose.map((p) => (
              <button
                key={p.userId}
                type="button"
                className="ix-org-chip"
                draggable={canEdit}
                onDragStart={(e) => e.dataTransfer.setData("text/plain", `person:${p.userId}`)}
                onClick={() => onEdit({ kind: "person", userId: p.userId })}
              >
                <Avatar p={p} size={20} /> {nameOf(p)}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Employee directory ───────────────────────────────────────────────────────

function Directory({ data, act, onOpen }: { data: Data; act: Act; onOpen: (userId: string) => void }) {
  const { departments: depts, people, canEdit } = data;
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [moveTo, setMoveTo] = useState("");
  const byId = useMemo(() => new Map(people.map((p) => [p.userId, p])), [people]);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const inDept = dept === "none" ? null : dept ? under(depts, dept) : null;
    return people.filter(
      (p) =>
        (!t || `${p.name ?? ""} ${p.email} ${p.title ?? ""} ${p.employeeCode ?? ""} ${p.location ?? ""}`.toLowerCase().includes(t)) &&
        (!dept || (dept === "none" ? !p.departmentId : !!p.departmentId && inDept!.has(p.departmentId))) &&
        (!role || p.role === role),
    );
  }, [people, depts, q, dept, role]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(page, pages);
  const shown = rows.slice((at - 1) * size, at * size);
  const allPicked = shown.length > 0 && shown.every((p) => picked.has(p.userId));

  const csv = () => {
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["Name", "Email", "Title", "Department", "Manager", "Role", "Employee code", "Phone", "Location", "Joined on", "Two-step sign-in"];
    const lines = rows.map((p) =>
      [nameOf(p), p.email, p.title, pathOf(depts, p.departmentId), nameOf(byId.get(p.managerId ?? "")), ROLE[p.role] ?? p.role, p.employeeCode, p.phone, p.location, p.joinedOn, p.mfa ? "On" : "Off"].map(cell).join(","),
    );
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `employees-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="ix-card ix-ppl-dir">
      <div className="ix-usage-filters">
        <div className="ix-usage-search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} placeholder="Search name, email, title, code or location" aria-label="Search employees" />
        </div>
        <select className="ix-usage-select" value={dept} onChange={(e) => (setDept(e.target.value), setPage(1))} aria-label="Department">
          <option value="">All departments</option>
          <option value="none">Not in a department</option>
          {depts.map((d) => (
            <option key={d.id} value={d.id}>
              {pathOf(depts, d.id)}
            </option>
          ))}
        </select>
        <select className="ix-usage-select" value={role} onChange={(e) => (setRole(e.target.value), setPage(1))} aria-label="Role">
          <option value="">All roles</option>
          {Object.entries(ROLE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button type="button" className="ix-btn" onClick={csv}>
          <Icon name="insert" size={14} /> Export CSV
        </button>
      </div>

      {canEdit && picked.size > 0 && (
        <div className="ix-ppl-bulk">
          <b>{picked.size} selected</b>
          <select className="ix-usage-select" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move to department">
            <option value="">Change department to…</option>
            <option value="none">No department</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {pathOf(depts, d.id)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ix-btn primary"
            disabled={!moveTo}
            onClick={async () => {
              if (await act({ action: "move", userIds: [...picked], departmentId: moveTo === "none" ? null : moveTo }, `Moved ${picked.size} ${picked.size === 1 ? "person" : "people"}.`)) {
                setPicked(new Set());
                setMoveTo("");
              }
            }}
          >
            Move
          </button>
          <button type="button" className="ix-btn" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      )}

      <div className="ix-usage-tablewrap">
        <table className="ix-usage-table ix-ppl-table">
          <thead>
            <tr>
              {canEdit && (
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select everyone on this page"
                    checked={allPicked}
                    onChange={() => setPicked((s) => {
                      const n = new Set(s);
                      for (const p of shown) allPicked ? n.delete(p.userId) : n.add(p.userId);
                      return n;
                    })}
                  />
                </th>
              )}
              <th>Employee</th>
              <th>Department</th>
              <th>Manager</th>
              <th>Role</th>
              <th>Joined</th>
              <th>Two-step</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const mgr = byId.get(p.managerId ?? "");
              const head = depts.find((d) => d.headId === p.userId);
              return (
                <tr key={p.userId} onClick={() => onOpen(p.userId)}>
                  {canEdit && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${nameOf(p)}`}
                        checked={picked.has(p.userId)}
                        onChange={() => setPicked((s) => {
                          const n = new Set(s);
                          if (n.has(p.userId)) n.delete(p.userId);
                          else n.add(p.userId);
                          return n;
                        })}
                      />
                    </td>
                  )}
                  <td>
                    <div className="ix-ppl-who">
                      <Avatar p={p} size={32} />
                      <span>
                        <b>
                          {nameOf(p)}
                          {p.userId === data.me && <em> · you</em>}
                        </b>
                        <small>{p.title || p.email}</small>
                      </span>
                    </div>
                  </td>
                  <td>
                    {p.departmentId ? pathOf(depts, p.departmentId) : <span className="dim">—</span>}
                    {head && <div className="ix-ppl-headtag">Head of {head.name}</div>}
                  </td>
                  <td>{mgr ? nameOf(mgr) : <span className="dim">—</span>}</td>
                  <td>
                    <span className={`ix-ppl-role r-${p.role.toLowerCase()}`}>{ROLE[p.role] ?? p.role}</span>
                  </td>
                  <td className="nowrap">{new Date(p.joinedOn ? `${p.joinedOn}T00:00:00Z` : p.joinedWorkspace).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: p.joinedOn ? "UTC" : undefined })}</td>
                  <td>{p.mfa ? <span className="ix-ppl-ok">On</span> : <span className="dim">Off</span>}</td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={canEdit ? 7 : 6} className="empty">
                  No one matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="ix-usage-pager">
        <span className="dim">
          {rows.length} {rows.length === 1 ? "person" : "people"} · page {at} of {pages}
        </span>
        <select className="ix-usage-select" value={size} onChange={(e) => (setSize(Number(e.target.value)), setPage(1))} aria-label="Rows per page">
          {[20, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>
        <button type="button" className="ix-btn" disabled={at <= 1} onClick={() => setPage(at - 1)}>
          Previous
        </button>
        <button type="button" className="ix-btn" disabled={at >= pages} onClick={() => setPage(at + 1)}>
          Next
        </button>
      </footer>
    </section>
  );
}

// ── Editors ──────────────────────────────────────────────────────────────────

function DeptEditor({ data, dept, act, onClose }: { data: Data; dept: Partial<Dept>; act: Act; onClose: () => void }) {
  const [name, setName] = useState(dept.name ?? "");
  const [parentId, setParentId] = useState(dept.parentId ?? "");
  const [headId, setHeadId] = useState(dept.headId ?? "");
  const [color, setColor] = useState(dept.color ?? "");
  const [sure, setSure] = useState(false);
  const blocked = dept.id ? under(data.departments, dept.id) : new Set<string>();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name, parentId: parentId || null, headId: headId || null, color: color || null };
    if (await act(dept.id ? { action: "updateDept", id: dept.id, ...body } : { action: "createDept", ...body }, dept.id ? "Department saved." : `Created ${name}.`)) onClose();
  };
  return (
    <div className="ix-ppl-drawer" role="dialog" aria-label={dept.id ? `Edit ${dept.name}` : "New department"}>
      <form onSubmit={save}>
        <header>
          <b>{dept.id ? "Edit department" : "New department"}</b>
          <button type="button" className="ix-act" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </label>
        <label>
          Inside
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">The company (top level)</option>
            {data.departments
              .filter((d) => !blocked.has(d.id))
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {pathOf(data.departments, d.id)}
                </option>
              ))}
          </select>
        </label>
        <label>
          Head of department
          <select value={headId} onChange={(e) => setHeadId(e.target.value)}>
            <option value="">No head yet</option>
            {data.people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {nameOf(p)} ({p.email})
              </option>
            ))}
          </select>
        </label>
        <div className="ix-ppl-colors" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
        <footer>
          <button type="submit" className="ix-btn primary">
            {dept.id ? "Save" : "Create"}
          </button>
          {dept.id &&
            (sure ? (
              <button type="button" className="ix-btn danger" onClick={async () => (await act({ action: "deleteDept", id: dept.id }, `Deleted ${dept.name}.`)) && onClose()}>
                Delete: people and sub-departments move up a level
              </button>
            ) : (
              <button type="button" className="ix-btn danger" onClick={() => setSure(true)}>
                Delete…
              </button>
            ))}
        </footer>
      </form>
    </div>
  );
}

function PersonPanel({ data, userId, act, onClose }: { data: Data; userId: string; act: Act; onClose: () => void }) {
  const p = data.people.find((x) => x.userId === userId);
  const [f, setF] = useState({
    title: p?.title ?? "",
    departmentId: p?.departmentId ?? "",
    managerId: p?.managerId ?? "",
    phone: p?.phone ?? "",
    employeeCode: p?.employeeCode ?? "",
    location: p?.location ?? "",
    joinedOn: p?.joinedOn ?? "",
  });
  if (!p) return null;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const mgr = data.people.find((x) => x.userId === p.managerId);
  const reports = data.people.filter((x) => x.managerId === p.userId);
  const heads = data.departments.filter((d) => d.headId === p.userId);
  const edit = data.canEdit;
  return (
    <div className="ix-ppl-drawer" role="dialog" aria-label={nameOf(p)}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { ...f, departmentId: f.departmentId || null, managerId: f.managerId || null, joinedOn: f.joinedOn || null };
          if (await act({ action: "updatePerson", userId, ...body }, `${nameOf(p)} saved.`)) onClose();
        }}
      >
        <header>
          <b>Employee</b>
          <button type="button" className="ix-act" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="ix-ppl-profile">
          <Avatar p={p} size={56} />
          <div>
            <b>{nameOf(p)}</b>
            <small>{p.email}</small>
            <span className={`ix-ppl-role r-${p.role.toLowerCase()}`}>{ROLE[p.role] ?? p.role}</span>
          </div>
        </div>
        {heads.length > 0 && <div className="ix-ppl-headtag">Head of {heads.map((d) => d.name).join(", ")}</div>}
        <div className="ix-ppl-rel">
          <div>
            <small>Reports to</small>
            {mgr ? (
              <span>
                <Avatar p={mgr} size={22} /> {nameOf(mgr)}
              </span>
            ) : (
              <span className="dim">No one</span>
            )}
          </div>
          <div>
            <small>Direct reports</small>
            {reports.length ? (
              <span>
                {reports.slice(0, 5).map((r) => (
                  <Avatar key={r.userId} p={r} size={22} />
                ))}
                {reports.length > 5 && <em> +{reports.length - 5}</em>}
              </span>
            ) : (
              <span className="dim">None</span>
            )}
          </div>
        </div>
        <fieldset disabled={!edit}>
          <label>
            Job title
            <input value={f.title} onChange={set("title")} maxLength={120} placeholder="e.g. Shift supervisor" />
          </label>
          <label>
            Department
            <select value={f.departmentId} onChange={set("departmentId")}>
              <option value="">No department</option>
              {data.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {pathOf(data.departments, d.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Manager
            <select value={f.managerId} onChange={set("managerId")}>
              <option value="">No manager</option>
              {data.people
                .filter((x) => x.userId !== p.userId)
                .map((x) => (
                  <option key={x.userId} value={x.userId}>
                    {nameOf(x)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Location
            <input value={f.location} onChange={set("location")} maxLength={120} placeholder="e.g. Pune plant" />
          </label>
          {p.hr ? (
            <>
              <label>
                Phone
                <input value={f.phone} onChange={set("phone")} maxLength={40} inputMode="tel" />
              </label>
              <label>
                Employee code
                <input value={f.employeeCode} onChange={set("employeeCode")} maxLength={40} />
              </label>
              <label>
                Joined on
                <input type="date" value={f.joinedOn} onChange={set("joinedOn")} />
              </label>
            </>
          ) : (
            <p className="dim small">Phone, employee code and joining date are visible to admins and this person&apos;s managers.</p>
          )}
        </fieldset>
        {edit && (
          <footer>
            <button type="submit" className="ix-btn primary">
              Save
            </button>
          </footer>
        )}
      </form>
    </div>
  );
}

// ── My team ──────────────────────────────────────────────────────────────────

type TeamTasks = { open: number; overdue: number; dueThisWeek: number; top: { key?: string; title?: string; due?: string | null; status?: string }[] };
type TeamRow = { userId: string; direct: boolean; tasks: TeamTasks | null };

/** The people who report to me (directly or through others), with their open work in Tasks. */
function MyTeam({ data, onOpen }: { data: Data; onOpen: (userId: string) => void }) {
  const [team, setTeam] = useState<{ team: TeamRow[]; note: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/structure?team=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => live && setTeam(d))
      .catch(() => live && setTeam({ team: [], note: "Couldn't load your team." }));
    return () => {
      live = false;
    };
  }, []);
  const byId = new Map(data.people.map((p) => [p.userId, p]));
  if (!team) return <div className="dim" style={{ padding: 12 }}>Loading your team…</div>;
  if (!team.team.length)
    return (
      <div className="ix-card ix-org-empty">
        <h2>No one reports to you yet</h2>
        <p>When people have you as their manager (set in their profile, or by an admin), they appear here with their open tasks.</p>
      </div>
    );
  const sum = (k: "open" | "overdue" | "dueThisWeek") => team.team.reduce((n, r) => n + (r.tasks?.[k] ?? 0), 0);
  const rows = [...team.team].sort((a, b) => Number(b.direct) - Number(a.direct) || (b.tasks?.overdue ?? 0) - (a.tasks?.overdue ?? 0));
  const today = new Date(new Date().toISOString().slice(0, 10));
  return (
    <div className="ix-team">
      <div className="ix-usage-cards">
        <div className="ix-usage-card hero">
          <span>Your team</span>
          <b>{team.team.length}</b>
          <small>{team.team.filter((r) => r.direct).length} report to you directly</small>
        </div>
        <div className="ix-usage-card">
          <span>Open tasks</span>
          <b>{sum("open")}</b>
          <small>in projects you can see</small>
        </div>
        <div className="ix-usage-card">
          <span>Overdue</span>
          <b style={{ color: sum("overdue") ? "#dc2626" : undefined }}>{sum("overdue")}</b>
          <small>past their due date</small>
        </div>
        <div className="ix-usage-card">
          <span>Due this week</span>
          <b>{sum("dueThisWeek")}</b>
          <small>next 7 days</small>
        </div>
      </div>
      {team.note && <p className="dim">{team.note}</p>}
      <div className="ix-team-grid">
        {rows.map((r) => {
          const p = byId.get(r.userId);
          if (!p) return null;
          return (
            <article key={r.userId} className="ix-card ix-team-card">
              <button type="button" className="ix-ppl-who" onClick={() => onOpen(p.userId)}>
                <Avatar p={p} size={36} />
                <span>
                  <b>{nameOf(p)}</b>
                  <small>
                    {p.title || p.email}
                    {!r.direct && ` · through ${nameOf(byId.get(p.managerId ?? ""))}`}
                  </small>
                </span>
              </button>
              {r.tasks ? (
                <>
                  <div className="ix-team-stats">
                    <span>
                      <b>{r.tasks.open}</b> open
                    </span>
                    <span className={r.tasks.overdue ? "bad" : ""}>
                      <b>{r.tasks.overdue}</b> overdue
                    </span>
                    <span>
                      <b>{r.tasks.dueThisWeek}</b> this week
                    </span>
                  </div>
                  {r.tasks.top.length > 0 ? (
                    <ul className="ix-team-tasks">
                      {r.tasks.top.map((t) => (
                        <li key={t.key}>
                          <a href={`/workspace/tasks?task=${encodeURIComponent(t.key ?? "")}`}>
                            <code>{t.key}</code> {t.title}
                          </a>
                          {t.due && <small className={new Date(t.due) < today ? "bad" : ""}>{t.due}</small>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="dim small">Nothing open.</p>
                  )}
                </>
              ) : (
                <p className="dim small">Tasks not available.</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ── Add people (one, or a CSV) ───────────────────────────────────────────────

const CSV_HEAD = "email,name,title,department,manager,role,phone,employee_code,location,joined_on";
type AddRow = { email: string; name?: string; title?: string; department?: string; manager?: string; role?: string; phone?: string; employeeCode?: string; location?: string; joinedOn?: string };
const FIELD: Record<string, keyof AddRow> = {
  email: "email",
  "e-mail": "email",
  name: "name",
  "full name": "name",
  title: "title",
  "job title": "title",
  designation: "title",
  department: "department",
  dept: "department",
  manager: "manager",
  "manager email": "manager",
  "reports to": "manager",
  role: "role",
  access: "role",
  phone: "phone",
  mobile: "phone",
  employee_code: "employeeCode",
  "employee code": "employeeCode",
  "emp code": "employeeCode",
  location: "location",
  site: "location",
  joined_on: "joinedOn",
  "joined on": "joinedOn",
  "joining date": "joinedOn",
  doj: "joinedOn",
};

/** A small CSV reader: quoted fields, and commas or new lines inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === "\t") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
function rowsFromCsv(text: string): AddRow[] {
  const [head, ...body] = parseCsv(text.trim());
  if (!head) return [];
  const cols = head.map((h) => FIELD[h.trim().toLowerCase()]);
  if (!cols.includes("email")) return [];
  return body.map((r) => {
    const o: Record<string, string> = {};
    cols.forEach((k, i) => {
      if (k && r[i]?.trim()) o[k] = r[i].trim();
    });
    return o as AddRow;
  });
}

function AddPeople({ data, reload, onClose }: { data: Data; reload: () => Promise<void>; onClose: () => void }) {
  const [mode, setMode] = useState<"one" | "csv">("one");
  const [one, setOne] = useState<AddRow>({ email: "", role: "MEMBER" });
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ email: string; ok: boolean; note: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => (mode === "csv" ? rowsFromCsv(csv) : []), [mode, csv]);
  const set = (k: keyof AddRow) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setOne({ ...one, [k]: e.target.value });

  const send = async (rows: AddRow[]) => {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/structure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "invite", rows }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok) return setError(d.error ?? "That didn't work. Try again.");
    setResults(d.results);
    await reload();
  };
  const template = () => {
    const sample = [
      CSV_HEAD,
      "priya@yourcompany.com,Priya Shah,Accounts lead,Management › Accounts,,MEMBER,+91 90000 00000,EMP-001,Pune,2024-04-01",
      "ravi@yourcompany.com,Ravi Kumar,Shift supervisor,Management › Production › Shift A,priya@yourcompany.com,MEMBER,,EMP-002,Pune plant,",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([sample], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "people-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="ix-ppl-drawer wide" role="dialog" aria-label="Add people">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(mode === "one" ? [one] : parsed);
        }}
      >
        <header>
          <b>Add people</b>
          <button type="button" className="ix-act" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <p className="dim small">They get access when they sign in with this email; no email is sent from here. People already in the workspace just get their place updated.</p>
        <div className="ix-seg" role="group" aria-label="How">
          <button type="button" aria-pressed={mode === "one"} onClick={() => (setMode("one"), setResults(null))}>
            One person
          </button>
          <button type="button" aria-pressed={mode === "csv"} onClick={() => (setMode("csv"), setResults(null))}>
            Many (CSV)
          </button>
        </div>
        {mode === "one" ? (
          <fieldset>
            <label>
              Email
              <input type="email" required value={one.email} onChange={set("email")} placeholder="name@company.com" />
            </label>
            <label>
              Name
              <input value={one.name ?? ""} onChange={set("name")} />
            </label>
            <label>
              Job title
              <input value={one.title ?? ""} onChange={set("title")} />
            </label>
            <label>
              Department
              <select value={one.department ?? ""} onChange={set("department")}>
                <option value="">No department</option>
                {data.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {pathOf(data.departments, d.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Manager
              <select value={one.manager ?? ""} onChange={set("manager")}>
                <option value="">No manager</option>
                {data.people.map((p) => (
                  <option key={p.userId} value={p.email}>
                    {nameOf(p)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Access
              <select value={one.role ?? "MEMBER"} onChange={set("role")}>
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
                <option value="VIEWER">Viewer</option>
              </select>
            </label>
          </fieldset>
        ) : (
          <>
            <label>
              Paste rows (with a header line), or choose a file
              <textarea className="ix-ppl-csv" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={CSV_HEAD} rows={7} spellCheck={false} />
            </label>
            <div className="ix-ppl-csvbar">
              <label className="ix-btn">
                Choose CSV
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) setCsv(await f.text());
                  }}
                />
              </label>
              <button type="button" className="ix-btn" onClick={template}>
                Download template
              </button>
            </div>
            <p className="dim small">
              Department can be a path like <code>Plant › Production › Shift A</code>; missing ones are created. Manager is an email, of someone already here or in this list.
            </p>
            {csv.trim() && (
              <p className={parsed.length ? "small" : "ix-error"}>
                {parsed.length ? `${parsed.length} ${parsed.length === 1 ? "person" : "people"} ready.` : "No email column found in the header line."}
              </p>
            )}
            {parsed.length > 0 && (
              <div className="ix-ppl-preview">
                <table className="ix-usage-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>Department</th>
                      <th>Manager</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 50).map((r, i) => (
                      <tr key={i}>
                        <td>{r.email}</td>
                        <td>{r.name}</td>
                        <td>{r.department}</td>
                        <td>{r.manager}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {error && <p className="ix-error">{error}</p>}
        {results && (
          <ul className="ix-ppl-results">
            {results.map((r, i) => (
              <li key={i} className={r.ok ? "ok" : "bad"}>
                <b>{r.email}</b> {r.note}
              </li>
            ))}
          </ul>
        )}
        <footer>
          <button type="submit" className="ix-btn primary" disabled={busy || (mode === "csv" && !parsed.length)}>
            {busy ? "Adding…" : mode === "one" ? "Add person" : `Add ${parsed.length || ""} people`}
          </button>
          <button type="button" className="ix-btn" onClick={onClose}>
            {results ? "Done" : "Cancel"}
          </button>
        </footer>
      </form>
    </div>
  );
}

// ── Organisation setup (first run) ───────────────────────────────────────────

type Tree = { name: string; kids?: Tree[] };
const DEPT_TEMPLATES: { id: string; label: string; hint: string; tree: Tree[] }[] = [
  {
    id: "manufacturing",
    label: "Manufacturing",
    hint: "A plant with shifts, quality and stores",
    tree: [
      {
        name: "Management",
        kids: [
          { name: "Production", kids: [{ name: "Shift A" }, { name: "Shift B" }] },
          { name: "Quality" },
          { name: "Stores" },
          { name: "Dispatch" },
          { name: "Accounts" },
          { name: "Sales" },
          { name: "HR" },
        ],
      },
    ],
  },
  {
    id: "trading",
    label: "Trading and distribution",
    hint: "Buying, selling and a warehouse",
    tree: [{ name: "Management", kids: [{ name: "Sales" }, { name: "Purchase" }, { name: "Warehouse" }, { name: "Accounts" }, { name: "HR" }] }],
  },
  {
    id: "services",
    label: "Services and IT",
    hint: "Delivery teams, sales and support",
    tree: [{ name: "Leadership", kids: [{ name: "Engineering" }, { name: "Design" }, { name: "Sales" }, { name: "Support" }, { name: "Operations" }, { name: "HR and Admin" }] }],
  },
];
const countTree = (t: Tree[]): number => t.reduce((n, x) => n + 1 + countTree(x.kids ?? []), 0);
/** A template's departments as indented lines. */
const treeLines = (t: Tree[], depth = 0): string[] => t.flatMap((n) => [`${"  ".repeat(depth)}${n.name}`, ...treeLines(n.kids ?? [], depth + 1)]);

function OrgSetup({ data, reload, onClose }: { data: Data; reload: () => Promise<void>; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [company, setCompany] = useState("");
  const [tpl, setTpl] = useState<string>(data.departments.length ? "skip" : "manufacturing");
  const [csv, setCsv] = useState("");
  const [templates, setTemplates] = useState<{ id: string; name: string; description: string }[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => rowsFromCsv(csv), [csv]);
  const say = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    let live = true;
    fetch("/api/workspace", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (d.workspace?.name) setCompany((c) => c || d.workspace.name);
      })
      .catch(() => undefined);
    fetch("/api/permissions?admin=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => live && setTemplates(d.templates ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const post = async (url: string, body: Record<string, unknown>, method = "POST") => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) throw new Error(d.error ?? "Something went wrong.");
    return d;
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      if (company.trim()) {
        await post("/api/workspace", { name: company.trim() }, "PATCH");
        say(`Company name set to ${company.trim()}.`);
      }
      const made: Record<string, string> = Object.fromEntries(data.departments.map((d) => [d.name.toLowerCase(), d.id]));
      const t = DEPT_TEMPLATES.find((x) => x.id === tpl);
      if (t) {
        const walk = async (nodes: Tree[], parentId: string | null) => {
          for (const n of nodes) {
            // A department that already exists in the same place is reused, not duplicated.
            const have = data.departments.find((x) => x.parentId === parentId && x.name.toLowerCase() === n.name.toLowerCase());
            const id: string = have?.id ?? (await post("/api/structure", { action: "createDept", name: n.name, parentId })).department.id;
            made[n.name.toLowerCase()] = id;
            if (n.kids) await walk(n.kids, id);
          }
        };
        await walk(t.tree, null);
        say(`Created ${countTree(t.tree)} departments.`);
      }
      if (parsed.length) {
        const d = await post("/api/structure", { action: "invite", rows: parsed });
        const ok = (d.results as { ok: boolean }[]).filter((x) => x.ok).length;
        say(`Added or placed ${ok} of ${parsed.length} people.`);
      }
      for (const [templateId, deptName] of Object.entries(roles)) {
        const tplRole = templates.find((x) => x.id === templateId);
        if (!tplRole) continue;
        const r = await post("/api/permissions", { action: "createRole", name: tplRole.name, template: templateId });
        const deptId = deptName ? made[deptName.toLowerCase()] : null;
        if (deptId) {
          await post("/api/permissions", { action: "assign", roleId: r.role.id, subjectType: "department", subjectId: deptId });
          say(`Created the ${tplRole.name} role and gave it to ${deptName}.`);
        } else say(`Created the ${tplRole.name} role.`);
      }
      await reload();
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
    setBusy(false);
  };

  const deptNames = [...new Set([...data.departments.map((d) => d.name), ...treeLines(DEPT_TEMPLATES.find((x) => x.id === tpl)?.tree ?? []).map((l) => l.trim())])];
  const STEPS = ["Company", "Departments", "People", "Roles", "Done"];

  return (
    <div className="ix-ppl-drawer wide" role="dialog" aria-label="Set up your organisation">
      <form onSubmit={(e) => e.preventDefault()}>
        <header>
          <b>Set up your organisation</b>
          <button type="button" className="ix-act" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <ol className="ix-setup-steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
              <span>{i < step ? "✓" : i + 1}</span> {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <fieldset>
            <label>
              Company name
              <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={60} placeholder="e.g. Ashvan Steelworks" />
            </label>
            <p className="dim small">Logo and colours are in Settings → Branding.</p>
          </fieldset>
        )}

        {step === 1 && (
          <div className="ix-setup-choices" role="radiogroup" aria-label="Departments">
            {DEPT_TEMPLATES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={tpl === t.id} onClick={() => setTpl(t.id)}>
                <b>{t.label}</b>
                <small>{t.hint}</small>
                <span className="ix-setup-tree">
                  {treeLines(t.tree).join("\n")}
                </span>
              </button>
            ))}
            <button type="button" role="radio" aria-checked={tpl === "skip"} onClick={() => setTpl("skip")}>
              <b>{data.departments.length ? "Keep my current departments" : "I'll build my own"}</b>
              <small>Add departments on the org chart afterwards</small>
            </button>
          </div>
        )}

        {step === 2 && (
          <>
            <label>
              Paste people as CSV (optional; you can add them later)
              <textarea className="ix-ppl-csv" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={CSV_HEAD} rows={7} spellCheck={false} />
            </label>
            <p className="dim small">
              Use department names from the previous step (a path like <code>Management › Production</code> works too). They get access when they sign in; no email is sent.
            </p>
            {csv.trim() && <p className={parsed.length ? "small" : "ix-error"}>{parsed.length ? `${parsed.length} ${parsed.length === 1 ? "person" : "people"} ready.` : "No email column found in the header line."}</p>}
          </>
        )}

        {step === 3 && (
          <div className="ix-setup-roles">
            <p className="dim small">Pick ready-made roles and, optionally, the department that gets each one. Everyone in that department and below it gets the role. Fine-tune switches later in Admin → Roles.</p>
            {templates.length === 0 && <p className="dim small">Role templates need the &quot;Manage roles and permissions&quot; switch.</p>}
            {templates.map((t) => (
              <div key={t.id} className={`ix-setup-role ${t.id in roles ? "on" : ""}`}>
                <label className="ix-setup-check">
                  <input
                    type="checkbox"
                    checked={t.id in roles}
                    onChange={(e) =>
                      setRoles((r) => {
                        const n = { ...r };
                        if (e.target.checked) n[t.id] = "";
                        else delete n[t.id];
                        return n;
                      })
                    }
                  />
                  <span>
                    <b>{t.name}</b>
                    <small>{t.description}</small>
                  </span>
                </label>
                {t.id in roles && (
                  <select value={roles[t.id]} onChange={(e) => setRoles((r) => ({ ...r, [t.id]: e.target.value }))} aria-label={`Department for ${t.name}`}>
                    <option value="">No department (give it to people later)</option>
                    {deptNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        )}

        {step === 4 && (
          <div className="ix-setup-done">
            <b>Your organisation is set up.</b>
            <ul>
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            <p className="dim small">Next: drag people onto departments on the org chart, set heads, and open My team.</p>
          </div>
        )}

        {log.length > 0 && step < 4 && (
          <ul className="ix-ppl-results">
            {log.map((l, i) => (
              <li key={i} className="ok">
                {l}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="ix-error">{error}</p>}

        <footer>
          {step > 0 && step < 4 && (
            <button type="button" className="ix-btn" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </button>
          )}
          {step < 3 && (
            <button type="button" className="ix-btn primary" onClick={() => setStep(step + 1)}>
              Next
            </button>
          )}
          {step === 3 && (
            <button type="button" className="ix-btn primary" onClick={() => void run()} disabled={busy}>
              {busy ? "Setting up…" : "Set it up"}
            </button>
          )}
          {step === 4 && (
            <button type="button" className="ix-btn primary" onClick={onClose}>
              Done
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}

// ── Time off ─────────────────────────────────────────────────────────────────

type Leave = { id: string; userId: string; type: string; start: string; end: string; halfDay: boolean; days: number; status: string; reason: string | null; approverId: string | null; decidedById: string | null; decisionNote: string | null };
type LeaveView = {
  month: string;
  types: { id: string; label: string; color: string }[];
  myApprover: string | null;
  takenThisYear: Record<string, number>;
  policy: { leaveAllowance: Record<string, number>; holidays: { date: string; name: string }[]; weekOff: number[]; workHours?: { start: string; hours: number; graceMin: number } };
  balances: Record<string, { allowance: number | null; used: number; pending: number }>;
  mine: Leave[];
  waiting: Leave[];
  chart: Leave[];
  admin: boolean;
};
/** Today on the viewer's own calendar (not UTC). */
const todayIso = () => new Date().toLocaleDateString("en-CA");
const shiftMonth = (m: string, n: number) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const fmtDay = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const fmtRange = (l: Leave) => `${fmtDay(l.start)}${l.end !== l.start ? ` – ${fmtDay(l.end)}` : ""}${l.halfDay ? " · half day" : ""}`;

function TimeOff({ data }: { data: Data }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [v, setV] = useState<LeaveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ type: "casual", start: todayIso(), end: todayIso(), halfDay: false, reason: "" });
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [dept, setDept] = useState("");
  const [everyone, setEveryone] = useState(false);
  const [rules, setRules] = useState(false);
  const byId = useMemo(() => new Map(data.people.map((p) => [p.userId, p])), [data.people]);

  const load = useCallback(async (m: string) => {
    const r = await fetch(`/api/timeoff?month=${m}`, { cache: "no-store" }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (!r?.ok || !d) return setError(d?.error ?? "Couldn't load time off.");
    setError(null);
    setV(d);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(month);
  }, [load, month]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    const r = await fetch("/api/timeoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok) {
      setError(d.error ?? "That didn't work.");
      return false;
    }
    setError(null);
    await load(month);
    return true;
  };

  if (!v) return <div className="dim" style={{ padding: 12 }}>{error ?? "Loading time off…"}</div>;
  const typeOf = (id: string) => v.types.find((t) => t.id === id) ?? { id, label: id, color: "#6b7280" };
  const approver = v.myApprover ? byId.get(v.myApprover) : null;

  // The chart: days of the month, and the people to show.
  const first = new Date(`${v.month}-01T00:00:00Z`);
  const daysIn = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const days = Array.from({ length: daysIn }, (_, i) => new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), i + 1)));
  const inDept = dept ? under(data.departments, dept) : null;
  const shown = data.people.filter((p) => (!inDept || (p.departmentId && inDept.has(p.departmentId))) && (everyone || v.chart.some((l) => l.userId === p.userId)));
  const cell = (userId: string, d: Date) => {
    const s = d.toISOString().slice(0, 10);
    return v.chart.find((l) => l.userId === userId && l.start <= s && l.end >= s);
  };
  const today = todayIso();
  const holiday = new Map(v.policy.holidays.map((h) => [h.date, h.name]));
  const offDay = (d: Date) => v.policy.weekOff.includes(d.getUTCDay());

  return (
    <div className="ix-off">
      {error && <p className="ix-error">{error}</p>}
      <div className="ix-off-top">
        <form
          className="ix-card ix-off-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "request", ...form, end: form.halfDay ? form.start : form.end })) setForm({ ...form, reason: "", halfDay: false });
          }}
        >
          <h2>Request time off</h2>
          <div className="ix-off-row">
            <label>
              Type
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {v.types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              From
              <input type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value, end: e.target.value > form.end ? e.target.value : form.end })} required />
            </label>
            <label>
              To
              <input type="date" value={form.halfDay ? form.start : form.end} min={form.start} disabled={form.halfDay} onChange={(e) => setForm({ ...form, end: e.target.value })} required />
            </label>
          </div>
          <label className="ix-off-check">
            <input type="checkbox" checked={form.halfDay} onChange={(e) => setForm({ ...form, halfDay: e.target.checked })} /> Half day
          </label>
          <label>
            Reason (seen by you, your approver and admins)
            <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={500} placeholder="Optional" />
          </label>
          <div className="ix-off-foot">
            <span className="dim small">Goes to {approver ? <b>{nameOf(approver)}</b> : "the workspace admins"} for approval. Off days and company holidays aren&apos;t counted.</span>
            <button type="submit" className="ix-btn primary" disabled={busy}>
              Send request
            </button>
          </div>
        </form>
        <div className="ix-card ix-off-taken">
          <h2>
            Your balance <span>{new Date().getFullYear()}</span>
          </h2>
          {v.types.map((t) => {
            const b = v.balances[t.id];
            const left = b.allowance === null ? null : b.allowance - b.used - b.pending;
            return (
              <div key={t.id} className="ix-off-stat" title={`${b.used} used${b.pending ? `, ${b.pending} waiting` : ""}${b.allowance !== null ? ` of ${b.allowance}` : ""}`}>
                <i style={{ background: t.color }} />
                <span>{t.label}</span>
                {b.allowance === null ? (
                  <small className="dim">{b.used ? `${b.used} used` : "no limit"}</small>
                ) : (
                  <>
                    <span className="ix-off-bar" aria-hidden>
                      <em style={{ width: `${Math.min(100, ((b.used + b.pending) / Math.max(1, b.allowance)) * 100)}%`, background: t.color }} />
                    </span>
                    <b>
                      {left} <small className="dim">/ {b.allowance} left</small>
                    </b>
                  </>
                )}
              </div>
            );
          })}
          {v.policy.holidays.filter((h) => h.date >= today).length > 0 && (
            <div className="ix-off-hols">
              <small className="dim">Next holidays</small>
              {v.policy.holidays
                .filter((h) => h.date >= today)
                .slice(0, 3)
                .map((h) => (
                  <span key={h.date}>
                    {fmtDay(h.date)} · {h.name}
                  </span>
                ))}
            </div>
          )}
          {v.admin && (
            <button type="button" className="ix-btn" onClick={() => setRules(true)}>
              <Icon name="settings" size={14} /> Leave rules
            </button>
          )}
        </div>
      </div>
      {rules && <LeaveRules v={v} onClose={() => setRules(false)} onSaved={() => void load(month)} />}

      {v.waiting.length > 0 && (
        <section className="ix-card ix-off-list">
          <h2>
            Waiting for your decision <span>{v.waiting.length}</span>
          </h2>
          {v.waiting.map((l) => {
            const p = byId.get(l.userId);
            return (
              <div key={l.id} className="ix-off-item">
                <Avatar p={p} size={32} />
                <div className="grow">
                  <b>{nameOf(p)}</b> · <span style={{ color: typeOf(l.type).color }}>{typeOf(l.type).label}</span>
                  <small>
                    {fmtRange(l)} · {l.days} {l.days === 1 ? "day" : "days"}
                    {l.reason && ` · “${l.reason}”`}
                  </small>
                </div>
                <input className="ix-off-note" placeholder="Note (optional)" value={notes[l.id] ?? ""} onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })} aria-label="Note" />
                <button type="button" className="ix-btn primary" disabled={busy} onClick={() => void post({ action: "decide", id: l.id, approve: true, note: notes[l.id] })}>
                  Approve
                </button>
                <button type="button" className="ix-btn danger" disabled={busy} onClick={() => void post({ action: "decide", id: l.id, approve: false, note: notes[l.id] })}>
                  Reject
                </button>
              </div>
            );
          })}
        </section>
      )}

      <section className="ix-card ix-off-chart">
        <div className="ix-off-charthead">
          <h2>Absence chart</h2>
          <div className="ix-off-month">
            <button type="button" className="ix-act" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
              ‹
            </button>
            <b>{first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</b>
            <button type="button" className="ix-act" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
              ›
            </button>
          </div>
          <select className="ix-usage-select" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {data.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {pathOf(data.departments, d.id)}
              </option>
            ))}
          </select>
          <label className="ix-usage-all">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> Show everyone
          </label>
        </div>
        <div className="ix-off-gridwrap">
          <table className="ix-off-grid">
            <thead>
              <tr>
                <th className="who">Person</th>
                {days.map((d) => {
                  const s = d.toISOString().slice(0, 10);
                  return (
                    <th key={s} className={`${offDay(d) ? "sun" : ""} ${holiday.has(s) ? "hol" : ""} ${s === today ? "today" : ""}`} title={holiday.get(s)}>
                      <small>{"SMTWTFS"[d.getUTCDay()]}</small>
                      {d.getUTCDate()}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.userId}>
                  <td className="who">
                    <Avatar p={p} size={22} /> {nameOf(p)}
                  </td>
                  {days.map((d) => {
                    const s = d.toISOString().slice(0, 10);
                    const l = cell(p.userId, d);
                    const t = l ? typeOf(l.type) : null;
                    return (
                      <td key={s} className={`${offDay(d) ? "sun" : ""} ${holiday.has(s) ? "hol" : ""} ${s === today ? "today" : ""}`} title={holiday.get(s)}>
                        {l && !offDay(d) && !holiday.has(s) && (
                          <i
                            className={`${l.status === "pending" ? "pending" : ""} ${l.halfDay ? "half" : ""}`}
                            style={{ ["--lc" as string]: t!.color }}
                            title={`${nameOf(p)}: ${t!.label}${l.status === "pending" ? " (waiting for approval)" : ""} · ${fmtRange(l)}`}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={days.length + 1} className="empty">
                    No one is away this month{dept ? " in this department" : ""}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="ix-off-legend">
          {v.types.map((t) => (
            <span key={t.id}>
              <i style={{ background: t.color }} /> {t.label}
            </span>
          ))}
          <span>
            <i className="pending" style={{ ["--lc" as string]: "#6b7280" }} /> Waiting for approval
          </span>
          <span>
            <i className="hol" /> Company holiday
          </span>
        </div>
      </section>

      <section className="ix-card ix-off-list">
        <h2>Your requests</h2>
        {v.mine.length === 0 && <p className="dim small">None yet.</p>}
        {v.mine.map((l) => (
          <div key={l.id} className="ix-off-item">
            <i className="ix-off-dot" style={{ background: typeOf(l.type).color }} />
            <div className="grow">
              <b>{typeOf(l.type).label}</b>
              <small>
                {fmtRange(l)} · {l.days} {l.days === 1 ? "day" : "days"}
                {l.decisionNote && ` · “${l.decisionNote}”`}
              </small>
            </div>
            <span className={`ix-off-status s-${l.status}`}>{l.status === "pending" ? "Waiting" : l.status[0].toUpperCase() + l.status.slice(1)}</span>
            {(l.status === "pending" || (l.status === "approved" && l.start > today)) && (
              <button type="button" className="ix-btn" disabled={busy} onClick={() => void post({ action: "cancel", id: l.id })}>
                Cancel
              </button>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

/** Owners and admins: yearly allowance per leave type, weekly off days and company holidays. */
function LeaveRules({ v, onClose, onSaved }: { v: LeaveView; onClose: () => void; onSaved: () => void }) {
  const [allow, setAllow] = useState<Record<string, string>>(() => Object.fromEntries(v.types.map((t) => [t.id, v.policy.leaveAllowance[t.id] !== undefined ? String(v.policy.leaveAllowance[t.id]) : ""])));
  const [weekOff, setWeekOff] = useState<number[]>(v.policy.weekOff);
  const [hols, setHols] = useState(v.policy.holidays);
  const [hours, setHours] = useState({ start: v.policy.workHours?.start ?? "09:30", hours: String(v.policy.workHours?.hours ?? 8), graceMin: String(v.policy.workHours?.graceMin ?? 10) });
  const [newHol, setNewHol] = useState({ date: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    const r = await fetch("/api/timeoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "policy", leaveAllowance: Object.fromEntries(Object.entries(allow).filter(([, n]) => n.trim() !== "")), weekOff, holidays: hols, workHours: { start: hours.start, hours: Number(hours.hours), graceMin: Number(hours.graceMin) } }),
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok) return setError(d.error ?? "Couldn't save.");
    onSaved();
    onClose();
  };
  return (
    <div className="ix-ppl-drawer wide" role="dialog" aria-label="Leave rules">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header>
          <b>Leave rules</b>
          <button type="button" className="ix-act" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <h3 className="ix-rules-h">Days a year, per person</h3>
        <p className="dim small">Leave a type empty for no limit. Requests over what&apos;s left are refused; waiting requests count too.</p>
        <div className="ix-rules-grid">
          {v.types.map((t) => (
            <label key={t.id}>
              <span>
                <i style={{ background: t.color }} /> {t.label}
              </span>
              <input type="number" min={0} max={366} step={0.5} inputMode="decimal" value={allow[t.id]} placeholder="No limit" onChange={(e) => setAllow({ ...allow, [t.id]: e.target.value })} />
            </label>
          ))}
        </div>
        <h3 className="ix-rules-h">Working day</h3>
        <div className="ix-rules-grid">
          <label>
            <span>Starts at</span>
            <input type="time" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} />
          </label>
          <label>
            <span>Hours a day</span>
            <input type="number" min={1} max={16} step={0.5} value={hours.hours} onChange={(e) => setHours({ ...hours, hours: e.target.value })} />
          </label>
          <label>
            <span>Late after (minutes)</span>
            <input type="number" min={0} max={120} value={hours.graceMin} onChange={(e) => setHours({ ...hours, graceMin: e.target.value })} />
          </label>
        </div>
        <h3 className="ix-rules-h">Weekly off days</h3>
        <div className="ix-rules-days" role="group" aria-label="Weekly off days">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
            <button key={d} type="button" aria-pressed={weekOff.includes(i)} onClick={() => setWeekOff((w) => (w.includes(i) ? w.filter((x) => x !== i) : [...w, i]))}>
              {d}
            </button>
          ))}
        </div>
        <h3 className="ix-rules-h">Company holidays</h3>
        <div className="ix-rules-hols">
          {hols.length === 0 && <p className="dim small">None yet.</p>}
          {hols
            .slice()
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((h) => (
              <div key={h.date}>
                <span>{fmtDay(h.date)}</span>
                <b>{h.name}</b>
                <button type="button" className="ix-act" aria-label={`Remove ${h.name}`} onClick={() => setHols(hols.filter((x) => x.date !== h.date))}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          <div className="ix-rules-add">
            <input type="date" value={newHol.date} onChange={(e) => setNewHol({ ...newHol, date: e.target.value })} aria-label="Holiday date" />
            <input value={newHol.name} onChange={(e) => setNewHol({ ...newHol, name: e.target.value })} placeholder="e.g. Diwali" maxLength={60} aria-label="Holiday name" />
            <button
              type="button"
              className="ix-btn"
              disabled={!newHol.date}
              onClick={() => {
                setHols([...hols.filter((x) => x.date !== newHol.date), { date: newHol.date, name: newHol.name.trim() || "Holiday" }]);
                setNewHol({ date: "", name: "" });
              }}
            >
              Add
            </button>
          </div>
        </div>
        {error && <p className="ix-error">{error}</p>}
        <footer>
          <button type="submit" className="ix-btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save rules"}
          </button>
          <button type="button" className="ix-btn" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </form>
    </div>
  );
}

// ── Work time and daily reports ──────────────────────────────────────────────

type MyWork = {
  today: string;
  open: { id: string; startedAt: string } | null;
  todayMinutes: number;
  weekMinutes: number;
  sessions: { id: string; startedAt: string; endedAt: string | null; minutes: number }[];
  report: { id: string; done: string; next: string | null; blockers: string | null; seenAt: string | null; comment: string | null } | null;
  recent: { date: string; done: string; seen: boolean; comment: string | null }[];
  managerId: string | null;
};
type TeamWork = {
  day: string;
  admin: boolean;
  people: { userId: string; in: string | null; todayMinutes: number; weekMinutes: number; report: { id: string; done: string; next: string | null; blockers: string | null; seen: boolean; comment: string | null } | null }[];
};
const hm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function WorkTime({ data }: { data: Data }) {
  const [me, setMe] = useState<MyWork | null>(null);
  const [team, setTeam] = useState<TeamWork | null>(null);
  const [form, setForm] = useState({ done: "", next: "", blockers: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [comment, setComment] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const byId = useMemo(() => new Map(data.people.map((p) => [p.userId, p])), [data.people]);

  const load = useCallback(async () => {
    setNow(Date.now());
    const [a, b] = await Promise.all([
      fetch("/api/worktime", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/worktime?team=1", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]);
    if (!a || a.error) return setError(a?.error ?? "Couldn't load work time.");
    setMe(a);
    setTeam(b && !b.error ? b : null);
    if (a.report) setForm({ done: a.report.done, next: a.report.next ?? "", blockers: a.report.blockers ?? "" });
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  // The running timer.
  useEffect(() => {
    if (!me?.open) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [me?.open]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    const r = await fetch("/api/worktime", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok) {
      setError(d.error ?? "That didn't work.");
      return false;
    }
    setError(null);
    await load();
    return true;
  };

  if (!me) return <div className="dim" style={{ padding: 12 }}>{error ?? "Loading work time…"}</div>;
  const running = me.open ? Math.max(0, Math.round((now - new Date(me.open.startedAt).getTime()) / 60_000)) : 0;
  const closed = me.sessions.filter((s) => s.endedAt).reduce((n, s) => n + s.minutes, 0);
  const todayTotal = closed + running;
  const mgr = me.managerId ? byId.get(me.managerId) : null;

  return (
    <div className="ix-work">
      {error && <p className="ix-error">{error}</p>}
      <div className="ix-work-top">
        <section className={`ix-card ix-work-clock ${me.open ? "on" : ""}`}>
          <div className="ix-work-time">
            <span>{me.open ? `In since ${clock(me.open.startedAt)}` : "Not clocked in"}</span>
            <b>{hm(todayTotal)}</b>
            <small>today · {hm(me.weekMinutes - me.todayMinutes + todayTotal)} this week</small>
          </div>
          <button type="button" className={`ix-work-btn ${me.open ? "out" : ""}`} disabled={busy} onClick={() => void post({ action: me.open ? "out" : "in" })}>
            {me.open ? "Clock out" : "Clock in"}
          </button>
          {me.sessions.length > 0 && (
            <ul className="ix-work-sessions">
              {me.sessions.map((s) => (
                <li key={s.id}>
                  {clock(s.startedAt)} – {s.endedAt ? clock(s.endedAt) : "now"} <span>{hm(s.endedAt ? s.minutes : running)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <form
          className="ix-card ix-work-report"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "report", ...form })) {
              setSaved(true);
              setTimeout(() => setSaved(false), 2500);
            }
          }}
        >
          <h2>
            Daily report <span>{fmtDay(me.today)}</span>
          </h2>
          <label>
            What I did today
            <textarea value={form.done} onChange={(e) => setForm({ ...form, done: e.target.value })} rows={3} maxLength={4000} required placeholder="Finished the dispatch plan for Monday; fixed the coil stock count…" />
          </label>
          <div className="ix-work-row">
            <label>
              Next
              <textarea value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} rows={2} maxLength={2000} placeholder="Optional" />
            </label>
            <label>
              Blockers
              <textarea value={form.blockers} onChange={(e) => setForm({ ...form, blockers: e.target.value })} rows={2} maxLength={2000} placeholder="Optional" />
            </label>
          </div>
          <div className="ix-off-foot">
            <span className="dim small">
              Goes to {mgr ? <b>{nameOf(mgr)}</b> : "no one yet (set your manager in People)"}
              {me.report?.seenAt && " · seen"}
            </span>
            <button type="submit" className="ix-btn primary" disabled={busy}>
              {saved ? "Sent ✓" : me.report ? "Update report" : "Send report"}
            </button>
          </div>
          {me.report?.comment && (
            <p className="ix-work-comment">
              <b>{mgr ? nameOf(mgr) : "Manager"}:</b> {me.report.comment}
            </p>
          )}
        </form>
      </div>

      {team && team.people.length > 0 && (
        <section className="ix-card">
          <h2 className="ix-work-h">
            {team.admin ? "Everyone" : "Your team"} this week <span>{team.people.length}</span>
          </h2>
          <div className="ix-usage-tablewrap">
            <table className="ix-usage-table ix-work-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Now</th>
                  <th className="r">Today</th>
                  <th className="r">This week</th>
                  <th>Today&apos;s report</th>
                </tr>
              </thead>
              <tbody>
                {team.people.map((t) => {
                  const p = byId.get(t.userId);
                  if (!p) return null;
                  return (
                    <Fragment key={t.userId}>
                      <tr onClick={() => t.report && setOpen(open === t.userId ? null : t.userId)} className={t.report ? "has" : ""}>
                        <td>
                          <div className="ix-ppl-who">
                            <Avatar p={p} size={28} />
                            <span>
                              <b>{nameOf(p)}</b>
                              <small>{p.title || p.email}</small>
                            </span>
                          </div>
                        </td>
                        <td>{t.in ? <span className="ix-work-in">In since {clock(t.in)}</span> : <span className="dim">Out</span>}</td>
                        <td className="r mono">{hm(t.todayMinutes)}</td>
                        <td className="r mono">{hm(t.weekMinutes)}</td>
                        <td>
                          {t.report ? (
                            <span className={`ix-work-rep ${t.report.seen ? "seen" : ""}`}>{t.report.seen ? "Seen" : "New"} · {t.report.done.slice(0, 60)}{t.report.done.length > 60 ? "…" : ""}</span>
                          ) : (
                            <span className="dim">Not sent yet</span>
                          )}
                        </td>
                      </tr>
                      {open === t.userId && t.report && (
                        <tr className="detail">
                          <td colSpan={5}>
                            <div className="ix-work-full">
                              <p>
                                <b>Did:</b> {t.report.done}
                              </p>
                              {t.report.next && (
                                <p>
                                  <b>Next:</b> {t.report.next}
                                </p>
                              )}
                              {t.report.blockers && (
                                <p className="bad">
                                  <b>Blockers:</b> {t.report.blockers}
                                </p>
                              )}
                              {t.report.comment && (
                                <p className="dim">
                                  <b>Your comment:</b> {t.report.comment}
                                </p>
                              )}
                              <div className="ix-work-reply">
                                <input value={comment[t.report.id] ?? ""} onChange={(e) => setComment({ ...comment, [t.report!.id]: e.target.value })} placeholder="Comment (optional)" aria-label="Comment" />
                                <button type="button" className="ix-btn primary" disabled={busy} onClick={() => void post({ action: "review", id: t.report!.id, comment: comment[t.report!.id] })}>
                                  {comment[t.report.id]?.trim() ? "Send comment" : "Mark as seen"}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {me.recent.length > 0 && (
        <section className="ix-card ix-off-list">
          <h2 className="ix-work-h">Your recent reports</h2>
          {me.recent.map((r) => (
            <div key={r.date} className="ix-off-item">
              <span className="ix-work-date">{fmtDay(r.date)}</span>
              <div className="grow">
                <span>{r.done}</span>
                {r.comment && <small>Comment: {r.comment}</small>}
              </div>
              <span className={`ix-off-status ${r.seen ? "s-approved" : "s-pending"}`}>{r.seen ? "Seen" : "Sent"}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// ── Reports: timesheet and login history ─────────────────────────────────────

type TsDay = { date: string; kind: "work" | "off" | "holiday" | "leave" | "absent" | "future"; minutes: number; firstIn: string | null; late: boolean; leave?: string };
type Timesheet = {
  month: string;
  admin: boolean;
  workHours: { start: string; hours: number; graceMin: number };
  holidays: { date: string; name: string }[];
  people: { userId: string; name: string; email: string; days: TsDay[]; totals: { minutes: number; present: number; late: number; leave: number; absent: number; workingDays: number } }[];
};
type Logins = { admin: boolean; total: number; page: number; size: number; rows: { id: string; at: string; userId: string; name: string | null; email: string; provider: string; ip: string | null; device: string }[] };
const PROVIDER: Record<string, string> = { google: "Google", github: "GitHub", email: "Email link", sso: "Single sign-on", device: "Device code", dev: "Local test" };

function Reports({ data }: { data: Data }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [ts, setTs] = useState<Timesheet | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [logins, setLogins] = useState<Logins | null>(null);
  const [lq, setLq] = useState("");
  const [lpage, setLpage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(data.people.map((p) => [p.userId, p])), [data.people]);

  useEffect(() => {
    let live = true;
    fetch(`/api/people-reports?view=timesheet&month=${month}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => live && (d.error ? setError(d.error) : setTs(d)))
      .catch(() => live && setError("Couldn't load the timesheet."));
    return () => {
      live = false;
    };
  }, [month]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/people-reports?view=logins&page=${lpage}&q=${encodeURIComponent(lq)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => live && !d.error && setLogins(d))
        .catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [lq, lpage]);

  const first = new Date(`${month}-01T00:00:00Z`);
  const lpages = logins ? Math.max(1, Math.ceil(logins.total / logins.size)) : 1;
  const hrs = (m: number) => (m ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : "—");

  return (
    <div className="ix-rep">
      {error && <p className="ix-error">{error}</p>}
      <section className="ix-card">
        <div className="ix-off-charthead">
          <h2>Timesheet</h2>
          <div className="ix-off-month">
            <button type="button" className="ix-act" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
              ‹
            </button>
            <b>{first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</b>
            <button type="button" className="ix-act" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
              ›
            </button>
          </div>
          <a className="ix-btn" href={`/api/people-reports?view=timesheet&month=${month}&format=csv`} download>
            <Icon name="insert" size={14} /> Export CSV
          </a>
        </div>
        {ts && (
          <p className="dim small" style={{ margin: "0 0 10px" }}>
            Work starts {ts.workHours.start}, {ts.workHours.hours} hours a day; late after {ts.workHours.graceMin} minutes. {ts.admin ? "Everyone" : "You and your team"}. Change these in Time off → Leave rules.
          </p>
        )}
        <div className="ix-usage-tablewrap">
          <table className="ix-usage-table ix-rep-table">
            <thead>
              <tr>
                <th>Person</th>
                <th className="r">Hours</th>
                <th className="r">Present</th>
                <th className="r">Late</th>
                <th className="r">Leave</th>
                <th className="r">Absent</th>
                <th>Days</th>
              </tr>
            </thead>
            <tbody>
              {ts?.people.map((p) => (
                <Fragment key={p.userId}>
                  <tr onClick={() => setOpen(open === p.userId ? null : p.userId)}>
                    <td>
                      <div className="ix-ppl-who">
                        <Avatar p={byId.get(p.userId)} size={26} />
                        <span>
                          <b>{p.name}</b>
                          <small>{byId.get(p.userId)?.title || p.email}</small>
                        </span>
                      </div>
                    </td>
                    <td className="r mono strong">{hrs(p.totals.minutes)}</td>
                    <td className="r mono">
                      {p.totals.present}/{p.totals.workingDays}
                    </td>
                    <td className={`r mono ${p.totals.late ? "bad" : ""}`}>{p.totals.late}</td>
                    <td className="r mono">{p.totals.leave}</td>
                    <td className={`r mono ${p.totals.absent ? "bad" : ""}`}>{p.totals.absent}</td>
                    <td>
                      <div className="ix-rep-strip" aria-hidden>
                        {p.days.map((d) => (
                          <i key={d.date} className={`k-${d.kind} ${d.late ? "late" : ""}`} title={`${d.date}: ${d.minutes ? `${hrs(d.minutes)}, in ${d.firstIn}${d.late ? " (late)" : ""}` : d.kind === "leave" ? `leave (${d.leave})` : d.kind}`} />
                        ))}
                      </div>
                    </td>
                  </tr>
                  {open === p.userId && (
                    <tr className="detail">
                      <td colSpan={7}>
                        <div className="ix-rep-days">
                          {p.days
                            .filter((d) => d.kind !== "future")
                            .map((d) => (
                              <span key={d.date} className={`k-${d.kind} ${d.late ? "late" : ""}`}>
                                <b>{Number(d.date.slice(8))}</b>
                                {d.minutes ? `${hrs(d.minutes)} · ${d.firstIn}` : d.kind === "leave" ? d.leave : d.kind === "off" ? "off" : d.kind === "holiday" ? "holiday" : "absent"}
                              </span>
                            ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ix-off-legend">
          <span>
            <i className="ix-rep-key k-work" /> Worked
          </span>
          <span>
            <i className="ix-rep-key k-work late" /> Late
          </span>
          <span>
            <i className="ix-rep-key k-leave" /> Leave
          </span>
          <span>
            <i className="ix-rep-key k-absent" /> Absent
          </span>
          <span>
            <i className="ix-rep-key k-holiday" /> Holiday
          </span>
          <span>
            <i className="ix-rep-key k-off" /> Off day
          </span>
        </div>
      </section>

      <section className="ix-card">
        <div className="ix-off-charthead">
          <h2>Login history</h2>
          <div className="ix-usage-search" style={{ flex: "0 1 320px" }}>
            <Icon name="search" size={15} />
            <input value={lq} onChange={(e) => (setLq(e.target.value), setLpage(1))} placeholder={logins?.admin ? "Search person, IP or method" : "Search IP or method"} aria-label="Search logins" />
          </div>
        </div>
        <div className="ix-usage-tablewrap">
          <table className="ix-usage-table">
            <thead>
              <tr>
                <th>Time</th>
                {logins?.admin && <th>Person</th>}
                <th>Signed in with</th>
                <th>Device</th>
                <th>IP address</th>
              </tr>
            </thead>
            <tbody>
              {logins?.rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{new Date(r.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                  {logins.admin && <td>{r.name || r.email}</td>}
                  <td>{PROVIDER[r.provider] ?? r.provider}</td>
                  <td>{r.device}</td>
                  <td className="mono dim">{r.ip ?? "—"}</td>
                </tr>
              ))}
              {logins && !logins.rows.length && (
                <tr>
                  <td colSpan={logins.admin ? 5 : 4} className="empty">
                    No sign-ins recorded yet. They&apos;re recorded from now on.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <footer className="ix-usage-pager">
          <span className="dim">{logins ? `${logins.total} sign-ins · page ${logins.page} of ${lpages}` : "Loading…"}</span>
          <button type="button" className="ix-btn" disabled={lpage <= 1} onClick={() => setLpage(lpage - 1)}>
            Previous
          </button>
          <button type="button" className="ix-btn" disabled={lpage >= lpages} onClick={() => setLpage(lpage + 1)}>
            Next
          </button>
        </footer>
      </section>
    </div>
  );
}
