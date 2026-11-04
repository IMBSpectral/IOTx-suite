"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Avatar } from "./ui";
import { Empty, type Ctx } from "./TasksApp";

type Burn = { sprint: { id: string; name: string; state: string; unit: string } | null; points: { day: string; remaining: number; ideal: number; issues: number }[] };
type Vel = { id: string; name: string; committed: number; completed: number }[];
type Flow = { day: string; created: number; resolved: number; todo: number; doing: number; done: number }[];

/** Reports: sprint burndown, velocity, created vs resolved, cumulative flow and workload. */
export default function Reports({ ctx }: { ctx: Ctx }) {
  const p = ctx.project!;
  const [burn, setBurn] = useState<Burn | null>(null);
  const [ready, setReady] = useState(false);
  const [vel, setVel] = useState<Vel>([]);
  const [flow, setFlow] = useState<Flow>([]);
  const [load, setLoad] = useState<{ assigneeId: string | null; issues: number; points: number }[]>([]);
  const [sprintId, setSprintId] = useState("");
  const [days, setDays] = useState(30);
  const sprints = ctx.sprints.filter((s) => s.state !== "planned");

  useEffect(() => {
    void api<Burn>(`/tasks/projects/${p.id}/reports?kind=burndown${sprintId ? `&sprint=${sprintId}` : ""}`).then(setBurn).catch(() => {}).finally(() => setReady(true));
  }, [p.id, sprintId]);
  useEffect(() => {
    void api(`/tasks/projects/${p.id}/reports?kind=velocity`).then((d) => setVel(d.sprints)).catch(() => {});
    void api(`/tasks/projects/${p.id}/reports?kind=workload`).then((d) => setLoad(d.people)).catch(() => {});
  }, [p.id]);
  useEffect(() => {
    void api(`/tasks/projects/${p.id}/reports?kind=flow&days=${days}`).then((d) => setFlow(d.days)).catch(() => {});
  }, [p.id, days]);

  if (!ready) return <div className="ws-center" style={{ flex: 1 }}><div className="ws-spinner" aria-hidden /></div>;
  return (
    <div className="tk-reports">
      <section className="tk-rep">
        <header>
          <h3>Sprint burndown</h3>
          {sprints.length > 0 && (
            <select className="ws-input" style={{ width: "auto" }} value={sprintId || burn?.sprint?.id || ""} onChange={(e) => setSprintId(e.target.value)} aria-label="Sprint">
              {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === "active" ? " (active)" : ""}</option>)}
            </select>
          )}
        </header>
        {burn?.sprint ? (
          <Lines
            labels={burn.points.map((x) => x.day)}
            series={[{ name: `Remaining ${burn.sprint.unit}`, color: "var(--accent)", values: burn.points.map((x) => x.remaining) }, { name: "Guideline", color: "var(--ix-muted)", dashed: true, values: burn.points.map((x) => x.ideal) }]}
          />
        ) : (
          <Empty title="No sprint yet" body="Start a sprint in the Backlog to see how the work burns down day by day." />
        )}
      </section>
      <section className="tk-rep">
        <header><h3>Velocity</h3><span className="ws-muted">Story points committed and completed per sprint</span></header>
        {vel.length ? <Bars items={vel.map((v) => ({ label: v.name, a: v.committed, b: v.completed }))} aLabel="Committed" bLabel="Completed" /> : <Empty title="No finished sprints" body="Velocity appears once a sprint is completed." />}
      </section>
      <section className="tk-rep">
        <header>
          <h3>Created vs resolved</h3>
          <select className="ws-input" style={{ width: "auto" }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period"><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
        </header>
        {flow.length > 0 && <Lines labels={flow.map((f) => f.day)} series={[{ name: "Created", color: "#dc2626", values: cumulative(flow.map((f) => f.created)) }, { name: "Resolved", color: "#16a34a", values: cumulative(flow.map((f) => f.resolved)) }]} />}
      </section>
      <section className="tk-rep">
        <header><h3>Cumulative flow</h3><span className="ws-muted">Issues in each status group, day by day</span></header>
        {flow.length > 0 && <Stack labels={flow.map((f) => f.day)} layers={[{ name: "Done", color: "#16a34a", values: flow.map((f) => f.done) }, { name: "In progress", color: "#2563eb", values: flow.map((f) => f.doing) }, { name: "To do", color: "#94a3b8", values: flow.map((f) => f.todo) }]} />}
      </section>
      <section className="tk-rep">
        <header><h3>Workload</h3><span className="ws-muted">Open issues per person</span></header>
        <table className="tk-table compact">
          <thead><tr><th>Person</th><th>Open issues</th><th>Story points</th></tr></thead>
          <tbody>
            {load.sort((a, b) => b.issues - a.issues).map((l) => (
              <tr key={l.assigneeId ?? "none"}><td><span className="tk-who"><Avatar person={ctx.person(l.assigneeId)} size={20} /> {ctx.person(l.assigneeId)?.name ?? "Unassigned"}</span></td><td>{l.issues}</td><td>{l.points}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const cumulative = (v: number[]) => v.reduce<number[]>((a, x) => [...a, (a.at(-1) ?? 0) + x], []);
const W = 640, H = 220, PADL = 34, PADB = 24;

function axis(max: number) {
  const step = Math.max(1, Math.ceil(max / 4));
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

function Lines({ labels, series }: { labels: string[]; series: { name: string; color: string; values: number[]; dashed?: boolean }[] }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = axis(max);
  const top = ticks.at(-1)! || 1;
  const x = (i: number) => PADL + (i / Math.max(1, labels.length - 1)) * (W - PADL - 8);
  const y = (v: number) => H - PADB - (v / top) * (H - PADB - 10);
  return (
    <figure className="tk-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.name).join(" and ")}>
        {ticks.map((t) => <g key={t}><line x1={PADL} x2={W - 8} y1={y(t)} y2={y(t)} className="grid" /><text x={PADL - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
        {labels.map((l, i) => (i % Math.ceil(labels.length / 7) === 0 || i === labels.length - 1) && <text key={l} x={x(i)} y={H - 6} textAnchor={i === labels.length - 1 ? "end" : i === 0 ? "start" : "middle"}>{new Date(`${l}T00:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" })}</text>)}
        {series.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={s.color} strokeWidth={2.2} strokeDasharray={s.dashed ? "5 5" : undefined} points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
            {!s.dashed && <circle cx={x(s.values.length - 1)} cy={y(s.values.at(-1) ?? 0)} r={3.5} fill={s.color} />}
          </g>
        ))}
      </svg>
      <figcaption>{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}{!s.dashed && `: ${s.values.at(-1) ?? 0}`}</span>)}</figcaption>
    </figure>
  );
}

function Bars({ items, aLabel, bLabel }: { items: { label: string; a: number; b: number }[]; aLabel: string; bLabel: string }) {
  const max = Math.max(1, ...items.flatMap((i) => [i.a, i.b]));
  const ticks = axis(max);
  const top = ticks.at(-1)! || 1;
  const bw = Math.min(28, (W - PADL - 20) / items.length / 2.6);
  const y = (v: number) => H - PADB - (v / top) * (H - PADB - 10);
  return (
    <figure className="tk-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Velocity">
        {ticks.map((t) => <g key={t}><line x1={PADL} x2={W - 8} y1={y(t)} y2={y(t)} className="grid" /><text x={PADL - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
        {items.map((it, i) => {
          const cx = PADL + ((i + 0.5) / items.length) * (W - PADL - 8);
          return (
            <g key={it.label}>
              <rect x={cx - bw - 1} y={y(it.a)} width={bw} height={H - PADB - y(it.a)} rx={3} fill="var(--ix-muted)" opacity={0.45}><title>{`${aLabel}: ${it.a}`}</title></rect>
              <rect x={cx + 1} y={y(it.b)} width={bw} height={H - PADB - y(it.b)} rx={3} fill="var(--accent)"><title>{`${bLabel}: ${it.b}`}</title></rect>
              <text x={cx} y={H - 6} textAnchor="middle">{it.label.length > 14 ? `${it.label.slice(0, 13)}…` : it.label}</text>
            </g>
          );
        })}
      </svg>
      <figcaption><span><i style={{ background: "var(--ix-muted)", opacity: 0.45 }} />{aLabel}</span><span><i style={{ background: "var(--accent)" }} />{bLabel}</span></figcaption>
    </figure>
  );
}

function Stack({ labels, layers }: { labels: string[]; layers: { name: string; color: string; values: number[] }[] }) {
  const totals = labels.map((_, i) => layers.reduce((a, l) => a + l.values[i], 0));
  const ticks = axis(Math.max(1, ...totals));
  const top = ticks.at(-1)! || 1;
  const x = (i: number) => PADL + (i / Math.max(1, labels.length - 1)) * (W - PADL - 8);
  const y = (v: number) => H - PADB - (v / top) * (H - PADB - 10);
  let base = labels.map(() => 0);
  const areas = layers.map((l) => {
    const lo = base;
    const hi = base.map((b, i) => b + l.values[i]);
    base = hi;
    const d = `M${hi.map((v, i) => `${x(i)},${y(v)}`).join(" L")} L${[...lo.map((v, i) => `${x(i)},${y(v)}`)].reverse().join(" L")} Z`;
    return { ...l, d };
  });
  return (
    <figure className="tk-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative flow">
        {ticks.map((t) => <g key={t}><line x1={PADL} x2={W - 8} y1={y(t)} y2={y(t)} className="grid" /><text x={PADL - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
        {areas.map((a) => <path key={a.name} d={a.d} fill={a.color} opacity={0.75} />)}
        {labels.map((l, i) => (i % Math.ceil(labels.length / 7) === 0 || i === labels.length - 1) && <text key={l} x={x(i)} y={H - 6} textAnchor={i === labels.length - 1 ? "end" : i === 0 ? "start" : "middle"}>{new Date(`${l}T00:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" })}</text>)}
      </svg>
      <figcaption>{layers.map((l) => <span key={l.name}><i style={{ background: l.color }} />{l.name}: {l.values.at(-1)}</span>)}</figcaption>
    </figure>
  );
}
