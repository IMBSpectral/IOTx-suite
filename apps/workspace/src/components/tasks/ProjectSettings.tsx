"use client";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { api, BASE } from "@/lib/client";
import { Avatar, TYPES, PRIORITIES, type FieldDef, type Project, type Status, type Template } from "./ui";
import type { Ctx } from "./TasksApp";

const COLORS = ["#16a34a", "#4f46e5", "#0891b2", "#d97706", "#db2777", "#7c3aed", "#dc2626", "#0f766e", "#64748b"];
type Tab = "details" | "features" | "workflow" | "labels" | "fields" | "templates" | "quick" | "components" | "people" | "automation" | "repeating" | "import";

/** A new project, or a project's settings (project admins). */
export default function ProjectSettings({ ctx, project, onClose, onSaved }: { ctx: Ctx; project: Project | null; onClose: () => void; onSaved: (p: Project, created: boolean) => void }) {
  const [tab, setTab] = useState<Tab>("details");
  const [f, setF] = useState({ name: project?.name ?? "", key: project?.key ?? "", description: project?.description ?? "", color: project?.color ?? COLORS[1], leadId: project?.leadId ?? "" });
  const [keyTouched, setKeyTouched] = useState(!!project);
  const [statuses, setStatuses] = useState<Status[]>(project?.statuses ?? []);
  const [labels, setLabels] = useState(project?.labelDefs ?? []);
  const [fields, setFields] = useState<FieldDef[]>(project?.fieldDefs ?? []);
  const [templates, setTemplates] = useState<Template[]>(project?.templates ?? []);
  const [features, setFeatures] = useState(project?.features ?? { sprints: true, releases: true, components: true, estimation: "points" as const });
  const [quick, setQuick] = useState(project?.quickFilters ?? []);
  const [members, setMembers] = useState<{ userId: string; role: string }[]>(project?.members ?? [{ userId: ctx.me.id, role: "admin" }]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const suggest = (n: string) => {
    const w = n.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    return (w.length >= 2 ? w.map((x) => x[0]).join("") : (w[0] ?? "").slice(0, 3)).slice(0, 6);
  };

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setErr("");
    try {
      const d = project
        ? await api<{ project: Project }>(`/tasks/projects/${project.id}`, { method: "PATCH", body })
        : await api<{ project: Project }>("/tasks/projects", { body: { ...body, memberIds: members.map((m) => m.userId) } });
      onSaved(d.project, !project);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  const tabs: [Tab, string][] = project
    ? [["details", "Details"], ["features", "Features"], ["workflow", "Workflow"], ["labels", "Labels"], ["fields", "Fields"], ["templates", "Templates"], ["quick", "Quick filters"], ["components", "Components"], ["people", "People"], ["automation", "Automation"], ["repeating", "Repeating issues"], ["import", "Import"]]
    : [["details", "Details"], ["people", "People"]];

  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ws-modal wide tk-settings" role="dialog" aria-label={project ? "Project settings" : "New project"}>
        <header><h3>{project ? `${project.name} settings` : "New project"}</h3><button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <div className="tk-set-body">
          <nav className="tk-set-nav" aria-label="Settings">{tabs.map(([id, l]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{l}</button>)}</nav>
          <div className="tk-set-main">
            {tab === "details" && (
              <form id="tk-details" onSubmit={(e) => { e.preventDefault(); void save({ ...f, leadId: f.leadId || null }); }}>
                <div className="ws-field"><label className="ws-label" htmlFor="ps-name">Name</label><input id="ps-name" className="ws-input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, key: keyTouched ? f.key : suggest(e.target.value) })} placeholder="e.g. Website relaunch" /></div>
                <div className="ws-field"><label className="ws-label" htmlFor="ps-key">Key</label><input id="ps-key" className="ws-input" style={{ width: 140, textTransform: "uppercase" }} value={f.key} onChange={(e) => { setKeyTouched(true); setF({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) }); }} placeholder="WR" /><p className="ws-muted small">Issues are numbered with it: {f.key || "KEY"}-1, {f.key || "KEY"}-2…{project ? " Changing it renames every issue's key." : ""}</p></div>
                <div className="ws-field"><label className="ws-label" htmlFor="ps-desc">Description</label><textarea id="ps-desc" className="ws-textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
                <div className="ws-field"><span className="ws-label">Colour</span><div className="colors">{COLORS.map((c) => <button type="button" key={c} aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })} style={{ background: c }} className={f.color === c ? "on" : ""} />)}</div></div>
                {project && (
                  <div className="ws-field"><label className="ws-label" htmlFor="ps-lead">Project lead</label>
                    <select id="ps-lead" className="ws-input" value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value })}><option value="">None</option>{ctx.people.filter((p) => project.memberIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                  </div>
                )}
                {project && (
                  <div className="tk-danger">
                    <b>{project.archived ? "Restore this project" : "Archive this project"}</b>
                    <p className="ws-muted small">{project.archived ? "It comes back to everyone's project list." : "It disappears from lists and searches; nothing is deleted and you can restore it."}</p>
                    <button type="button" className="ws-btn danger" onClick={() => void save({ archived: !project.archived })}>{project.archived ? "Restore" : "Archive"}</button>
                  </div>
                )}
              </form>
            )}
            {tab === "workflow" && <Workflow statuses={statuses} setStatuses={setStatuses} />}
            {tab === "labels" && <Labels labels={labels} setLabels={setLabels} />}
            {tab === "fields" && <Fields fields={fields} setFields={setFields} />}
            {tab === "features" && <Features features={features} setFeatures={setFeatures} />}
            {tab === "quick" && <QuickFilters quick={quick} setQuick={setQuick} />}
            {tab === "components" && project && <Components ctx={ctx} project={project} />}
            {tab === "templates" && <Templates templates={templates} setTemplates={setTemplates} />}
            {tab === "people" && <People ctx={ctx} members={members} setMembers={setMembers} creator={project?.createdBy ?? ctx.me.id} />}
            {tab === "automation" && project && <Automation ctx={ctx} project={project} />}
            {tab === "repeating" && project && <Repeating ctx={ctx} project={project} />}
            {tab === "import" && project && <Import ctx={ctx} project={project} />}
            {err && <p className="ws-error">{err}</p>}
          </div>
        </div>
        {(tab === "details" || tab === "features" || tab === "quick" || tab === "workflow" || tab === "labels" || tab === "fields" || tab === "templates" || tab === "people") && (
          <footer>
            <button type="button" className="ws-btn" onClick={onClose}>Cancel</button>
            <button
              className="ws-btn primary"
              disabled={busy || !f.name.trim()}
              onClick={() => void save(tab === "features" ? { features } : tab === "quick" ? { quickFilters: quick } : tab === "workflow" ? { statuses } : tab === "labels" ? { labelDefs: labels } : tab === "fields" ? { fieldDefs: fields } : tab === "templates" ? { templates } : tab === "people" ? (project ? { members } : { ...f }) : { ...f, leadId: f.leadId || null })}
            >
              {project ? "Save" : "Create project"}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function Workflow({ statuses, setStatuses }: { statuses: Status[]; setStatuses: (s: Status[]) => void }) {
  const set = (i: number, patch: Partial<Status>) => setStatuses(statuses.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => {
    const n = [...statuses];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    setStatuses(n);
  };
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>The columns of your board, left to right. Each status belongs to a group: To do, In progress or Done. Issues in a Done status count as finished. A WIP limit stops more issues entering a column than it allows.</p>
      <div className="tk-wf">
        <div className="tk-wf-row head"><span /><span>Status</span><span>Group</span><span>WIP limit</span><span /></div>
        {statuses.map((s, i) => (
          <div key={s.id + i} className="tk-wf-row">
            <input type="color" value={s.color} onChange={(e) => set(i, { color: e.target.value })} aria-label={`Colour of ${s.name}`} />
            <input className="ws-input" value={s.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Status name" />
            <select className="ws-input" value={s.category} onChange={(e) => set(i, { category: e.target.value as Status["category"], wip: e.target.value === "done" ? null : s.wip })} aria-label="Group">
              <option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option>
            </select>
            <input className="ws-input" type="number" min={1} disabled={s.category === "done"} value={s.wip ?? ""} placeholder="None" onChange={(e) => set(i, { wip: e.target.value ? Number(e.target.value) : null })} aria-label="WIP limit" />
            <span className="tk-wf-act">
              <button type="button" className="ix-iconbtn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move left"><ArrowUp size={14} /></button>
              <button type="button" className="ix-iconbtn" disabled={i === statuses.length - 1} onClick={() => move(i, 1)} aria-label="Move right"><ArrowDown size={14} /></button>
              <button type="button" className="ix-iconbtn" disabled={statuses.length <= 2} onClick={() => setStatuses(statuses.filter((_, j) => j !== i))} aria-label={`Remove ${s.name}`}><Trash2 size={14} /></button>
            </span>
          </div>
        ))}
      </div>
      <button type="button" className="tk-addbtn" disabled={statuses.length >= 12} onClick={() => setStatuses([...statuses.slice(0, -1), { id: "", name: "New status", category: "doing", color: "#0891b2", wip: null }, ...statuses.slice(-1)])}><Plus size={14} /> Add a status</button>
    </div>
  );
}

function Labels({ labels, setLabels }: { labels: { name: string; color: string }[]; setLabels: (l: { name: string; color: string }[]) => void }) {
  const [n, setN] = useState("");
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>Shared labels are suggested when people tag issues, each with its own colour. People can still type new labels.</p>
      <div className="tk-labeldefs">
        {labels.map((l, i) => (
          <div key={l.name} className="tk-wf-row two">
            <input type="color" value={l.color} onChange={(e) => setLabels(labels.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} aria-label={`Colour of ${l.name}`} />
            <span className="tk-lbl" style={{ ["--lc" as string]: l.color }}>{l.name}</span>
            <button type="button" className="ix-iconbtn" onClick={() => setLabels(labels.filter((_, j) => j !== i))} aria-label={`Remove ${l.name}`}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
      <form className="ws-row" onSubmit={(e) => { e.preventDefault(); if (n.trim() && !labels.some((l) => l.name.toLowerCase() === n.trim().toLowerCase())) setLabels([...labels, { name: n.trim(), color: COLORS[labels.length % COLORS.length] }]); setN(""); }}>
        <input className="ws-input" style={{ maxWidth: 260 }} value={n} onChange={(e) => setN(e.target.value)} placeholder="New label, e.g. frontend" aria-label="New label" />
        <button className="ws-btn">Add</button>
      </form>
    </div>
  );
}

function Features({ features, setFeatures }: { features: Project["features"]; setFeatures: (f: Project["features"]) => void }) {
  const row = (k: "sprints" | "releases" | "components", title: string, body: string) => (
    <label className="tk-feature">
      <span className="tk-switch"><input type="checkbox" checked={features[k]} onChange={(e) => setFeatures({ ...features, [k]: e.target.checked })} /><span /></span>
      <span><b>{title}</b><br /><span className="ws-muted small">{body}</span></span>
    </label>
  );
  return (
    <div className="tk-features">
      <p className="ws-muted" style={{ marginTop: 0 }}>Turn on only what this team uses. A team working in a continuous flow (Kanban) can turn sprints off.</p>
      {row("sprints", "Sprints and backlog", "Plan work in time-boxed sprints from the Backlog. Off: a Kanban-style board with no sprints.")}
      {row("releases", "Releases", "Versions you ship, with a Fix version on issues, progress and release notes.")}
      {row("components", "Components", "Parts of the product, each with a lead who gets new issues by default.")}
      <div className="ws-field" style={{ marginTop: 12 }}>
        <span className="ws-label">Estimate work in</span>
        <div className="ws-seg" role="group" aria-label="Estimation"><button type="button" aria-pressed={features.estimation === "points"} onClick={() => setFeatures({ ...features, estimation: "points" })}>Story points</button><button type="button" aria-pressed={features.estimation === "time"} onClick={() => setFeatures({ ...features, estimation: "time" })}>Time (hours)</button></div>
      </div>
    </div>
  );
}

function QuickFilters({ quick, setQuick }: { quick: { id: string; name: string; query: string }[]; setQuick: (q: { id: string; name: string; query: string }[]) => void }) {
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>Buttons above the board for everyone in the project. Each uses the query language, e.g. <code>assignee is empty</code>, <code>flagged = true</code>, <code>labels in (frontend) AND priority &gt;= high</code>.</p>
      <div className="tk-wf">
        {quick.map((q, i) => (
          <div key={q.id || i} className="tk-field-def">
            <input className="ws-input" value={q.name} onChange={(e) => setQuick(quick.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Button name, e.g. Blocked" aria-label="Quick filter name" />
            <span />
            <button type="button" className="ix-iconbtn" onClick={() => setQuick(quick.filter((_, j) => j !== i))} aria-label={`Remove ${q.name}`}><Trash2 size={14} /></button>
            <input className="ws-input opts" style={{ fontFamily: "var(--font-mono)" }} value={q.query} onChange={(e) => setQuick(quick.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)))} placeholder="Query, e.g. flagged = true" aria-label="Quick filter query" />
          </div>
        ))}
      </div>
      <button type="button" className="tk-addbtn" disabled={quick.length >= 20} onClick={() => setQuick([...quick, { id: "", name: "", query: "" }])}><Plus size={14} /> Add a quick filter</button>
    </div>
  );
}

function Components({ ctx, project }: { ctx: Ctx; project: Project }) {
  const [list, setList] = useState<{ id: string; name: string; description: string; leadId: string | null; issues: number }[]>([]);
  const [f, setF] = useState({ name: "", description: "", leadId: "" });
  const load = () => void api(`/tasks/projects/${project.id}/components`).then((d) => setList(d.components)).catch(() => {});
  useEffect(load, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>Components are parts of the product, such as Checkout or Mobile app. New issues in a component go to its lead unless someone else is picked.</p>
      <ul className="tk-rules">
        {list.length === 0 && <li className="ws-muted">No components yet.</li>}
        {list.map((c) => (
          <li key={c.id}>
            <span className="grow"><b>{c.name}</b> <span className="ws-muted small">· {c.issues} issue{c.issues === 1 ? "" : "s"}{c.leadId ? ` · lead ${ctx.person(c.leadId)?.name}` : ""}</span>{c.description && <><br /><span className="ws-muted small">{c.description}</span></>}</span>
            <button className="ix-iconbtn" aria-label={`Delete ${c.name}`} onClick={async () => { await api(`/tasks/projects/${project.id}/components?id=${c.id}`, { method: "DELETE" }); load(); ctx.reload(); }}><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      <form className="tk-rule-edit" onSubmit={async (e) => { e.preventDefault(); try { await api(`/tasks/projects/${project.id}/components`, { body: { ...f, leadId: f.leadId || null } }); setF({ name: "", description: "", leadId: "" }); load(); ctx.reload(); } catch (er) { ctx.flash((er as Error).message); } }}>
        <div className="ws-row">
          <input className="ws-input" style={{ flex: 1 }} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Component name" aria-label="Component name" />
          <select className="ws-input" style={{ width: 180 }} value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value })} aria-label="Lead"><option value="">No lead</option>{ctx.people.filter((p) => project.memberIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </div>
        <input className="ws-input" style={{ marginTop: 6 }} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Description (optional)" aria-label="Description" />
        <button className="ws-btn primary" style={{ marginTop: 8 }} disabled={!f.name.trim()}>Add component</button>
      </form>
    </div>
  );
}

function Fields({ fields, setFields }: { fields: FieldDef[]; setFields: (f: FieldDef[]) => void }) {
  const set = (i: number, patch: Partial<FieldDef>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>Extra fields on every issue in this project, like Customer, Environment or Release. They show on the issue, can be searched and go into CSV exports.</p>
      <div className="tk-wf">
        {fields.map((f, i) => (
          <div key={f.id || i} className="tk-field-def">
            <input className="ws-input" value={f.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Field name" aria-label="Field name" />
            <select className="ws-input" value={f.type} onChange={(e) => set(i, { type: e.target.value as FieldDef["type"], options: e.target.value === "select" ? (f.options ?? []) : undefined })} aria-label="Field type">
              <option value="text">Text</option><option value="number">Number</option><option value="select">Choice list</option><option value="date">Date</option><option value="user">Person</option><option value="checkbox">Yes / no</option>
            </select>
            <button type="button" className="ix-iconbtn" onClick={() => setFields(fields.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><Trash2 size={14} /></button>
            {f.type === "select" && <input className="ws-input opts" value={(f.options ?? []).join(", ")} onChange={(e) => set(i, { options: e.target.value.split(",").map((o) => o.trimStart()) })} placeholder="Choices, comma-separated: Mobile, Web, API" aria-label="Choices" />}
          </div>
        ))}
      </div>
      <button type="button" className="tk-addbtn" disabled={fields.length >= 30} onClick={() => setFields([...fields, { id: "", name: "", type: "text" }])}><Plus size={14} /> Add a field</button>
    </div>
  );
}

function Templates({ templates, setTemplates }: { templates: Template[]; setTemplates: (t: Template[]) => void }) {
  const [i, setI] = useState<number | null>(null);
  const t = i === null ? null : templates[i];
  const set = (patch: Partial<Template>) => i !== null && setTemplates(templates.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>Templates pre-fill new issues, for example a bug report with steps to reproduce. They appear at the top of Create issue.</p>
      <ul className="tk-rules">
        {templates.length === 0 && <li className="ws-muted">No templates yet.</li>}
        {templates.map((x, j) => (
          <li key={x.id || j}>
            <span className="grow"><b>{x.name || "Untitled"}</b><br /><span className="ws-muted small">{TYPES.find((y) => y.id === x.type)?.label} · {x.title || "no summary"}</span></span>
            <button type="button" className="ws-btn" onClick={() => setI(j)}>Edit</button>
            <button type="button" className="ix-iconbtn" aria-label={`Delete ${x.name}`} onClick={() => { setTemplates(templates.filter((_, k) => k !== j)); setI(null); }}><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      {t ? (
        <div className="tk-rule-edit">
          <div className="ws-row">
            <div className="ws-field" style={{ flex: 2 }}><label className="ws-label" htmlFor="tp-n">Template name</label><input id="tp-n" className="ws-input" value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Bug report" /></div>
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="tp-t">Type</label><select id="tp-t" className="ws-input" value={t.type} onChange={(e) => set({ type: e.target.value })}>{TYPES.filter((y) => y.id !== "subtask").map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}</select></div>
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="tp-p">Priority</label><select id="tp-p" className="ws-input" value={t.priority} onChange={(e) => set({ priority: Number(e.target.value) })}>{PRIORITIES.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}</select></div>
          </div>
          <div className="ws-field"><label className="ws-label" htmlFor="tp-s">Summary</label><input id="tp-s" className="ws-input" value={t.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. [Bug] " /></div>
          <div className="ws-field"><label className="ws-label" htmlFor="tp-d">Description</label><textarea id="tp-d" className="ws-textarea" rows={6} value={t.description} onChange={(e) => set({ description: e.target.value })} placeholder={"**Steps to reproduce**\n1. \n\n**Expected**\n\n**Actual**"} /></div>
          <div className="ws-field"><label className="ws-label" htmlFor="tp-l">Labels</label><input id="tp-l" className="ws-input" value={t.labels.join(", ")} onChange={(e) => set({ labels: e.target.value.split(",").map((l) => l.trimStart()) })} /></div>
          <button type="button" className="ws-btn" onClick={() => setI(null)}>Done</button>
        </div>
      ) : (
        <button type="button" className="ws-btn" disabled={templates.length >= 30} onClick={() => { setTemplates([...templates, { id: "", name: "", type: "task", title: "", description: "", labels: [], priority: 1 }]); setI(templates.length); }}><Plus size={14} /> New template</button>
      )}
      <p className="ws-muted small">Save to keep your changes.</p>
    </div>
  );
}

function People({ ctx, members, setMembers, creator }: { ctx: Ctx; members: { userId: string; role: string }[]; setMembers: (m: { userId: string; role: string }[]) => void; creator: string }) {
  const [q, setQ] = useState("");
  const others = ctx.people.filter((p) => !members.some((m) => m.userId === p.id) && `${p.name} ${p.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>Admins change settings, members work on issues, viewers can only look.</p>
      <ul className="tk-people">
        {members.map((m) => {
          const p = ctx.person(m.userId);
          return (
            <li key={m.userId}>
              <Avatar person={p} size={28} />
              <span className="grow"><b>{p?.name ?? "Someone"}</b> <span className="ws-muted">{p?.email}</span></span>
              <select className="ws-input" style={{ width: 120 }} value={m.role} disabled={m.userId === creator} onChange={(e) => setMembers(members.map((x) => (x.userId === m.userId ? { ...x, role: e.target.value } : x)))} aria-label={`Role of ${p?.name}`}>
                <option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option>
              </select>
              <button type="button" className="ix-iconbtn" disabled={m.userId === creator} onClick={() => setMembers(members.filter((x) => x.userId !== m.userId))} aria-label={`Remove ${p?.name}`}><X size={14} /></button>
            </li>
          );
        })}
      </ul>
      <input className="ws-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add people: search by name or email" aria-label="Find people" />
      {(q || others.length <= 6) && (
        <ul className="tk-people add">
          {others.slice(0, 8).map((p) => (
            <li key={p.id}><Avatar person={p} size={24} /><span className="grow">{p.name} <span className="ws-muted">{p.email}</span></span><button type="button" className="ws-btn" onClick={() => { setMembers([...members, { userId: p.id, role: "member" }]); setQ(""); }}><Plus size={13} /> Add</button></li>
          ))}
          {!others.length && <li className="ws-muted">Everyone in the workspace is already in this project.</li>}
        </ul>
      )}
    </div>
  );
}

type Rule = { id: string; name: string; trigger: { on: string; status?: string }; actions: { do: string; value: string }[]; enabled: boolean; runs: number };

function Automation({ ctx, project }: { ctx: Ctx; project: Project }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [edit, setEdit] = useState<Partial<Rule> | null>(null);
  const load = () => void api(`/tasks/projects/${project.id}/rules`).then((d) => setRules(d.rules)).catch(() => {});
  useEffect(load, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const statusName = (id?: string) => project.statuses.find((s) => s.id === id)?.name ?? "any status";
  const describe = (r: Partial<Rule>) =>
    `When ${r.trigger?.on === "created" ? "an issue is created" : r.trigger?.on === "assigned" ? "an issue is assigned" : `an issue moves to ${statusName(r.trigger?.status)}`}: ${(r.actions ?? []).map((a) => (a.do === "assign" ? `assign to ${a.value === "reporter" ? "the reporter" : a.value === "unassigned" ? "nobody" : (ctx.person(a.value)?.name ?? "someone")}` : a.do === "status" ? `move to ${statusName(a.value)}` : a.do === "label" ? `add label "${a.value}"` : a.do === "comment" ? "add a comment" : `notify ${a.value === "assignee" ? "the assignee" : a.value === "reporter" ? "the reporter" : (ctx.person(a.value)?.name ?? "someone")}`)).join(", ")}`;
  async function save() {
    try {
      await api(`/tasks/projects/${project.id}/rules`, { body: edit });
      setEdit(null);
      load();
    } catch (e) {
      ctx.flash((e as Error).message);
    }
  }
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>Rules do routine work for you: when something happens to an issue, they assign it, move it, label it, comment or tell someone.</p>
      <ul className="tk-rules">
        {rules.length === 0 && <li className="ws-muted">No rules yet.</li>}
        {rules.map((r) => (
          <li key={r.id}>
            <label className="tk-switch"><input type="checkbox" checked={r.enabled} onChange={async () => { await api(`/tasks/projects/${project.id}/rules`, { body: { ...r, enabled: !r.enabled } }).catch((e) => ctx.flash(e.message)); load(); }} aria-label={`Turn ${r.name} ${r.enabled ? "off" : "on"}`} /><span /></label>
            <span className="grow"><b>{r.name}</b><br /><span className="ws-muted small">{describe(r)} · ran {r.runs} time{r.runs === 1 ? "" : "s"}</span></span>
            <button className="ws-btn" onClick={() => setEdit(r)}>Edit</button>
            <button className="ix-iconbtn" aria-label={`Delete ${r.name}`} onClick={async () => { await api(`/tasks/projects/${project.id}/rules?id=${r.id}`, { method: "DELETE" }); load(); }}><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      {edit ? (
        <div className="tk-rule-edit">
          <div className="ws-field"><label className="ws-label" htmlFor="ru-name">Name</label><input id="ru-name" className="ws-input" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Bugs go to QA lead" /></div>
          <div className="ws-row">
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="ru-on">When</label>
              <select id="ru-on" className="ws-input" value={edit.trigger?.on ?? "status"} onChange={(e) => setEdit({ ...edit, trigger: { on: e.target.value } })}><option value="created">An issue is created</option><option value="status">An issue changes status</option><option value="assigned">An issue is assigned</option></select>
            </div>
            {(edit.trigger?.on ?? "status") === "status" && (
              <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="ru-st">To</label>
                <select id="ru-st" className="ws-input" value={edit.trigger?.status ?? ""} onChange={(e) => setEdit({ ...edit, trigger: { on: "status", status: e.target.value || undefined } })}><option value="">Any status</option>{project.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </div>
            )}
          </div>
          <span className="ws-label">Then</span>
          {(edit.actions ?? []).map((a, i) => (
            <div key={i} className="ws-row" style={{ marginBottom: 6 }}>
              <select className="ws-input" style={{ width: 170 }} value={a.do} onChange={(e) => setEdit({ ...edit, actions: edit.actions!.map((x, j) => (j === i ? { do: e.target.value, value: "" } : x)) })} aria-label="Action">
                <option value="assign">Assign to</option><option value="status">Move to</option><option value="label">Add label</option><option value="comment">Add comment</option><option value="notify">Notify</option>
              </select>
              {a.do === "assign" || a.do === "notify" ? (
                <select className="ws-input" style={{ flex: 1 }} value={a.value} onChange={(e) => setEdit({ ...edit, actions: edit.actions!.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} aria-label="Who">
                  <option value="">Choose…</option>
                  {a.do === "assign" ? <><option value="reporter">The reporter</option><option value="unassigned">Nobody (unassign)</option></> : <><option value="assignee">The assignee</option><option value="reporter">The reporter</option></>}
                  {ctx.people.filter((p) => project.memberIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : a.do === "status" ? (
                <select className="ws-input" style={{ flex: 1 }} value={a.value} onChange={(e) => setEdit({ ...edit, actions: edit.actions!.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} aria-label="Status"><option value="">Choose…</option>{project.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              ) : (
                <input className="ws-input" style={{ flex: 1 }} value={a.value} onChange={(e) => setEdit({ ...edit, actions: edit.actions!.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} placeholder={a.do === "label" ? "Label" : "Comment text"} aria-label="Value" />
              )}
              <button type="button" className="ix-iconbtn" onClick={() => setEdit({ ...edit, actions: edit.actions!.filter((_, j) => j !== i) })} aria-label="Remove action"><X size={14} /></button>
            </div>
          ))}
          <button type="button" className="tk-addbtn" disabled={(edit.actions ?? []).length >= 5} onClick={() => setEdit({ ...edit, actions: [...(edit.actions ?? []), { do: "assign", value: "" }] })}><Plus size={14} /> Add an action</button>
          <p className="ws-muted small">{describe({ ...edit, trigger: edit.trigger ?? { on: "status" } })}</p>
          <div className="ws-row"><button className="ws-btn primary" onClick={() => void save()}>Save rule</button><button className="ws-btn ghost" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      ) : (
        <button className="ws-btn" onClick={() => setEdit({ name: "", trigger: { on: "status" }, actions: [{ do: "assign", value: "" }], enabled: true })}><Plus size={14} /> New rule</button>
      )}
    </div>
  );
}

type Rec = { id: string; template: { title: string; dueInDays: number | null; assigneeId: string | null; type: string }; rule: { every: string; interval: number; weekdays?: number[] }; nextAt: string; enabled: boolean };
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Repeating({ ctx, project }: { ctx: Ctx; project: Project }) {
  const [list, setList] = useState<Rec[]>([]);
  const [f, setF] = useState({ title: "", type: "task", assigneeId: "", every: "week", interval: 1, weekdays: [1] as number[], dueInDays: "", start: new Date().toISOString().slice(0, 10) });
  const load = () => void api(`/tasks/projects/${project.id}/recurring`).then((d) => setList(d.recurring)).catch(() => {});
  useEffect(load, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/tasks/projects/${project.id}/recurring`, { body: { template: { title: f.title, type: f.type, assigneeId: f.assigneeId || null, dueInDays: f.dueInDays === "" ? null : Number(f.dueInDays) }, rule: { every: f.every, interval: f.interval, weekdays: f.every === "week" ? f.weekdays : undefined }, startAt: new Date(`${f.start}T08:00:00`).toISOString() } });
      setF({ ...f, title: "" });
      load();
    } catch (er) {
      ctx.flash((er as Error).message);
    }
  }
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>A repeating issue is created for you on a schedule, for chores like a weekly report or monthly invoicing.</p>
      <ul className="tk-rules">
        {list.length === 0 && <li className="ws-muted">Nothing repeats yet.</li>}
        {list.map((r) => (
          <li key={r.id}>
            <span className="grow"><b>{r.template.title}</b><br /><span className="ws-muted small">Every {r.rule.interval > 1 ? `${r.rule.interval} ` : ""}{r.rule.every}{r.rule.interval > 1 ? "s" : ""}{r.rule.weekdays?.length ? ` on ${r.rule.weekdays.map((d) => WD[d]).join(", ")}` : ""} · next {new Date(r.nextAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}{r.template.assigneeId ? ` · for ${ctx.person(r.template.assigneeId)?.name}` : ""}</span></span>
            <button className="ix-iconbtn" aria-label="Delete" onClick={async () => { await api(`/tasks/projects/${project.id}/recurring?id=${r.id}`, { method: "DELETE" }); load(); }}><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      <form className="tk-rule-edit" onSubmit={add}>
        <div className="ws-field"><label className="ws-label" htmlFor="rc-t">Issue summary</label><input id="rc-t" className="ws-input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Send the weekly status report" /></div>
        <div className="ws-row">
          <label className="ws-row">Every <input className="ws-input" style={{ width: 64 }} type="number" min={1} max={12} value={f.interval} onChange={(e) => setF({ ...f, interval: Number(e.target.value) || 1 })} aria-label="Interval" />
            <select className="ws-input" style={{ width: 110 }} value={f.every} onChange={(e) => setF({ ...f, every: e.target.value })} aria-label="Unit"><option value="day">day(s)</option><option value="week">week(s)</option><option value="month">month(s)</option></select>
          </label>
          <label className="ws-row">Starting <input className="ws-input" type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} aria-label="Start" /></label>
        </div>
        {f.every === "week" && <div className="daypick" style={{ margin: "8px 0" }}>{WD.map((d, i) => <button type="button" key={d} aria-pressed={f.weekdays.includes(i)} className={f.weekdays.includes(i) ? "on" : ""} onClick={() => setF({ ...f, weekdays: f.weekdays.includes(i) ? f.weekdays.filter((x) => x !== i) : [...f.weekdays, i] })}>{d[0]}</button>)}</div>}
        <div className="ws-row">
          <select className="ws-input" style={{ flex: 1 }} value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })} aria-label="Assignee"><option value="">Unassigned</option>{ctx.people.filter((p) => project.memberIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <label className="ws-row">Due <input className="ws-input" style={{ width: 70 }} type="number" min={0} value={f.dueInDays} onChange={(e) => setF({ ...f, dueInDays: e.target.value })} aria-label="Due in days" /> days after</label>
          <button className="ws-btn primary" disabled={!f.title.trim()}>Add</button>
        </div>
      </form>
    </div>
  );
}

function Import({ ctx, project }: { ctx: Ctx; project: Project }) {
  const [res, setRes] = useState<{ created: number; errors: { row: number; error: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <p className="ws-muted" style={{ marginTop: 0 }}>Bring issues in from a spreadsheet or another tool. Use a CSV with a header row: <b>Title</b> is required; Type, Status, Priority, Assignee (email), Labels, Due (YYYY-MM-DD), Story points and Description are optional. Up to 1,000 rows.</p>
      <label className="ws-btn">
        {busy ? "Importing…" : "Choose a CSV file"}
        <input type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          const form = new FormData();
          form.append("file", file);
          const r = await fetch(`${BASE}/api/tasks/projects/${project.id}/import`, { method: "POST", body: form });
          const d = await r.json().catch(() => ({}));
          setBusy(false);
          if (!r.ok) return ctx.flash(d.error ?? "Import failed");
          setRes(d);
          ctx.reload();
        }} />
      </label>
      <a className="ws-btn ghost" href={`${BASE}/api/tasks/export?projectId=${project.id}`}>Export this project to CSV</a>
      {res && (
        <div className="tk-rule-edit">
          <b>{res.created} issue{res.created === 1 ? "" : "s"} imported.</b>
          {res.errors.length > 0 && <ul className="small">{res.errors.slice(0, 20).map((e) => <li key={e.row}>Row {e.row}: {e.error}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
