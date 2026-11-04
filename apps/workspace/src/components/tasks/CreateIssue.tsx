"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/client";
import { MentionBox, PRIORITIES, TypeIcon, TYPES, type Task } from "./ui";
import type { Ctx } from "./TasksApp";

/** Create an issue: project, type, summary, description and the main fields; "Create another" keeps the form open. */
export default function CreateIssue({ ctx, preset, defaultProject, onClose, onCreated }: { ctx: Ctx; preset: Partial<Task>; defaultProject?: string; onClose: () => void; onCreated: (t: Task, again: boolean) => void }) {
  const writable = ctx.projects.filter((p) => p.myRole !== "viewer");
  const [projectId, setProjectId] = useState(preset.projectId ?? (writable.some((p) => p.id === defaultProject) ? defaultProject! : writable[0]?.id ?? ""));
  const project = ctx.projects.find((p) => p.id === projectId);
  const [f, setF] = useState({
    type: preset.type ?? "task", title: "", description: "", priority: 1, assigneeId: preset.assigneeId ?? "", epicId: preset.epicId ?? "", sprintId: preset.sprintId ?? "",
    labels: "", due: preset.due ?? "", points: "", versionId: preset.versionId ?? "", componentIds: [] as string[],
  });
  const [again, setAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const members = ctx.people.filter((p) => project?.memberIds.includes(p.id));
  const epics = ctx.epics.filter((e) => e.projectId === projectId);
  const sprints = ctx.sprints.filter((s) => s.projectId === projectId && s.state !== "closed");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Add a summary.");
    setBusy(true);
    setErr("");
    try {
      const d = await api<{ task: Task }>("/tasks", {
        body: {
          projectId, type: f.type, title: f.title, description: f.description, priority: f.priority, assigneeId: f.assigneeId || null,
          epicId: f.type !== "epic" ? f.epicId || null : null, sprintId: f.sprintId || null, labels: f.labels.split(",").map((l) => l.trim()).filter(Boolean),
          due: f.due || null, points: f.points === "" ? null : Number(f.points),
          versionId: f.versionId || null, componentIds: f.componentIds,
        },
      });
      onCreated(d.task, again);
      if (again) setF((x) => ({ ...x, title: "", description: "" }));
    } catch (er) {
      setErr((er as Error).message);
    }
    setBusy(false);
  }

  if (!writable.length)
    return (
      <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="ws-modal" role="dialog" aria-label="Create issue"><header><h3>Create issue</h3><button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button></header><div className="body"><p>You need a project you can edit first.</p></div></div>
      </div>
    );

  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="ws-modal wide" role="dialog" aria-label="Create issue" onSubmit={submit} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit(e); }}>
        <header><h3>Create issue</h3><button type="button" className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <div className="body tk-create">
          {(project?.templates ?? []).length > 0 && (
            <div className="tk-templates" role="group" aria-label="Start from a template">
              <span className="ws-muted">Start from:</span>
              {project!.templates.map((tp) => (
                <button type="button" key={tp.id} className="ws-chip" onClick={() => setF({ ...f, type: tp.type, title: tp.title, description: tp.description, labels: tp.labels.join(", "), priority: tp.priority })}>
                  {tp.name}
                </button>
              ))}
            </div>
          )}
          <div className="ws-row">
            <div className="ws-field" style={{ flex: 2, minWidth: 180 }}>
              <label className="ws-label" htmlFor="ci-proj">Project</label>
              <select id="ci-proj" className="ws-input" value={projectId} onChange={(e) => { setProjectId(e.target.value); setF({ ...f, epicId: "", sprintId: "", assigneeId: "" }); }}>
                {writable.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
              </select>
            </div>
            <div className="ws-field" style={{ flex: 1, minWidth: 140 }}>
              <label className="ws-label" htmlFor="ci-type">Issue type</label>
              <div className="tk-who"><TypeIcon type={f.type} /><select id="ci-type" className="ws-input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.filter((t) => t.id !== "subtask").map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></div>
            </div>
          </div>
          <div className="ws-field">
            <label className="ws-label" htmlFor="ci-title">Summary</label>
            <input id="ci-title" className="ws-input tk-big" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={f.type === "bug" ? "What's broken?" : f.type === "epic" ? "A big piece of work, e.g. Checkout revamp" : "What needs to be done?"} />
          </div>
          <div className="ws-field">
            <label className="ws-label" htmlFor="ci-desc">Description</label>
            <MentionBox id="ci-desc" value={f.description} onChange={(v) => setF({ ...f, description: v })} people={members} rows={5} placeholder={f.type === "bug" ? "Steps to reproduce, what you expected and what happened." : "Details, acceptance criteria, links. Markdown works."} />
          </div>
          <div className="tk-create-grid">
            <div className="ws-field"><label className="ws-label" htmlFor="ci-as">Assignee</label>
              <select id="ci-as" className="ws-input" value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}><option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === ctx.me.id ? " (me)" : ""}</option>)}</select>
            </div>
            <div className="ws-field"><label className="ws-label" htmlFor="ci-pr">Priority</label>
              <select id="ci-pr" className="ws-input" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>{PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
            </div>
            {f.type !== "epic" && (
              <div className="ws-field"><label className="ws-label" htmlFor="ci-ep">Epic</label>
                <select id="ci-ep" className="ws-input" value={f.epicId} onChange={(e) => setF({ ...f, epicId: e.target.value })}><option value="">None</option>{epics.map((e) => <option key={e.id} value={e.id}>{e.key} {e.title}</option>)}</select>
              </div>
            )}
            <div className="ws-field"><label className="ws-label" htmlFor="ci-sp">Sprint</label>
              <select id="ci-sp" className="ws-input" value={f.sprintId} onChange={(e) => setF({ ...f, sprintId: e.target.value })}><option value="">Backlog</option>{sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === "active" ? " (active)" : ""}</option>)}</select>
            </div>
            <div className="ws-field"><label className="ws-label" htmlFor="ci-pts">Story points</label><input id="ci-pts" className="ws-input" type="number" min={0} step={0.5} value={f.points} onChange={(e) => setF({ ...f, points: e.target.value })} /></div>
            <div className="ws-field"><label className="ws-label" htmlFor="ci-due">Due date</label><input id="ci-due" className="ws-input" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></div>
          </div>
          {project && (ctx.versions.some((v) => v.status === "unreleased") || ctx.components.length > 0) && project.id === ctx.project?.id && (
            <div className="tk-create-grid">
              {ctx.versions.some((v) => v.status === "unreleased") && (
                <div className="ws-field"><label className="ws-label" htmlFor="ci-ver">Fix version</label>
                  <select id="ci-ver" className="ws-input" value={f.versionId} onChange={(e) => setF({ ...f, versionId: e.target.value })}><option value="">None</option>{ctx.versions.filter((v) => v.status === "unreleased").map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
                </div>
              )}
              {ctx.components.length > 0 && (
                <div className="ws-field" style={{ gridColumn: "span 2" }}><span className="ws-label">Components</span>
                  <div className="tk-chiprow" style={{ padding: 0 }}>{ctx.components.map((c) => <button type="button" key={c.id} className={`ws-chip${f.componentIds.includes(c.id) ? " on" : ""}`} onClick={() => setF({ ...f, componentIds: f.componentIds.includes(c.id) ? f.componentIds.filter((x) => x !== c.id) : [...f.componentIds, c.id] })}>{c.name}</button>)}</div>
                </div>
              )}
            </div>
          )}
          <div className="ws-field"><label className="ws-label" htmlFor="ci-lb">Labels</label><input id="ci-lb" className="ws-input" list="ci-labels" value={f.labels} onChange={(e) => setF({ ...f, labels: e.target.value })} placeholder="Comma-separated, e.g. frontend, q4" /><datalist id="ci-labels">{(project?.labelDefs ?? []).map((l) => <option key={l.name} value={l.name} />)}</datalist></div>
          {err && <p className="ws-error">{err}</p>}
        </div>
        <footer>
          <label className="ws-row" style={{ marginRight: "auto", gap: 6 }}><input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} /> Create another</label>
          <button type="button" className="ws-btn" onClick={onClose}>Cancel</button>
          <button className="ws-btn primary" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </footer>
      </form>
    </div>
  );
}
