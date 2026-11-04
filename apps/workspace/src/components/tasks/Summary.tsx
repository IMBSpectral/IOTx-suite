"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, Clock, Pencil, PlusCircle } from "lucide-react";
import { api } from "@/lib/client";
import { ago, Avatar, PRIORITIES, PriorityIcon, TypeIcon, TYPES } from "./ui";
import type { Ctx } from "./TasksApp";

type Data = {
  counts: { created: number; updated: number; completed: number; dueSoon: number };
  status: { id: string; name: string; color: string; category: string; n: number }[];
  priority: { priority: number; n: number }[];
  types: { type: string; n: number }[];
  workload: { assigneeId: string | null; n: number }[];
  epics: { id: string; key: string; title: string; total: number; done: number }[];
  activity: { id: string; userId: string; kind: string; field: string | null; to: string | null; createdAt: string; task: { id: string; key: string; title: string } }[];
};
const CAT = { todo: "#94a3b8", doing: "#2563eb", done: "#16a34a" } as Record<string, string>;

/** The project's front page: the last 7 days, status, priorities, types of work, workload, epics and recent activity. */
export default function Summary({ ctx }: { ctx: Ctx }) {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => void api<Data>(`/tasks/projects/${ctx.project!.id}/overview?kind=summary`).then(setD).catch((e) => ctx.flash(e.message)), [ctx.project]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="ws-center" style={{ flex: 1 }}><div className="ws-spinner" aria-hidden /></div>;
  const total = d.status.reduce((a, s) => a + s.n, 0);
  const maxP = Math.max(1, ...d.priority.map((p) => p.n));
  const maxW = Math.max(1, ...d.workload.map((w) => w.n));
  const typeTotal = d.types.reduce((a, t) => a + t.n, 0) || 1;
  // A donut: each status as an arc, coloured by its group.
  let acc = 0;
  const R = 54, C = 2 * Math.PI * R;
  return (
    <div className="tk-summary">
      <div className="tk-sum-cards">
        <Stat icon={<CheckCircle2 size={18} />} n={d.counts.completed} label="completed" sub="in the last 7 days" />
        <Stat icon={<Pencil size={18} />} n={d.counts.updated} label="updated" sub="in the last 7 days" />
        <Stat icon={<PlusCircle size={18} />} n={d.counts.created} label="created" sub="in the last 7 days" />
        <Stat icon={<Clock size={18} />} n={d.counts.dueSoon} label="due soon" sub="in the next 7 days" />
      </div>
      <div className="tk-sum-grid">
        <section className="tk-rep">
          <header><h3>Status overview</h3><span className="ws-muted">{total} work items</span></header>
          <div className="tk-donut">
            <svg viewBox="0 0 140 140" role="img" aria-label="Issues by status">
              <circle cx="70" cy="70" r={R} fill="none" stroke="var(--ix-hover)" strokeWidth="18" />
              {d.status.filter((s) => s.n).map((s, i) => {
                const len = (s.n / (total || 1)) * C;
                const el = <circle key={s.id} cx="70" cy="70" r={R} fill="none" stroke={s.color || CAT[s.category]} strokeWidth="18" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)" />;
                acc += len;
                return el;
              })}
              <text x="70" y="66" textAnchor="middle" className="big">{total}</text>
              <text x="70" y="84" textAnchor="middle">items</text>
            </svg>
            <ul>{d.status.map((s) => <li key={s.id}><i style={{ background: s.color || CAT[s.category] }} />{s.name}<b>{s.n}</b></li>)}</ul>
          </div>
        </section>
        <section className="tk-rep">
          <header><h3>Recent activity</h3></header>
          <ul className="tk-history">
            {d.activity.length === 0 && <li className="ws-muted">No activity yet.</li>}
            {d.activity.slice(0, 10).map((a) => (
              <li key={a.id}>
                <Avatar person={ctx.person(a.userId)} size={22} />
                <span><b>{ctx.person(a.userId)?.name ?? "Someone"}</b> {a.kind === "created" ? "created" : a.kind === "comment" ? "commented on" : a.field === "status" ? `moved to ${a.to} ` : "updated"} <button className="tk-linkbtn" onClick={() => ctx.open(a.task.id)}><span className="tk-key">{a.task.key}</span> {a.task.title}</button> <span className="ws-muted">· {ago(a.createdAt)}</span></span>
              </li>
            ))}
          </ul>
        </section>
        <section className="tk-rep">
          <header><h3>Priority breakdown</h3><span className="ws-muted">Open work</span></header>
          <div className="tk-hbars">{[...d.priority].reverse().map((p) => <div key={p.priority}><span className="lbl"><PriorityIcon p={p.priority} /> {PRIORITIES[p.priority].label}</span><span className="bar"><span style={{ width: `${(p.n / maxP) * 100}%`, background: PRIORITIES[p.priority].color }} /></span><b>{p.n}</b></div>)}</div>
        </section>
        <section className="tk-rep">
          <header><h3>Types of work</h3></header>
          <div className="tk-hbars">{d.types.sort((a, b) => b.n - a.n).map((t) => <div key={t.type}><span className="lbl"><TypeIcon type={t.type} size={14} /> {TYPES.find((x) => x.id === t.type)?.label ?? t.type}</span><span className="bar"><span style={{ width: `${(t.n / typeTotal) * 100}%` }} /></span><b>{Math.round((t.n / typeTotal) * 100)}%</b></div>)}</div>
        </section>
        <section className="tk-rep">
          <header><h3>Team workload</h3><span className="ws-muted">Open work by assignee</span></header>
          <div className="tk-hbars">{d.workload.map((w) => <div key={w.assigneeId ?? "none"}><span className="lbl"><Avatar person={ctx.person(w.assigneeId)} size={18} /> {ctx.person(w.assigneeId)?.name ?? "Unassigned"}</span><span className="bar"><span style={{ width: `${(w.n / maxW) * 100}%` }} /></span><b>{w.n}</b></div>)}</div>
        </section>
        <section className="tk-rep">
          <header><h3>Epic progress</h3></header>
          {d.epics.length === 0 ? <p className="ws-muted">No epics yet. Epics group the big pieces of work.</p> : (
            <div className="tk-hbars">{d.epics.map((e) => <div key={e.id}><button className="lbl tk-linkbtn" onClick={() => ctx.open(e.id)}><TypeIcon type="epic" size={14} /> {e.title}</button><span className="bar"><span style={{ width: `${e.total ? (e.done / e.total) * 100 : 0}%`, background: "var(--tk-done)" }} /></span><b>{e.done}/{e.total}</b></div>)}</div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ icon, n, label, sub }: { icon: React.ReactNode; n: number; label: string; sub: string }) {
  return (
    <div className="tk-stat">
      <span className="ico">{icon}</span>
      <div><b>{n} {label}</b><small>{sub}</small></div>
    </div>
  );
}
