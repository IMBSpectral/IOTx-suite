"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Flag, Hourglass, Link2, X } from "lucide-react";
import { api } from "@/lib/client";
import { TypeIcon } from "./ui";
import type { Ctx } from "./TasksApp";

type Data = {
  sprint: { id: string; name: string; goal: string; daysLeft: number | null } | null;
  progress: { todo: number; doing: number; done: number; pointsTodo: number; pointsDoing: number; pointsDone: number };
  types: { type: string; total: number; done: number }[];
  epics: { id: string; key: string; title: string; total: number; done: number }[];
  attention: { stuckDays: number; stuck: Item[]; blocked: Item[]; flagged: Item[] };
};
type Item = { id: string; key: string; title: string };

/** The board's insights panel: sprint progress, breakdowns and work that needs attention. */
export default function Insights({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [tab, setTab] = useState<"stuck" | "blocked" | "flagged">("flagged");
  const load = () => void api<Data>(`/tasks/projects/${ctx.project!.id}/overview?kind=insights`).then(setD).catch(() => {});
  useEffect(load, [ctx.project]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <aside className="tk-insights"><div className="ws-spinner" aria-hidden /></aside>;
  const total = d.progress.todo + d.progress.doing + d.progress.done || 1;
  const usePts = d.progress.pointsTodo + d.progress.pointsDoing + d.progress.pointsDone > 0;
  const seg = (n: number, pts: number) => (usePts ? pts : n);
  const segTotal = usePts ? d.progress.pointsTodo + d.progress.pointsDoing + d.progress.pointsDone : total;
  const att = d.attention[tab];
  return (
    <aside className="tk-insights" aria-label="Insights">
      <header><b>Insights</b><button className="ix-iconbtn" onClick={onClose} aria-label="Close insights"><X size={16} /></button></header>
      <section>
        <h4>{d.sprint ? `${d.sprint.name} progress` : "Open work"}</h4>
        {d.sprint?.daysLeft != null && <p className="ws-muted small">{d.sprint.daysLeft} days left{d.sprint.goal ? ` · ${d.sprint.goal}` : ""}</p>}
        <div className="tk-stack" role="img" aria-label={`To do ${d.progress.todo}, in progress ${d.progress.doing}, done ${d.progress.done}`}>
          <span className="todo" style={{ width: `${(seg(d.progress.todo, d.progress.pointsTodo) / (segTotal || 1)) * 100}%` }} />
          <span className="doing" style={{ width: `${(seg(d.progress.doing, d.progress.pointsDoing) / (segTotal || 1)) * 100}%` }} />
          <span className="done" style={{ width: `${(seg(d.progress.done, d.progress.pointsDone) / (segTotal || 1)) * 100}%` }} />
        </div>
        <div className="tk-legend small">
          <span><i className="todo" />To do {usePts ? `${d.progress.pointsTodo} pts` : d.progress.todo}</span>
          <span><i className="doing" />In progress {usePts ? `${d.progress.pointsDoing} pts` : d.progress.doing}</span>
          <span><i className="done" />Done {usePts ? `${d.progress.pointsDone} pts` : d.progress.done}</span>
        </div>
      </section>
      <section>
        <h4>Work items for attention</h4>
        <div className="ws-seg small" role="tablist">
          <button aria-pressed={tab === "flagged"} onClick={() => setTab("flagged")}><Flag size={12} /> Flagged {d.attention.flagged.length}</button>
          <button aria-pressed={tab === "blocked"} onClick={() => setTab("blocked")}><Link2 size={12} /> Blocked {d.attention.blocked.length}</button>
          <button aria-pressed={tab === "stuck"} onClick={() => setTab("stuck")}><Hourglass size={12} /> Stuck {d.attention.stuck.length}</button>
        </div>
        <p className="ws-muted small">{tab === "stuck" ? `In progress with no status change for ${d.attention.stuckDays}+ days.` : tab === "blocked" ? "Blocked by an issue that isn't done." : "Flagged as an impediment."}</p>
        <ul className="tk-ins-list">
          {att.length === 0 && <li className="ws-muted">Nothing here.</li>}
          {att.map((i) => (
            <li key={i.id}><button className="tk-linkbtn" onClick={() => ctx.open(i.id)}><AlertTriangle size={12} /> <span className="tk-key">{i.key}</span> {i.title}</button></li>
          ))}
        </ul>
      </section>
      <section>
        <h4>Issue types</h4>
        {d.types.filter((t) => t.total).map((t) => (
          <div key={t.type} className="tk-ins-row"><TypeIcon type={t.type} size={14} /><span className="grow">{t.type[0].toUpperCase() + t.type.slice(1)}</span><span className="ws-muted">{t.done}/{t.total}</span><Bar done={t.done} total={t.total} /></div>
        ))}
      </section>
      {d.epics.length > 0 && (
        <section>
          <h4>Epic progress</h4>
          {d.epics.map((e) => (
            <div key={e.id} className="tk-ins-row"><TypeIcon type="epic" size={14} /><button className="tk-linkbtn grow" onClick={() => ctx.open(e.id)}>{e.title}</button><span className="ws-muted">{e.done}/{e.total}</span><Bar done={e.done} total={e.total} /></div>
          ))}
        </section>
      )}
    </aside>
  );
}

function Bar({ done, total }: { done: number; total: number }) {
  return <span className="tk-minibar"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>;
}
