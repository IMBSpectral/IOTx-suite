"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Code2, Trash2, X } from "lucide-react";
import { api } from "@/lib/client";
import { ago, Avatar, fmtDay, labelColor, PRIORITIES, PriorityIcon, StatusPill, TypeIcon, TYPES, type Task } from "./ui";
import { Empty, type Ctx } from "./TasksApp";

type Col = "key" | "type" | "title" | "status" | "assignee" | "priority" | "points" | "due" | "sprint" | "updated";
const COLS: { id: Col; label: string }[] = [
  { id: "type", label: "Type" }, { id: "key", label: "Key" }, { id: "title", label: "Summary" }, { id: "status", label: "Status" }, { id: "assignee", label: "Assignee" },
  { id: "priority", label: "Priority" }, { id: "points", label: "Points" }, { id: "due", label: "Due" }, { id: "sprint", label: "Sprint" }, { id: "updated", label: "Updated" },
];

/** The list: a sortable table with grouping, selection and bulk edit; j/k to move, Enter to open. */
export default function Table({ ctx, tasks: boardTasks, mine }: { ctx: Ctx; tasks: Task[]; mine: boolean }) {
  const { project, person, sprints, canWrite, flash } = ctx;
  // The query language: results replace the filtered list until cleared.
  const [qOpen, setQOpen] = useState(false);
  const [qText, setQText] = useState(project ? `project = ${project.key} AND statusCategory != done ORDER BY priority DESC` : "assignee = me AND statusCategory != done ORDER BY due");
  const [qRows, setQRows] = useState<Task[] | null>(null);
  const [qErr, setQErr] = useState("");
  const tasks = qRows ?? boardTasks;
  async function runQuery() {
    setQErr("");
    try {
      const d = await api<{ tasks: Task[] }>(`/tasks?q=${encodeURIComponent(qText)}`);
      setQRows(d.tasks);
      setUserSorted(false);
    } catch (e) {
      setQErr((e as Error).message);
    }
  }
  const fieldCols = (project?.fieldDefs ?? []).slice(0, 4);
  const showCustom = (t: Task, f: (typeof fieldCols)[number]) => {
    const v = t.custom?.[f.id];
    if (v === undefined || v === "") return "";
    if (f.type === "user") return person(String(v))?.name ?? "";
    if (f.type === "checkbox") return v ? "Yes" : "No";
    return String(v);
  };
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "key", dir: -1 });
  const [group, setGroup] = useState<"none" | "status" | "assignee" | "type" | "epic" | "sprint">("none");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const statusOf = (t: Task) => (ctx.projects.find((p) => p.id === t.projectId)?.statuses ?? []).find((s) => s.id === t.status);

  const val = (t: Task, c: Col): string | number => {
    switch (c) {
      case "key": return t.number + (mine ? t.projectId.charCodeAt(0) * 1e6 : 0);
      case "type": return t.type;
      case "title": return t.title.toLowerCase();
      case "status": return `${["todo", "doing", "done"].indexOf(statusOf(t)?.category ?? "todo")}${statusOf(t)?.name}`;
      case "assignee": return person(t.assigneeId)?.name ?? "~";
      case "priority": return t.priority;
      case "points": return t.points ?? -1;
      case "due": return t.due ?? "9999";
      case "sprint": return sprints.find((s) => s.id === t.sprintId)?.name ?? "~";
      case "updated": return t.updatedAt;
    }
  };
  // A query's ORDER BY wins until a column header is clicked.
  const [userSorted, setUserSorted] = useState(false);
  const rows = useMemo(() => (qRows && !userSorted ? qRows : [...tasks].sort((a, b) => { const x = val(a, sort.col), y = val(b, sort.col); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; })), [tasks, sort, qRows, userSorted]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    if (group === "none") return [{ id: "all", title: "", rows }];
    const m = new Map<string, Task[]>();
    const key = (t: Task) => group === "status" ? (statusOf(t)?.name ?? t.status) : group === "assignee" ? (person(t.assigneeId)?.name ?? "Unassigned") : group === "type" ? (TYPES.find((x) => x.id === t.type)?.label ?? t.type) : group === "epic" ? (ctx.epics.find((e) => e.id === t.epicId)?.title ?? "No epic") : (sprints.find((s) => s.id === t.sprintId)?.name ?? "Backlog");
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m.entries()].map(([k, v]) => ({ id: k, title: k, rows: v }));
  }, [rows, group]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = groups.flatMap((g) => g.rows);

  // j / k / Enter / x to move, open and select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || document.querySelector(".ws-modal-scrim") || e.ctrlKey || e.metaKey) return;
      if (e.key === "j") setFocus((f) => Math.min(flat.length - 1, f + 1));
      else if (e.key === "k") setFocus((f) => Math.max(0, f - 1));
      else if (e.key === "Enter" && flat[focus]) ctx.open(flat[focus].id);
      else if (e.key === "x" && flat[focus]) setSel((s) => { const n = new Set(s); if (n.has(flat[focus].id)) n.delete(flat[focus].id); else n.add(flat[focus].id); return n; });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, focus, ctx]);
  useEffect(() => { document.querySelector(`[data-row="${focus}"]`)?.scrollIntoView({ block: "nearest" }); }, [focus]);

  async function bulk(patch: Record<string, unknown> | null) {
    if (!sel.size) return;
    if (patch === null && !window.confirm(`Delete ${sel.size} issue${sel.size === 1 ? "" : "s"} and their subtasks?`)) return;
    try {
      const d = await api<{ updated: number; results: { ok: boolean; error?: string }[] }>("/tasks/bulk", { body: patch === null ? { ids: [...sel], delete: true } : { ids: [...sel], patch } });
      const failed = d.results.filter((r) => !r.ok);
      flash(failed.length ? `${d.updated} updated · ${failed.length} skipped: ${failed[0].error}` : `${d.updated} issue${d.updated === 1 ? "" : "s"} updated`);
      setSel(new Set());
      ctx.reload();
    } catch (e) {
      flash((e as Error).message);
    }
  }

  const queryBar = (
    <div className="tk-query">
      {qOpen ? (
        <>
          <textarea className="ws-textarea" value={qText} onChange={(e) => setQText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void runQuery(); } }} aria-label="Query" spellCheck={false} />
          <button className="ws-btn primary" onClick={() => void runQuery()}>Search</button>
          <button className="ws-btn ghost" onClick={() => { setQOpen(false); setQRows(null); setQErr(""); }}>Close</button>
          {qErr && <div className="err" role="alert">{qErr}</div>}
          <div className="hint ws-muted">Fields: project, key, assignee, reporter, watcher, status, statusCategory, type, priority, labels, sprint, epic, due, start, created, updated, resolved, points, text. Use = != in ( ) ~ &lt; &gt;, AND, OR, NOT, is empty, ORDER BY. Values: me, today, -7d, openSprints(). {qRows && <b>{qRows.length} found.</b>}</div>
        </>
      ) : (
        <button className="ws-btn" onClick={() => setQOpen(true)}><Code2 size={14} /> Advanced search</button>
      )}
    </div>
  );

  if (!tasks.length && !qOpen) return <Empty title={mine ? "Nothing assigned to you" : "No issues match"} body={mine ? "Issues assigned to you in any project appear here." : "Change the filters, or create an issue."} action={canWrite && !mine ? <button className="ws-btn primary" onClick={() => ctx.create()}>Create an issue</button> : null} />;

  const visible = COLS.filter((c) => !(c.id === "sprint" && mine));
  const allSel = flat.length > 0 && flat.every((t) => sel.has(t.id));
  return (
    <div className="tk-tablewrap">
      {queryBar}
      <div className="tk-boardbar">
        {sel.size > 0 ? (
          <div className="tk-bulk" role="toolbar" aria-label="Bulk edit">
            <b>{sel.size} selected</b>
            {project && <select aria-label="Set status" value="" onChange={(e) => void bulk({ status: e.target.value })}><option value="">Status…</option>{project.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
            <select aria-label="Set assignee" value="" onChange={(e) => void bulk({ assigneeId: e.target.value === "none" ? null : e.target.value })}><option value="">Assignee…</option><option value="none">Unassigned</option>{(project ? ctx.people.filter((p) => project.memberIds.includes(p.id)) : ctx.people).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select aria-label="Set priority" value="" onChange={(e) => void bulk({ priority: Number(e.target.value) })}><option value="">Priority…</option>{PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
            {project && <select aria-label="Move to sprint" value="" onChange={(e) => void bulk({ sprintId: e.target.value === "backlog" ? null : e.target.value })}><option value="">Sprint…</option>{sprints.filter((s) => s.state !== "closed").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="backlog">Backlog</option></select>}
            {ctx.me.perms["tasks.delete"] && <button className="ws-btn danger" onClick={() => void bulk(null)}><Trash2 size={13} /> Delete</button>}
            <button className="ix-iconbtn" onClick={() => setSel(new Set())} aria-label="Clear selection"><X size={15} /></button>
          </div>
        ) : (
          <span className="ws-muted">{tasks.length} issue{tasks.length === 1 ? "" : "s"} · <kbd>j</kbd>/<kbd>k</kbd> to move, <kbd>x</kbd> to select</span>
        )}
        <span style={{ flex: 1 }} />
        <label className="tk-inline-select">Group by
          <select value={group} onChange={(e) => setGroup(e.target.value as typeof group)}>
            <option value="none">None</option><option value="status">Status</option><option value="assignee">Assignee</option><option value="type">Type</option>
            {!mine && <option value="epic">Epic</option>}{!mine && <option value="sprint">Sprint</option>}
          </select>
        </label>
      </div>
      <div className="tk-tablescroll">
        <table className="tk-table">
          <thead>
            <tr>
              {canWrite && <th className="cb"><input type="checkbox" aria-label="Select all" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(flat.map((t) => t.id)))} /></th>}
              {visible.map((c) => (
                <th key={c.id} className={`c-${c.id}`} aria-sort={sort.col === c.id && (!qRows || userSorted) ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button onClick={() => { setUserSorted(true); setSort((s) => ({ col: c.id, dir: s.col === c.id ? (s.dir === 1 ? -1 : 1) : 1 })); }}>
                    {c.label}{sort.col === c.id && (!qRows || userSorted) && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                </th>
              ))}
              {!mine && fieldCols.map((f) => <th key={f.id}><button>{f.name}</button></th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Group key={g.id} title={g.title} n={g.rows.length} span={visible.length + (canWrite ? 1 : 0) + (mine ? 0 : fieldCols.length)}>
                {g.rows.map((t) => {
                  const i = flat.indexOf(t);
                  const p = ctx.projects.find((x) => x.id === t.projectId);
                  return (
                    <tr key={t.id} data-row={i} className={`${i === focus ? "focus " : ""}${sel.has(t.id) ? "sel" : ""}`} onClick={() => { setFocus(i); ctx.open(t.id); }}>
                      {canWrite && <td className="cb" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${t.key}`} checked={sel.has(t.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })} /></td>}
                      <td className="c-type"><TypeIcon type={t.type} /></td>
                      <td className={`c-key tk-key${t.done ? " done" : ""}`}>{t.key}</td>
                      <td className="c-title">
                        <span className="t">{t.title}</span>
                        {t.labels.slice(0, 2).map((l) => <span key={l} className="tk-lbl" style={{ ["--lc" as string]: labelColor(l, p?.labelDefs ?? []) }}>{l}</span>)}
                        {t.subtasks.total > 0 && <span className="ws-muted"> · {t.subtasks.done}/{t.subtasks.total}</span>}
                      </td>
                      <td className="c-status"><StatusPill s={statusOf(t)} /></td>
                      <td className="c-assignee"><span className="tk-who"><Avatar person={person(t.assigneeId)} size={20} /> {person(t.assigneeId)?.name ?? <span className="ws-muted">Unassigned</span>}</span></td>
                      <td className="c-priority"><span className="tk-who"><PriorityIcon p={t.priority} /> {PRIORITIES[t.priority]?.label}</span></td>
                      <td className="c-points">{t.points ?? ""}</td>
                      <td className={`c-due${t.overdue ? " late" : ""}`}>{t.due ? fmtDay(t.due) : ""}</td>
                      {!mine && <td className="c-sprint">{sprints.find((s) => s.id === t.sprintId)?.name ?? ""}</td>}
                      <td className="c-updated ws-muted">{ago(t.updatedAt)}</td>
                      {!mine && fieldCols.map((f) => <td key={f.id}>{showCustom(t, f)}</td>)}
                    </tr>
                  );
                })}
              </Group>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Group({ title, n, span, children }: { title: string; n: number; span: number; children: React.ReactNode }) {
  const [shut, setShut] = useState(false);
  if (!title) return <>{children}</>;
  return (
    <>
      <tr className="tk-grouprow"><td colSpan={span}><button onClick={() => setShut((s) => !s)} aria-expanded={!shut}><span className={`chev${shut ? "" : " open"}`}>▸</span> {title} <span className="ws-muted">{n}</span></button></td></tr>
      {!shut && children}
    </>
  );
}
