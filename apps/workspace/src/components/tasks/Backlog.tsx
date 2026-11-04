"use client";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Flag, Layers, MoreHorizontal, Package, Play, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/client";
import { Avatar, Menu, PriorityIcon, StatusPill, TypeIcon, type Sprint, type Task } from "./ui";
import { Empty, type Ctx } from "./TasksApp";
import { FlagDialog, useStored } from "./Board";

/**
 * The backlog: the running sprint, planned sprints and the backlog. Drag to
 * plan and to rank (several at once with Ctrl/Shift-click); epic and version
 * panels (E, V) filter it and take drops; sprints start and complete here.
 */
export default function Backlog({ ctx, tasks }: { ctx: Ctx; tasks: Task[] }) {
  const { project, sprints, flash, canWrite } = ctx;
  const [drag, setDrag] = useState<string[] | null>(null);
  const [over, setOver] = useState<{ box: string; before: string | null } | null>(null);
  const [starting, setStarting] = useState<Sprint | null>(null);
  const [completing, setCompleting] = useState<Sprint | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [panels, setPanels] = useStored<{ epic: boolean; version: boolean; compact: boolean }>("tk-backlog-panels", { epic: false, version: false, compact: false });
  const [epicFilter, setEpicFilter] = useState<string | null>(null);
  const [versionFilter, setVersionFilter] = useState<string | null>(null);
  const [flagging, setFlagging] = useState<Task | null>(null);

  // E and V open and close the epic and version panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || document.querySelector(".ws-modal-scrim")) return;
      if (e.key === "e") setPanels({ ...panels, epic: !panels.epic });
      else if (e.key === "v" && project?.features.releases !== false) setPanels({ ...panels, version: !panels.version });
      else if (e.key === "Escape") setSel([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panels, setPanels, project]);

  const open = useMemo(() => sprints.filter((s) => s.state !== "closed").sort((a, b) => (a.state === "active" ? -1 : b.state === "active" ? 1 : a.createdAt?.localeCompare?.(b.createdAt ?? "") ?? 0)), [sprints]);
  if (!project) return null;
  const items = tasks.filter((t) => t.type !== "epic" && (!epicFilter || (epicFilter === "none" ? !t.epicId : t.epicId === epicFilter)) && (!versionFilter || (versionFilter === "none" ? !t.versionId : t.versionId === versionFilter)));
  const sprintsOn = project.features.sprints !== false;
  const boxes: { id: string; sprint: Sprint | null; tasks: Task[] }[] = [
    ...(sprintsOn ? open.map((s) => ({ id: s.id, sprint: s, tasks: items.filter((t) => t.sprintId === s.id).sort((a, b) => a.position - b.position) })) : []),
    { id: "backlog", sprint: null, tasks: items.filter((t) => (!t.sprintId || !open.some((s) => s.id === t.sprintId)) && !(t.done && t.sprintId)).sort((a, b) => a.position - b.position) },
  ];
  const flat = boxes.flatMap((b) => (shut.has(b.id) ? [] : b.tasks));

  function click(e: React.MouseEvent, t: Task) {
    if (e.shiftKey && anchor) {
      const a = flat.findIndex((x) => x.id === anchor);
      const b = flat.findIndex((x) => x.id === t.id);
      if (a >= 0 && b >= 0) setSel(flat.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSel((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]));
      setAnchor(t.id);
      return;
    }
    setSel([]);
    ctx.open(t.id);
  }

  async function dropInto(boxId: string, before: string | null) {
    const ids = drag;
    setDrag(null);
    setOver(null);
    if (!ids?.length) return;
    const box = boxes.find((b) => b.id === boxId)!;
    const rest = box.tasks.filter((t) => !ids.includes(t.id));
    const idx = before ? rest.findIndex((t) => t.id === before) : rest.length;
    const prev = rest[idx - 1]?.position ?? (rest[0]?.position ?? 1000) - 1000;
    const next = rest[idx]?.position ?? prev + 1000 * (ids.length + 1);
    const step = (next - prev) / (ids.length + 1);
    // Keep the dragged issues in their current order.
    const ordered = flat.filter((t) => ids.includes(t.id)).concat(tasks.filter((t) => ids.includes(t.id) && !flat.includes(t)));
    for (const [i, t] of ordered.entries()) {
      const body: Record<string, unknown> = { position: prev + step * (i + 1) };
      if ((t.sprintId ?? "backlog") !== boxId) body.sprintId = boxId === "backlog" ? null : boxId;
      await ctx.patch(t.id, body);
    }
    setSel([]);
  }
  async function toEdge(t: Task, edge: "top" | "bottom") {
    const box = boxes.find((b) => b.tasks.includes(t));
    const others = (box?.tasks ?? []).filter((x) => x.id !== t.id).map((x) => x.position);
    if (others.length) await ctx.patch(t.id, { position: edge === "top" ? Math.min(...others) - 1000 : Math.max(...others) + 1000 });
  }
  async function bulkTo(body: Record<string, unknown>) {
    for (const id of sel) await ctx.patch(id, body);
    setSel([]);
  }
  async function newSprint() {
    try {
      await api(`/tasks/projects/${project!.id}/sprints`, { body: {} });
      ctx.reload();
    } catch (e) {
      flash((e as Error).message);
    }
  }
  async function quickAdd(boxId: string) {
    if (!draft.trim()) return;
    try {
      await api("/tasks", { body: { projectId: project!.id, title: draft.trim(), ...(boxId !== "backlog" ? { sprintId: boxId } : {}), ...(epicFilter && epicFilter !== "none" ? { epicId: epicFilter } : {}), ...(versionFilter && versionFilter !== "none" ? { versionId: versionFilter } : {}) } });
      setDraft("");
      ctx.reload();
    } catch (e) {
      flash((e as Error).message);
    }
  }
  const dropOnPanel = async (body: Record<string, unknown>) => {
    const ids = drag;
    setDrag(null);
    setOver(null);
    for (const id of ids ?? []) await ctx.patch(id, body);
    setSel([]);
  };

  if (!tasks.filter((t) => t.type !== "epic").length && !open.length && !panels.epic)
    return <Empty title="Plan your work here" body="The backlog is the list of everything still to do. Add issues, then group them into a sprint (usually two weeks) and start it." action={canWrite ? <div className="ws-row" style={{ justifyContent: "center" }}><button className="ws-btn primary" onClick={() => ctx.create()}><Plus size={15} /> Create an issue</button>{sprintsOn && <button className="ws-btn" onClick={newSprint}>Create sprint</button>}</div> : null} />;

  return (
    <div className={`tk-backlog-wrap${panels.compact ? " compact" : ""}`}>
      {(panels.epic || panels.version) && (
        <aside className="tk-bl-panels">
          {panels.epic && (
            <section>
              <header><b><Layers size={14} /> Epics</b><button className="ix-iconbtn" aria-label="Close epics panel" onClick={() => setPanels({ ...panels, epic: false })}><X size={14} /></button></header>
              <button className={`tk-panel-item${!epicFilter ? " on" : ""}`} onClick={() => setEpicFilter(null)}>All issues</button>
              {ctx.epics.map((e) => {
                const kids = tasks.filter((t) => t.epicId === e.id);
                const done = kids.filter((k) => k.done).length;
                return (
                  <button key={e.id} className={`tk-panel-item${epicFilter === e.id ? " on" : ""}${over?.box === `epic:${e.id}` ? " drop" : ""}`} onClick={() => setEpicFilter(epicFilter === e.id ? null : e.id)}
                    onDragOver={(ev) => { if (drag) { ev.preventDefault(); setOver({ box: `epic:${e.id}`, before: null }); } }} onDrop={(ev) => { ev.preventDefault(); void dropOnPanel({ epicId: e.id }); }}>
                    <span className="nm"><TypeIcon type="epic" size={13} /> {e.title}</span>
                    <span className="tk-minibar"><span style={{ width: `${kids.length ? (done / kids.length) * 100 : 0}%` }} /></span>
                    <small className="ws-muted">{done}/{kids.length} done</small>
                  </button>
                );
              })}
              <button className={`tk-panel-item${epicFilter === "none" ? " on" : ""}`} onClick={() => setEpicFilter(epicFilter === "none" ? null : "none")} onDragOver={(ev) => { if (drag) ev.preventDefault(); }} onDrop={(ev) => { ev.preventDefault(); void dropOnPanel({ epicId: null }); }}>Issues without epic</button>
              {canWrite && <button className="tk-addbtn" onClick={() => ctx.create({ type: "epic" })}><Plus size={14} /> Create epic</button>}
            </section>
          )}
          {panels.version && (
            <section>
              <header><b><Package size={14} /> Versions</b><button className="ix-iconbtn" aria-label="Close versions panel" onClick={() => setPanels({ ...panels, version: false })}><X size={14} /></button></header>
              <button className={`tk-panel-item${!versionFilter ? " on" : ""}`} onClick={() => setVersionFilter(null)}>All issues</button>
              {ctx.versions.filter((v) => v.status === "unreleased").map((v) => (
                <button key={v.id} className={`tk-panel-item${versionFilter === v.id ? " on" : ""}${over?.box === `ver:${v.id}` ? " drop" : ""}`} onClick={() => setVersionFilter(versionFilter === v.id ? null : v.id)}
                  onDragOver={(ev) => { if (drag) { ev.preventDefault(); setOver({ box: `ver:${v.id}`, before: null }); } }} onDrop={(ev) => { ev.preventDefault(); void dropOnPanel({ versionId: v.id }); }}>
                  <span className="nm">{v.name}</span>
                  <span className="tk-minibar"><span style={{ width: `${v.issues ? (v.done / v.issues) * 100 : 0}%` }} /></span>
                  <small className="ws-muted">{v.releaseDate ? `Release ${new Date(v.releaseDate).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" })} · ` : ""}{v.done}/{v.issues} done</small>
                </button>
              ))}
              <button className={`tk-panel-item${versionFilter === "none" ? " on" : ""}`} onClick={() => setVersionFilter(versionFilter === "none" ? null : "none")}>Issues without version</button>
              <p className="ws-muted small">Drag issues onto a version to set their fix version. Manage versions under Releases.</p>
            </section>
          )}
        </aside>
      )}
      <div className="tk-backlog">
        <div className="tk-boardbar" style={{ padding: "0 0 4px" }}>
          <button className={`ws-btn${panels.epic ? " on" : ""}`} onClick={() => setPanels({ ...panels, epic: !panels.epic })} title="Epic panel (E)"><Layers size={14} /> Epics</button>
          {project.features.releases !== false && <button className={`ws-btn${panels.version ? " on" : ""}`} onClick={() => setPanels({ ...panels, version: !panels.version })} title="Version panel (V)"><Package size={14} /> Versions</button>}
          <label className="tk-check"><input type="checkbox" checked={panels.compact} onChange={(e) => setPanels({ ...panels, compact: e.target.checked })} /> Compact</label>
          <span style={{ flex: 1 }} />
          {sel.length > 0 ? (
            <div className="tk-bulk">
              <b>{sel.length} selected</b>
              {sprintsOn && <select aria-label="Move selected to" value="" onChange={(e) => void bulkTo({ sprintId: e.target.value === "backlog" ? null : e.target.value })}><option value="">Move to…</option>{open.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="backlog">Backlog</option></select>}
              <select aria-label="Set epic" value="" onChange={(e) => void bulkTo({ epicId: e.target.value === "none" ? null : e.target.value })}><option value="">Epic…</option>{ctx.epics.map((ep) => <option key={ep.id} value={ep.id}>{ep.title}</option>)}<option value="none">No epic</option></select>
              <button className="ix-iconbtn" onClick={() => setSel([])} aria-label="Clear selection"><X size={15} /></button>
            </div>
          ) : (
            <span className="ws-muted small">Ctrl or Shift-click to select several; drag to rank or plan.</span>
          )}
        </div>
        {boxes.map((b) => {
          const pts = b.tasks.reduce((a, t) => a + (t.points ?? 0), 0);
          const cats = { todo: 0, doing: 0, done: 0 };
          for (const t of b.tasks) cats[project.statuses.find((s) => s.id === t.status)?.category ?? "todo"]++;
          const isShut = shut.has(b.id);
          return (
            <section key={b.id} className={`tk-bl-box${over?.box === b.id ? " drop" : ""}${b.id === "backlog" ? " backlog" : ""}`}
              onDragOver={(e) => { if (!drag) return; e.preventDefault(); if (over?.box !== b.id) setOver({ box: b.id, before: null }); }}
              onDrop={(e) => { e.preventDefault(); void dropInto(b.id, over?.box === b.id ? over.before : null); }}>
              <header className="tk-bl-head">
                <button className="ix-iconbtn" style={{ width: 24, height: 24 }} onClick={() => setShut((s) => { const n = new Set(s); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n; })} aria-expanded={!isShut} aria-label={isShut ? "Expand" : "Collapse"}>{isShut ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button>
                <b>{b.sprint ? b.sprint.name : "Backlog"}</b>
                {b.sprint?.state === "active" && <span className="tk-badge live">Active</span>}
                {b.sprint?.startAt && <span className="ws-muted">{new Date(b.sprint.startAt).toLocaleDateString([], { day: "numeric", month: "short" })} – {b.sprint.endAt ? new Date(b.sprint.endAt).toLocaleDateString([], { day: "numeric", month: "short" }) : "…"}</span>}
                <span className="ws-muted">({b.tasks.length} issues)</span>
                <span style={{ flex: 1 }} />
                <span className="tk-catcount" title="To do / In progress / Done"><span className="c-todo">{cats.todo}</span><span className="c-doing">{cats.doing}</span><span className="c-done">{cats.done}</span></span>
                {pts > 0 && <span className="tk-points" title="Story points">{pts}</span>}
                {canWrite && b.sprint?.state === "planned" && <button className="ws-btn" onClick={() => setStarting(b.sprint)} disabled={open.some((s) => s.state === "active")} title={open.some((s) => s.state === "active") ? "Complete the running sprint first" : "Start this sprint"}><Play size={13} /> Start sprint</button>}
                {canWrite && b.sprint?.state === "active" && <button className="ws-btn" onClick={() => setCompleting(b.sprint)}><Flag size={13} /> Complete sprint</button>}
                {canWrite && b.sprint?.state === "planned" && (
                  <button className="ix-iconbtn" aria-label={`Delete ${b.sprint.name}`} title="Delete sprint (its issues go back to the backlog)" onClick={async () => { await api(`/tasks/sprints/${b.sprint!.id}`, { method: "DELETE" }).catch((e) => flash(e.message)); ctx.reload(); }}><Trash2 size={14} /></button>
                )}
                {canWrite && !b.sprint && sprintsOn && <button className="ws-btn" onClick={newSprint}>Create sprint</button>}
              </header>
              {b.sprint?.goal && <p className="tk-bl-goal">{b.sprint.goal}</p>}
              {!isShut && (
                <>
                  <ul className="tk-bl-list">
                    {b.tasks.length === 0 && <li className="tk-bl-empty">{b.sprint ? "Drag issues here from the backlog to plan this sprint." : "Your backlog is empty."}</li>}
                    {b.tasks.map((t) => (
                      <li key={t.id}>
                        {over?.box === b.id && over.before === t.id && <div className="tk-dropline" />}
                        <div
                          className={`tk-bl-row${drag?.includes(t.id) ? " dragging" : ""}${sel.includes(t.id) ? " sel" : ""}${t.flagged ? " flagged" : ""}`}
                          draggable={canWrite}
                          onDragStart={() => setDrag(sel.includes(t.id) ? sel : [t.id])}
                          onDragEnd={() => { setDrag(null); setOver(null); }}
                          onDragOver={(e) => {
                            if (!drag) return;
                            e.preventDefault();
                            e.stopPropagation();
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            const nextId = e.clientY > r.top + r.height / 2 ? (b.tasks[b.tasks.indexOf(t) + 1]?.id ?? null) : t.id;
                            if (over?.box !== b.id || over.before !== nextId) setOver({ box: b.id, before: nextId });
                          }}
                          onClick={(e) => click(e, t)}
                          tabIndex={0}
                          onKeyDown={(e) => e.key === "Enter" && ctx.open(t.id)}
                        >
                          <TypeIcon type={t.type} />
                          <span className={`tk-key${t.done ? " done" : ""}`}>{t.key}</span>
                          {t.flagged && <Flag size={13} className="tk-flagicon" aria-label="Flagged" />}
                          <span className="tk-bl-title">{t.title}</span>
                          {t.epicId && <span className="tk-epicchip">{ctx.epics.find((e) => e.id === t.epicId)?.title}</span>}
                          {t.versionId && <span className="tk-verchip">{ctx.versions.find((v) => v.id === t.versionId)?.name}</span>}
                          <StatusPill s={project.statuses.find((s) => s.id === t.status)} />
                          <PriorityIcon p={t.priority} />
                          <span className="tk-points light" title="Story points">{t.points ?? "–"}</span>
                          <Avatar person={ctx.person(t.assigneeId)} size={22} />
                          {canWrite && (
                            <span onClick={(e) => e.stopPropagation()}>
                              <Menu label={`Actions for ${t.key}`} align="right" button={() => <button className="tk-cardmenu" style={{ opacity: 1 }} aria-label={`Actions for ${t.key}`}><MoreHorizontal size={15} /></button>}>
                                {(close) => (
                                  <div className="tk-proj-menu">
                                    <button className="tk-mi" onClick={() => { close(); void toEdge(t, "top"); }}>Move to top</button>
                                    <button className="tk-mi" onClick={() => { close(); void toEdge(t, "bottom"); }}>Move to bottom</button>
                                    {sprintsOn && <div className="tk-mi-sect">Move to</div>}
                                    {sprintsOn && open.filter((s) => s.id !== t.sprintId).map((s) => <button key={s.id} className="tk-mi" onClick={() => { close(); void ctx.patch(t.id, { sprintId: s.id }); }}>{s.name}</button>)}
                                    {sprintsOn && t.sprintId && <button className="tk-mi" onClick={() => { close(); void ctx.patch(t.id, { sprintId: null }); }}>Backlog</button>}
                                    <button className="tk-mi" onClick={() => { close(); if (t.flagged) void ctx.patch(t.id, { flagged: false }); else setFlagging(t); }}><Flag size={13} /> {t.flagged ? "Remove flag" : "Add flag"}</button>
                                  </div>
                                )}
                              </Menu>
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                    {over?.box === b.id && over.before === null && b.tasks.length > 0 && <div className="tk-dropline" />}
                  </ul>
                  {canWrite && (adding === b.id ? (
                    <form className="tk-bl-add" onSubmit={(e) => { e.preventDefault(); void quickAdd(b.id); }}>
                      <input autoFocus className="ws-input" placeholder="What needs to be done? (Enter to add)" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAdding(null); } }} onBlur={() => !draft.trim() && setAdding(null)} />
                    </form>
                  ) : (
                    <button className="tk-addbtn" onClick={() => { setAdding(b.id); setDraft(""); }}><Plus size={14} /> Create issue</button>
                  ))}
                </>
              )}
            </section>
          );
        })}
      </div>
      {starting && <StartSprint sprint={starting} count={items.filter((t) => t.sprintId === starting.id).length} onClose={() => setStarting(null)} ctx={ctx} />}
      {completing && <CompleteSprint sprint={completing} others={open.filter((s) => s.id !== completing.id)} left={tasks.filter((t) => t.sprintId === completing.id && !t.done).length} doneN={tasks.filter((t) => t.sprintId === completing.id && t.done).length} onClose={() => setCompleting(null)} ctx={ctx} />}
      {flagging && <FlagDialog t={flagging} onClose={() => setFlagging(null)} onSave={(note) => { void ctx.patch(flagging.id, { flagged: true, flagNote: note || null }); setFlagging(null); }} />}
    </div>
  );
}

function StartSprint({ sprint, count, onClose, ctx }: { sprint: Sprint; count: number; onClose: () => void; ctx: Ctx }) {
  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal);
  const [weeks, setWeeks] = useState(2);
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="ws-modal" role="dialog" aria-label="Start sprint" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api(`/tasks/sprints/${sprint.id}`, { method: "PATCH", body: { name, goal } });
          await api(`/tasks/sprints/${sprint.id}`, { method: "PATCH", body: { action: "start", startAt: new Date(`${start}T09:00:00`).toISOString(), endAt: new Date(`${end}T18:00:00`).toISOString() } });
          ctx.flash(`${name} started`);
          ctx.reload();
          onClose();
        } catch (er) {
          ctx.flash((er as Error).message);
          setBusy(false);
        }
      }}>
        <header><h3>Start sprint</h3></header>
        <div className="body">
          <p className="ws-muted" style={{ marginTop: 0 }}>{count} issue{count === 1 ? "" : "s"} will be in this sprint.</p>
          <div className="ws-field"><label className="ws-label" htmlFor="sp-name">Sprint name</label><input id="sp-name" className="ws-input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="ws-field"><label className="ws-label" htmlFor="sp-len">Duration</label>
            <select id="sp-len" className="ws-input" value={weeks} onChange={(e) => { const w = Number(e.target.value); setWeeks(w); if (w) setEnd(new Date(new Date(start).getTime() + w * 7 * 86_400_000).toISOString().slice(0, 10)); }}>
              <option value={1}>1 week</option><option value={2}>2 weeks</option><option value={3}>3 weeks</option><option value={4}>4 weeks</option><option value={0}>Custom</option>
            </select>
          </div>
          <div className="ws-row">
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="sp-start">Start</label><input id="sp-start" type="date" className="ws-input" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="sp-end">End</label><input id="sp-end" type="date" className="ws-input" value={end} onChange={(e) => { setEnd(e.target.value); setWeeks(0); }} /></div>
          </div>
          <div className="ws-field"><label className="ws-label" htmlFor="sp-goal">Sprint goal</label><textarea id="sp-goal" className="ws-textarea" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should this sprint achieve?" /></div>
        </div>
        <footer><button type="button" className="ws-btn" onClick={onClose}>Cancel</button><button className="ws-btn primary" disabled={busy || end <= start}>Start</button></footer>
      </form>
    </div>
  );
}

function CompleteSprint({ sprint, others, left, doneN, onClose, ctx }: { sprint: Sprint; others: Sprint[]; left: number; doneN: number; onClose: () => void; ctx: Ctx }) {
  const [to, setTo] = useState(others[0]?.id ?? "backlog");
  const [busy, setBusy] = useState(false);
  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="ws-modal" role="dialog" aria-label="Complete sprint" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api(`/tasks/sprints/${sprint.id}`, { method: "PATCH", body: { action: "complete", moveTo: to } });
          ctx.flash(`${sprint.name} completed`);
          ctx.reload();
          onClose();
        } catch (er) {
          ctx.flash((er as Error).message);
          setBusy(false);
        }
      }}>
        <header><h3>Complete {sprint.name}</h3></header>
        <div className="body">
          <p style={{ marginTop: 0 }}>This sprint has <b>{doneN}</b> completed and <b>{left}</b> open issue{left === 1 ? "" : "s"}.</p>
          {left > 0 && (
            <div className="ws-field"><label className="ws-label" htmlFor="sp-to">Move open issues to</label>
              <select id="sp-to" className="ws-input" value={to} onChange={(e) => setTo(e.target.value)}>
                {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                <option value="backlog">Backlog</option>
              </select>
            </div>
          )}
        </div>
        <footer><button type="button" className="ws-btn" onClick={onClose}>Cancel</button><button className="ws-btn primary" disabled={busy}>Complete sprint</button></footer>
      </form>
    </div>
  );
}
