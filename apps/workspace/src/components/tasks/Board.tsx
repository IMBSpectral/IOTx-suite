"use client";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarClock, ChevronsDownUp, ChevronsUpDown, Flag, GitBranch, Link2, Maximize2, MessageSquare, Minimize2, MoreHorizontal, Paperclip, Plus, Settings2, X } from "lucide-react";
import { api, BASE } from "@/lib/client";
import { Avatar, fmtDay, labelColor, Menu, PRIORITIES, PriorityIcon, TypeIcon, type Status, type Task } from "./ui";
import { Empty, type Ctx } from "./TasksApp";
import Insights from "./Insights";

type Lane = { id: string; title: string; tasks: Task[] };
const CATS: Status[] = [
  { id: "todo", name: "To do", category: "todo", color: "#64748b", wip: null },
  { id: "doing", name: "In progress", category: "doing", color: "#2563eb", wip: null },
  { id: "done", name: "Done", category: "done", color: "#16a34a", wip: null },
];
const CAT_COLOR = { todo: "#64748b", doing: "#2563eb", done: "#16a34a" } as const;

/** What a card shows; each person picks for themselves (kept in this browser). */
export type CardFields = { type: boolean; key: boolean; epic: boolean; priority: boolean; assignee: boolean; labels: boolean; due: boolean; points: boolean; links: boolean; cover: boolean; days: boolean };
export const DEFAULT_FIELDS: CardFields = { type: true, key: true, epic: true, priority: true, assignee: true, labels: true, due: true, points: true, links: true, cover: true, days: true };
const FIELD_LABEL: Record<keyof CardFields, string> = { type: "Work type", key: "Issue key", epic: "Epic", priority: "Priority", assignee: "Assignee", labels: "Labels", due: "Due date", points: "Estimate", links: "Linked work items", cover: "Card cover", days: "Days in column" };

export function useStored<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(init);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setV({ ...init, ...JSON.parse(raw) });
    } catch {}
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [v, (x: T) => { setV(x); try { localStorage.setItem(key, JSON.stringify(x)); } catch {} }];
}

/** The board: one column per status (status groups in My work), managed right here; swimlanes, drag and drop, limits, insights. */
export default function Board({ ctx, tasks, all, mine }: { ctx: Ctx; tasks: Task[]; all: Task[]; mine: boolean }) {
  const { project, sprints, person, open, patch, flash, canWrite } = ctx;
  const active = ctx.project?.features.sprints === false ? undefined : sprints.find((s) => s.state === "active");
  const [scope, setScope] = useState<"sprint" | "all">("sprint");
  const [lanesBy, setLanesBy] = useState<"none" | "assignee" | "epic" | "priority" | "parent">("none");
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ col: string; lane: string; before: string | null } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [fields, setFields] = useStored<CardFields>("tk-card-fields", DEFAULT_FIELDS);
  const [compact, setCompact] = useStored<{ on: boolean }>("tk-compact", { on: false });
  const [showInsights, setShowInsights] = useState(false);
  const [full, setFull] = useState(false);
  const [newCol, setNewCol] = useState<{ name: string; category: Status["category"] } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [limits, setLimits] = useState<{ id: string; min: string; max: string } | null>(null);
  const [deleting, setDeleting] = useState<Status | null>(null);
  const [flagging, setFlagging] = useState<Task | null>(null);
  const admin = !!project && (project.myRole === "admin" || project.createdBy === ctx.me.id || ctx.me.owner);

  useEffect(() => {
    document.body.classList.toggle("tk-full", full);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && full && !document.querySelector(".ws-modal-scrim") && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => { document.body.classList.remove("tk-full"); window.removeEventListener("keydown", onKey); };
  }, [full]);

  const cols = mine || !project ? CATS : project.statuses;
  const colOf = (t: Task) => (mine || !project ? (t.done ? "done" : statusCat(t)) : t.status);
  function statusCat(t: Task) {
    return ctx.projects.find((x) => x.id === t.projectId)?.statuses.find((s) => s.id === t.status)?.category ?? "todo";
  }
  const inScope = useMemo(() => (active && scope === "sprint" && !mine ? tasks.filter((t) => t.sprintId === active.id) : tasks.filter((t) => t.type !== "epic")), [tasks, active, scope, mine]);

  const lanes: Lane[] = useMemo(() => {
    if (lanesBy === "none") return [{ id: "all", title: "", tasks: inScope }];
    const groups = new Map<string, Task[]>();
    for (const t of inScope) {
      const k = lanesBy === "assignee" ? (t.assigneeId ?? "none") : lanesBy === "epic" ? (t.epicId ?? "none") : lanesBy === "parent" ? (t.subtasks.total ? t.id : "none") : String(t.priority);
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    const title = (k: string) =>
      lanesBy === "assignee" ? (k === "none" ? "Unassigned" : (person(k)?.name ?? "Someone")) : lanesBy === "epic" ? (k === "none" ? "No epic" : (ctx.epics.find((e) => e.id === k)?.title ?? "Epic")) : lanesBy === "parent" ? (k === "none" ? "Everything else" : `${all.find((t) => t.id === k)?.key} ${all.find((t) => t.id === k)?.title}`) : (PRIORITIES[Number(k)]?.label ?? k);
    return [...groups.entries()].sort((a, b) => (lanesBy === "priority" ? Number(b[0]) - Number(a[0]) : a[0] === "none" ? 1 : b[0] === "none" ? -1 : title(a[0]).localeCompare(title(b[0])))).map(([k, ts]) => ({ id: k, title: title(k), tasks: ts }));
  }, [inScope, lanesBy, person, ctx.epics, all]);

  const count = (colId: string) => all.filter((t) => colOf(t) === colId && !t.parentId).length;

  // ── Column changes (project admins, right on the board)
  async function saveColumns(next: Status[], msg?: string) {
    if (!project) return;
    try {
      await api(`/tasks/projects/${project.id}`, { method: "PATCH", body: { statuses: next } });
      if (msg) flash(msg);
      ctx.reload();
    } catch (e) {
      flash((e as Error).message);
    }
  }
  const moveCol = (i: number, d: number) => {
    const n = [...cols];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    void saveColumns(n);
  };

  async function drop(colId: string, laneId: string, before: string | null) {
    const t = all.find((x) => x.id === dragId);
    setDragId(null);
    setOver(null);
    if (!t) return;
    const colTasks = inScope.filter((x) => colOf(x) === colId && x.id !== t.id).sort((a, b) => a.position - b.position);
    const idx = before ? colTasks.findIndex((x) => x.id === before) : colTasks.length;
    const prev = colTasks[idx - 1]?.position ?? (colTasks[0]?.position ?? 1000) - 1000;
    const next = colTasks[idx]?.position ?? prev + 2000;
    const body: Record<string, unknown> = { position: (prev + next) / 2 };
    if (mine) {
      if (colOf(t) !== colId) {
        const target = ctx.projects.find((x) => x.id === t.projectId)?.statuses.find((s) => s.category === colId);
        if (target) body.status = target.id;
      }
    } else if (t.status !== colId) body.status = colId;
    if (laneId !== "all" && lanesBy === "assignee" && (t.assigneeId ?? "none") !== laneId) body.assigneeId = laneId === "none" ? null : laneId;
    if (laneId !== "all" && lanesBy === "priority" && String(t.priority) !== laneId) body.priority = Number(laneId);
    if (laneId !== "all" && lanesBy === "epic" && (t.epicId ?? "none") !== laneId) body.epicId = laneId === "none" ? null : laneId;
    await patch(t.id, body);
  }
  async function toEdge(t: Task, edge: "top" | "bottom") {
    const col = inScope.filter((x) => colOf(x) === colOf(t) && x.id !== t.id).map((x) => x.position);
    if (!col.length) return;
    await patch(t.id, { position: edge === "top" ? Math.min(...col) - 1000 : Math.max(...col) + 1000 });
  }

  async function quickAdd(colId: string, laneId: string) {
    const title = draft.trim();
    if (!title || !project) return;
    try {
      await api("/tasks", { body: { projectId: project.id, title, status: colId, ...(active && scope === "sprint" ? { sprintId: active.id } : {}), ...(lanesBy === "assignee" && laneId !== "all" && laneId !== "none" ? { assigneeId: laneId } : {}) } });
      setDraft("");
      ctx.reload();
    } catch (e) {
      flash((e as Error).message);
    }
  }

  if (mine && !tasks.length)
    return <Empty title="Nothing assigned to you" body="Issues assigned to you in any project show up here. Pick a project to see its board, or create an issue." action={ctx.projects.length ? <button className="ws-btn primary" onClick={() => ctx.create({ assigneeId: ctx.me.id })}><Plus size={15} /> Create an issue for me</button> : null} />;

  const gridCols = `repeat(${cols.length}, minmax(${compact.on ? 220 : 260}px, 1fr))${admin && !mine ? " 56px" : ""}`;

  return (
    <div className={`tk-boardwrap${compact.on ? " compact" : ""}`}>
      <div className="tk-boardbar">
        {active && !mine && (
          <div className="ws-seg" role="group" aria-label="Board scope">
            <button aria-pressed={scope === "sprint"} onClick={() => setScope("sprint")}>{active.name}</button>
            <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>All issues</button>
          </div>
        )}
        {active && !mine && scope === "sprint" && (
          <span className="ws-muted tk-sprint-left" title={active.goal || undefined}>
            <CalendarClock size={13} /> {active.endAt ? `${Math.max(0, Math.ceil((new Date(active.endAt).getTime() - Date.now()) / 86_400_000))} days left` : "No end date"}
            {active.goal && <span className="tk-goal">· {active.goal}</span>}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <label className="tk-inline-select">
          Group by
          <select value={lanesBy} onChange={(e) => { setLanesBy(e.target.value as typeof lanesBy); setShut(new Set()); }}>
            <option value="none">None</option>
            <option value="assignee">Assignee</option>
            {!mine && <option value="epic">Epic</option>}
            <option value="priority">Priority</option>
            {!mine && <option value="parent">Parent issues</option>}
          </select>
        </label>
        {lanesBy !== "none" && (
          <>
            <button className="ix-iconbtn" title="Expand all" aria-label="Expand all swimlanes" onClick={() => setShut(new Set())}><ChevronsUpDown size={16} /></button>
            <button className="ix-iconbtn" title="Collapse all" aria-label="Collapse all swimlanes" onClick={() => setShut(new Set(lanes.map((l) => l.id)))}><ChevronsDownUp size={16} /></button>
          </>
        )}
        {!mine && <button className={`ws-btn${showInsights ? " on" : ""}`} onClick={() => setShowInsights((s) => !s)}><BarChart3 size={14} /> Insights</button>}
        <Menu label="View settings" align="right" button={() => <button className="ws-btn"><Settings2 size={14} /> View settings</button>}>
          {() => (
            <div className="tk-viewset">
              <label className="tk-check"><input type="checkbox" checked={compact.on} onChange={(e) => setCompact({ on: e.target.checked })} /> Compact cards</label>
              <div className="tk-mi-sect">Show on cards</div>
              {(Object.keys(FIELD_LABEL) as (keyof CardFields)[]).map((k) => (
                <label key={k} className="tk-check"><input type="checkbox" checked={fields[k]} onChange={(e) => setFields({ ...fields, [k]: e.target.checked })} /> {FIELD_LABEL[k]}</label>
              ))}
              <button className="tk-mi" onClick={() => setFields(DEFAULT_FIELDS)}>Reset to default</button>
            </div>
          )}
        </Menu>
        <button className="ix-iconbtn" title={full ? "Exit full screen (Esc)" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"} onClick={() => setFull((f) => !f)}>{full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      </div>
      <div className="tk-board-and-side">
        <div className="tk-board" style={{ gridTemplateColumns: gridCols, ["--cols" as string]: cols.length }}>
          {cols.map((c, i) => {
            const shownN = inScope.filter((t) => colOf(t) === c.id).length;
            const n = c.wip || c.min ? count(c.id) : shownN;
            const overWip = !!c.wip && n > c.wip;
            const under = !!c.min && n < c.min;
            return (
              <div key={c.id} className={`tk-colhead${overWip ? " over" : ""}${under ? " under" : ""}`} style={{ ["--st" as string]: mine ? c.color : CAT_COLOR[c.category] }} onContextMenu={(e) => { if (admin && !mine) { e.preventDefault(); setLimits({ id: c.id, min: String(c.min ?? ""), max: String(c.wip ?? "") }); } }}>
                {renaming?.id === c.id ? (
                  <form className="tk-colrename" onSubmit={(e) => { e.preventDefault(); const nm = renaming.name.trim(); setRenaming(null); if (nm && nm !== c.name) void saveColumns(cols.map((x) => (x.id === c.id ? { ...x, name: nm } : x))); }}>
                    <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} onBlur={(e) => (e.currentTarget.form as HTMLFormElement).requestSubmit()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); } }} aria-label="Column name" maxLength={30} />
                  </form>
                ) : (
                  <button className="name" disabled={!admin || mine} onClick={() => setRenaming({ id: c.id, name: c.name })} title={admin && !mine ? "Rename column" : undefined}>{c.name}</button>
                )}
                <span className="n" title={c.wip || c.min ? `${n} issues in the whole project${c.min ? `, minimum ${c.min}` : ""}${c.wip ? `, maximum ${c.wip}` : ""}` : undefined}>
                  {c.wip || c.min ? `${n}${c.min ? ` · min ${c.min}` : ""}${c.wip ? ` · max ${c.wip}` : ""}` : shownN}
                </span>
                {c.category === "done" && <span className="done-tick" title="Issues here count as done">✓</span>}
                {admin && !mine && (
                  <Menu label={`Column ${c.name}`} align="right" button={() => <button className="tk-colmenu" aria-label={`Column ${c.name} actions`}><MoreHorizontal size={15} /></button>}>
                    {(close) => (
                      <div className="tk-proj-menu">
                        <button className="tk-mi" onClick={() => { close(); setRenaming({ id: c.id, name: c.name }); }}>Rename</button>
                        <button className="tk-mi" onClick={() => { close(); setLimits({ id: c.id, min: String(c.min ?? ""), max: String(c.wip ?? "") }); }}>Set column limit</button>
                        {i > 0 && <button className="tk-mi" onClick={() => { close(); moveCol(i, -1); }}>Move left</button>}
                        {i < cols.length - 1 && <button className="tk-mi" onClick={() => { close(); moveCol(i, 1); }}>Move right</button>}
                        <div className="tk-mi-sect">Group</div>
                        {(["todo", "doing", "done"] as const).map((g) => (
                          <button key={g} className={`tk-mi${c.category === g ? " on" : ""}`} onClick={() => { close(); if (c.category !== g) void saveColumns(cols.map((x) => (x.id === c.id ? { ...x, category: g, ...(g === "done" ? { wip: null, min: null } : {}) } : x))); }}>
                            {g === "todo" ? "To do" : g === "doing" ? "In progress" : "Done"}
                          </button>
                        ))}
                        <button className="tk-mi danger" disabled={cols.length <= 2} onClick={() => { close(); setDeleting(c); }}>Delete column</button>
                      </div>
                    )}
                  </Menu>
                )}
                {overWip && <span className="wip">Over limit</span>}
                {under && <span className="wip low">Below minimum</span>}
              </div>
            );
          })}
          {admin && !mine && (
            <div className="tk-addcol-wrap" style={{ gridColumn: cols.length + 1, gridRow: 1 }}>
              {newCol ? (
                <form className="tk-addcol-form" onSubmit={(e) => { e.preventDefault(); if (!newCol.name.trim()) return; const done = cols.filter((x) => x.category === "done"); const rest = cols.filter((x) => x.category !== "done"); const add: Status = { id: "", name: newCol.name.trim(), category: newCol.category, color: CAT_COLOR[newCol.category], wip: null }; void saveColumns(newCol.category === "done" ? [...cols, add] : [...rest, add, ...done], `Column "${add.name}" added`); setNewCol(null); }}>
                  <input autoFocus className="ws-input" placeholder="Column name" value={newCol.name} onChange={(e) => setNewCol({ ...newCol, name: e.target.value })} maxLength={30} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setNewCol(null); } }} />
                  <select className="ws-input" value={newCol.category} onChange={(e) => setNewCol({ ...newCol, category: e.target.value as Status["category"] })} aria-label="Group">
                    <option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option>
                  </select>
                  <div className="ws-row"><button className="ws-btn primary">Add column</button><button type="button" className="ix-iconbtn" aria-label="Cancel" onClick={() => setNewCol(null)}><X size={15} /></button></div>
                </form>
              ) : (
                <button className="tk-addcol" title="Add a column" aria-label="Add a column" disabled={cols.length >= 12} onClick={() => setNewCol({ name: "", category: "doing" })}><Plus size={18} /></button>
              )}
            </div>
          )}
          {lanes.map((lane) => (
            <LaneBlock key={lane.id} lane={lane} cols={cols} lanesBy={lanesBy} shut={shut.has(lane.id)} toggle={() => setShut((s) => { const n = new Set(s); if (n.has(lane.id)) n.delete(lane.id); else n.add(lane.id); return n; })}>
              {cols.map((c, ci) => {
                const items = lane.tasks.filter((t) => colOf(t) === c.id).sort((a, b) => a.position - b.position);
                const isOver = over?.col === c.id && over.lane === lane.id;
                return (
                  <div
                    key={c.id}
                    style={{ gridColumn: ci + 1 }}
                    className={`tk-col${isOver ? " drop" : ""}${c.category === "done" ? " done" : ""}`}
                    onDragOver={(e) => { if (!dragId) return; e.preventDefault(); if (!isOver) setOver({ col: c.id, lane: lane.id, before: null }); }}
                    onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null); }}
                    onDrop={(e) => { e.preventDefault(); void drop(c.id, lane.id, over?.before ?? null); }}
                  >
                    {items.map((t) => (
                      <div key={t.id}>
                        {isOver && over?.before === t.id && <div className="tk-dropline" />}
                        <Card
                          t={t} ctx={ctx} mine={mine} fields={fields} dragging={dragId === t.id}
                          onDragStart={() => setDragId(t.id)}
                          onDragEnd={() => { setDragId(null); setOver(null); }}
                          onDragOverCard={(e) => {
                            if (!dragId || dragId === t.id) return;
                            e.preventDefault();
                            e.stopPropagation();
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            const nextId = e.clientY > r.top + r.height / 2 ? (items[items.indexOf(t) + 1]?.id ?? null) : t.id;
                            if (over?.col !== c.id || over.before !== nextId || over.lane !== lane.id) setOver({ col: c.id, lane: lane.id, before: nextId });
                          }}
                          onMove={(status) => void patch(t.id, { status })}
                          onEdge={(edge) => void toEdge(t, edge)}
                          onFlag={() => (t.flagged ? void patch(t.id, { flagged: false }) : setFlagging(t))}
                          canWrite={canWrite}
                          statuses={mine ? (ctx.projects.find((p) => p.id === t.projectId)?.statuses ?? []) : (project?.statuses ?? [])}
                          open={() => open(t.id)}
                        />
                      </div>
                    ))}
                    {isOver && over?.before === null && <div className="tk-dropline" />}
                    {!mine && canWrite && (lane.id === "all" || lanesBy === "assignee") && c.category !== "done" && (adding === `${lane.id}:${c.id}` ? (
                      <form className="tk-addcard" onSubmit={(e) => { e.preventDefault(); void quickAdd(c.id, lane.id); }}>
                        <textarea autoFocus className="ws-textarea" rows={2} placeholder="What needs to be done?" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void quickAdd(c.id, lane.id); } if (e.key === "Escape") { e.stopPropagation(); setAdding(null); } }} onBlur={() => !draft.trim() && setAdding(null)} />
                        <div className="ws-row"><button className="ws-btn primary">Add</button><button type="button" className="ws-btn ghost" onClick={() => setAdding(null)}>Cancel</button></div>
                      </form>
                    ) : (
                      <button className="tk-addbtn" onClick={() => { setAdding(`${lane.id}:${c.id}`); setDraft(""); }}><Plus size={14} /> Create issue</button>
                    ))}
                    {!items.length && !isOver && (mine || c.category === "done" || lane.id !== "all") && <div className="tk-col-empty">Drop issues here</div>}
                  </div>
                );
              })}
            </LaneBlock>
          ))}
        </div>
        {showInsights && project && <Insights ctx={ctx} onClose={() => setShowInsights(false)} />}
      </div>

      {limits && (
        <Dialog title="Column limit" onClose={() => setLimits(null)} onSubmit={() => { const min = limits.min.trim() ? Number(limits.min) : null; const max = limits.max.trim() ? Number(limits.max) : null; setLimits(null); void saveColumns(cols.map((x) => (x.id === limits.id ? { ...x, min, wip: max } : x)), "Column limit saved"); }}>
          <p className="ws-muted" style={{ marginTop: 0 }}>Limits count every issue in this column across the project, including ones hidden by filters. The header turns red above the maximum and yellow below the minimum, and nothing can be moved in above the maximum.</p>
          <div className="ws-row">
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="cl-min">Minimum</label><input id="cl-min" className="ws-input" type="number" min={0} value={limits.min} onChange={(e) => setLimits({ ...limits, min: e.target.value })} placeholder="None" /></div>
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="cl-max">Maximum</label><input id="cl-max" className="ws-input" type="number" min={1} value={limits.max} onChange={(e) => setLimits({ ...limits, max: e.target.value })} placeholder="None" /></div>
          </div>
        </Dialog>
      )}
      {deleting && <DeleteColumn ctx={ctx} col={deleting} cols={cols} n={count(deleting.id)} onClose={() => setDeleting(null)} />}
      {flagging && (
        <FlagDialog t={flagging} onClose={() => setFlagging(null)} onSave={(note) => { void patch(flagging.id, { flagged: true, flagNote: note || null }); setFlagging(null); }} />
      )}
    </div>
  );
}

function LaneBlock({ lane, cols, lanesBy, shut, toggle, children }: { lane: Lane; cols: Status[]; lanesBy: string; shut: boolean; toggle: () => void; children: React.ReactNode }) {
  if (lanesBy === "none") return <>{children}</>;
  return (
    <>
      <button className="tk-lanehead" style={{ gridColumn: `1 / span ${cols.length}` }} onClick={toggle} aria-expanded={!shut}>
        <span className={`chev${shut ? "" : " open"}`}>▸</span> {lane.title} <span className="ws-muted">· {lane.tasks.length}</span>
      </button>
      {!shut && children}
    </>
  );
}

export function Dialog({ title, children, onClose, onSubmit, submit = "Save", danger }: { title: string; children: React.ReactNode; onClose: () => void; onSubmit: () => void; submit?: string; danger?: boolean }) {
  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="ws-modal" role="dialog" aria-label={title} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <header><h3>{title}</h3><button type="button" className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <div className="body">{children}</div>
        <footer><button type="button" className="ws-btn" onClick={onClose}>Cancel</button><button className={`ws-btn ${danger ? "danger" : "primary"}`}>{submit}</button></footer>
      </form>
    </div>
  );
}

function DeleteColumn({ ctx, col, cols, n, onClose }: { ctx: Ctx; col: Status; cols: Status[]; n: number; onClose: () => void }) {
  const others = cols.filter((c) => c.id !== col.id);
  const [to, setTo] = useState(others.find((c) => c.category === col.category)?.id ?? others[0].id);
  return (
    <Dialog title={`Delete "${col.name}"`} submit="Delete column" danger onClose={onClose} onSubmit={async () => {
      try {
        const d = await api(`/tasks/projects/${ctx.project!.id}/columns`, { body: { statusId: col.id, moveTo: to } });
        ctx.flash(`Column deleted${d.moved ? `; ${d.moved} issue${d.moved === 1 ? "" : "s"} moved` : ""}`);
        ctx.reload();
        onClose();
      } catch (e) {
        ctx.flash((e as Error).message);
      }
    }}>
      <p style={{ marginTop: 0 }}>{n ? <>This column has <b>{n}</b> issue{n === 1 ? "" : "s"}. Choose where they go.</> : "The column is empty."}</p>
      {n > 0 && <div className="ws-field"><label className="ws-label" htmlFor="dc-to">Move issues to</label><select id="dc-to" className="ws-input" value={to} onChange={(e) => setTo(e.target.value)}>{others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
    </Dialog>
  );
}

export function FlagDialog({ t, onClose, onSave }: { t: Task; onClose: () => void; onSave: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog title={`Flag ${t.key}`} submit="Add flag" onClose={onClose} onSubmit={() => onSave(note.trim())}>
      <p className="ws-muted" style={{ marginTop: 0 }}>A flag marks the issue as blocked or needing attention. Its card turns yellow and it shows under Insights.</p>
      <div className="ws-field"><label className="ws-label" htmlFor="fl-note">Why? (optional)</label><textarea id="fl-note" className="ws-textarea" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Waiting for the payment gateway keys" /></div>
    </Dialog>
  );
}

export function Card({
  t, ctx, mine, fields = DEFAULT_FIELDS, dragging, onDragStart, onDragEnd, onDragOverCard, onMove, onEdge, onFlag, canWrite, statuses, open,
}: {
  t: Task; ctx: Ctx; mine: boolean; fields?: CardFields; dragging: boolean; onDragStart: () => void; onDragEnd: () => void; onDragOverCard: (e: React.DragEvent) => void;
  onMove: (status: string) => void; onEdge?: (e: "top" | "bottom") => void; onFlag?: () => void; canWrite: boolean; statuses: { id: string; name: string }[]; open: () => void;
}) {
  const p = ctx.projects.find((x) => x.id === t.projectId);
  const epic = ctx.epics.find((e) => e.id === t.epicId);
  const who = ctx.person(t.assigneeId);
  const days = Math.floor((Date.now() - new Date(t.statusAt).getTime()) / 86_400_000);
  const est = p?.features.estimation === "time" ? (t.estimateMin != null ? `${Math.round(t.estimateMin / 60)}h` : null) : t.points;
  return (
    <article
      className={`tk-card${dragging ? " dragging" : ""}${t.done ? " done" : ""}${t.flagged ? " flagged" : ""}`}
      draggable={canWrite}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.id); onDragStart(); }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverCard}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter") open(); }}
      tabIndex={0}
      aria-label={`${t.key} ${t.title}${t.flagged ? " (flagged)" : ""}`}
    >
      {fields.cover && t.coverId && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="tk-card-cover" src={`${BASE}/api/tasks/attachments/${t.coverId}`} alt="" loading="lazy" />
      )}
      {fields.labels && t.labels.length > 0 && (
        <div className="tk-card-labels">
          {t.labels.slice(0, 3).map((l) => <span key={l} style={{ ["--lc" as string]: labelColor(l, p?.labelDefs ?? []) }}>{l}</span>)}
          {t.labels.length > 3 && <span className="more">+{t.labels.length - 3}</span>}
        </div>
      )}
      <div className="tk-card-title">{t.flagged && <Flag size={13} className="tk-flagicon" aria-label="Flagged" />}{t.title}</div>
      {t.flagged && t.flagNote && <div className="tk-card-flagnote">{t.flagNote}</div>}
      {fields.epic && epic && <div className="tk-card-epic" title={`Epic: ${epic.title}`}>{epic.title}</div>}
      {mine && p && <div className="tk-card-proj"><span style={{ background: p.color }} />{p.name}</div>}
      <div className="tk-card-foot">
        {fields.type && <TypeIcon type={t.type} />}
        {fields.key && <span className={`tk-key${t.done ? " done" : ""}`}>{t.key}</span>}
        {fields.priority && <PriorityIcon p={t.priority} />}
        {fields.due && t.due && <span className={`tk-due${t.overdue ? " late" : ""}`}><CalendarClock size={12} />{fmtDay(t.due)}</span>}
        {t.subtasks.total > 0 && <span className="tk-meta" title="Subtasks done"><GitBranch size={12} />{t.subtasks.done}/{t.subtasks.total}</span>}
        {fields.links && t.issueLinks > 0 && <span className="tk-meta" title="Linked issues"><Link2 size={12} />{t.issueLinks}</span>}
        {t.comments > 0 && <span className="tk-meta"><MessageSquare size={12} />{t.comments}</span>}
        {t.attachments > 0 && <span className="tk-meta"><Paperclip size={12} />{t.attachments}</span>}
        <span style={{ flex: 1 }} />
        {fields.points && est != null && <span className="tk-points" title={p?.features.estimation === "time" ? "Estimate" : "Story points"}>{est}</span>}
        {fields.assignee && <Avatar person={who} size={22} />}
        {canWrite && (
          <span onClick={(e) => e.stopPropagation()}>
            <Menu label={`Actions for ${t.key}`} align="right" button={() => <button className="tk-cardmenu" aria-label={`Actions for ${t.key}`}><MoreHorizontal size={15} /></button>}>
              {(close) => (
                <div className="tk-proj-menu">
                  {onFlag && <button className="tk-mi" onClick={() => { close(); onFlag(); }}><Flag size={13} /> {t.flagged ? "Remove flag" : "Add flag"}</button>}
                  {onEdge && <button className="tk-mi" onClick={() => { close(); onEdge("top"); }}>Move to top</button>}
                  {onEdge && <button className="tk-mi" onClick={() => { close(); onEdge("bottom"); }}>Move to bottom</button>}
                  <div className="tk-mi-sect">Move to</div>
                  {statuses.filter((s) => s.id !== t.status).map((s) => <button key={s.id} className="tk-mi" onClick={() => { close(); onMove(s.id); }}>{s.name}</button>)}
                  {t.assigneeId !== ctx.me.id && <button className="tk-mi" onClick={() => { close(); void ctx.patch(t.id, { assigneeId: ctx.me.id }); }}>Assign to me</button>}
                  <button className="tk-mi" onClick={() => { close(); void navigator.clipboard?.writeText(`${location.origin}/workspace/tasks?project=${t.projectId}&task=${t.key}`); ctx.flash("Link copied"); }}>Copy link</button>
                </div>
              )}
            </Menu>
          </span>
        )}
      </div>
      {fields.days && !t.done && days >= 1 && (
        <div className="tk-days" title={`${days} day${days === 1 ? "" : "s"} in this column`} aria-label={`${days} days in this column`}>
          {Array.from({ length: Math.min(days, 6) }, (_, i) => <i key={i} className={days > 7 ? "hot" : days > 3 ? "warm" : ""} />)}
          {days > 6 && <span>{days}d</span>}
        </div>
      )}
    </article>
  );
}
