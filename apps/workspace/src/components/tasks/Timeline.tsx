"use client";
import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TypeIcon, type Task } from "./ui";
import { Empty, type Ctx } from "./TasksApp";

const DAY = 86_400_000;
const PX = { week: 34, month: 12 } as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);

/** Timeline (Gantt): epics with their issues as bars from start to due; drag a bar or its ends to reschedule. */
export default function Timeline({ ctx, tasks }: { ctx: Ctx; tasks: Task[] }) {
  const { canWrite } = ctx;
  const [zoom, setZoom] = useState<"week" | "month">("week");
  const [from, setFrom] = useState(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 14));
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "start" | "end"; x: number; start: string; due: string; dx: number } | null>(null);
  const px = PX[zoom];
  const span = zoom === "week" ? 84 : 210;
  const days = Array.from({ length: span }, (_, i) => new Date(from.getTime() + i * DAY));
  const xOf = (s: string) => ((parse(s).getTime() - from.getTime()) / DAY) * px;
  const scroller = useRef<HTMLDivElement>(null);

  const epics = tasks.filter((t) => t.type === "epic");
  const rows = useMemo(() => {
    const out: { t: Task; depth: number; epic?: boolean }[] = [];
    for (const e of epics) {
      out.push({ t: e, depth: 0, epic: true });
      if (open.has(e.id)) for (const c of tasks.filter((x) => x.epicId === e.id)) out.push({ t: c, depth: 1 });
    }
    for (const t of tasks.filter((x) => x.type !== "epic" && !x.epicId && (x.start || x.due))) out.push({ t, depth: 0 });
    return out;
  }, [tasks, epics, open]);

  // An epic without its own dates spans its issues.
  const range = (t: Task): [string, string] | null => {
    if (t.start || t.due) return [t.start ?? t.due!, t.due ?? t.start!];
    if (t.type === "epic") {
      const kids = tasks.filter((x) => x.epicId === t.id && (x.start || x.due));
      if (!kids.length) return null;
      const s = kids.map((k) => k.start ?? k.due!).sort()[0];
      const e = kids.map((k) => k.due ?? k.start!).sort().at(-1)!;
      return [s, e];
    }
    return null;
  };

  function onDown(e: React.PointerEvent, t: Task, mode: "move" | "start" | "end") {
    if (!canWrite) return;
    const r = range(t);
    if (!r) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: t.id, mode, x: e.clientX, start: r[0], due: r[1], dx: 0 });
  }
  function onMove(e: React.PointerEvent) {
    if (drag) setDrag({ ...drag, dx: e.clientX - drag.x });
  }
  async function onUp() {
    if (!drag) return;
    const shift = Math.round(drag.dx / px);
    const d = drag;
    setDrag(null);
    if (!shift) return ctx.open(d.id);
    const add = (s: string, n: number) => iso(new Date(parse(s).getTime() + n * DAY));
    let start = d.start, due = d.due;
    if (d.mode === "move") { start = add(start, shift); due = add(due, shift); }
    else if (d.mode === "start") start = add(start, shift) > due ? due : add(start, shift);
    else due = add(due, shift) < start ? start : add(due, shift);
    await ctx.patch(d.id, { start, due });
  }

  if (!epics.length && !tasks.some((t) => t.start || t.due))
    return <Empty title="Plan on a timeline" body="Create epics for the big pieces of work, and give issues a start and due date. They appear here as bars you can drag to reschedule." action={canWrite ? <button className="ws-btn primary" onClick={() => ctx.create({ type: "epic" })}>Create an epic</button> : null} />;

  const today = new Date();
  const todayX = ((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - from.getTime()) / DAY) * px;
  const months = days.filter((d, i) => i === 0 || d.getUTCDate() === 1);

  return (
    <div className="tk-tl">
      <div className="tk-boardbar">
        <button className="ws-btn" onClick={() => { const d = new Date(); setFrom(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 14))); }}>Today</button>
        <button className="ix-iconbtn" aria-label="Earlier" onClick={() => setFrom(new Date(from.getTime() - (zoom === "week" ? 28 : 90) * DAY))}><ChevronLeft size={16} /></button>
        <button className="ix-iconbtn" aria-label="Later" onClick={() => setFrom(new Date(from.getTime() + (zoom === "week" ? 28 : 90) * DAY))}><ChevronRight size={16} /></button>
        <span style={{ flex: 1 }} />
        <div className="ws-seg" role="group" aria-label="Zoom"><button aria-pressed={zoom === "week"} onClick={() => setZoom("week")}>Weeks</button><button aria-pressed={zoom === "month"} onClick={() => setZoom("month")}>Months</button></div>
      </div>
      <div className="tk-tl-grid" onPointerMove={onMove} onPointerUp={() => void onUp()}>
        <div className="tk-tl-left">
          <div className="tk-tl-hd">Work</div>
          {rows.map(({ t, depth, epic }) => (
            <div key={t.id} className={`tk-tl-name d${depth}`}>
              {epic ? <button className="chevbtn" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })} aria-expanded={open.has(t.id)} aria-label={open.has(t.id) ? "Collapse" : "Expand"}><span className={`chev${open.has(t.id) ? " open" : ""}`}>▸</span></button> : <span className="chevpad" />}
              <TypeIcon type={t.type} size={14} />
              <button className="tk-linkbtn" onClick={() => ctx.open(t.id)}><span className="tk-key">{t.key}</span> {t.title}</button>
            </div>
          ))}
        </div>
        <div className="tk-tl-right" ref={scroller}>
          <div style={{ width: span * px, position: "relative" }}>
            <div className="tk-tl-hd months">
              {months.map((d) => <span key={iso(d)} style={{ left: ((d.getTime() - from.getTime()) / DAY) * px }}>{d.toLocaleDateString([], { month: "short", year: d.getUTCMonth() === 0 || d === days[0] ? "numeric" : undefined, timeZone: "UTC" })}</span>)}
              {zoom === "week" && days.filter((d) => d.getUTCDay() === 1).map((d) => <i key={iso(d)} style={{ left: ((d.getTime() - from.getTime()) / DAY) * px }}>{d.getUTCDate()}</i>)}
            </div>
            {todayX >= 0 && todayX <= span * px && <div className="tk-tl-today" style={{ left: todayX }} />}
            {/* Dependencies: an arrow from each issue to the issues it blocks. */}
            <svg className="tk-tl-deps" width={span * px} height={44 + rows.length * 40} aria-hidden>
              <defs><marker id="tk-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--ix-muted)" /></marker></defs>
              {rows.flatMap(({ t }, i) =>
                (t.blocks ?? []).map((to) => {
                  const j = rows.findIndex((r) => r.t.id === to);
                  const a = range(t);
                  const b = j >= 0 ? range(rows[j].t) : null;
                  if (j < 0 || !a || !b) return null;
                  const x1 = xOf(a[1]) + px, y1 = 44 + i * 40 + 20;
                  const x2 = xOf(b[0]), y2 = 44 + j * 40 + 20;
                  const late = x2 < x1;
                  const mid = Math.max(x1 + 10, x2 - 10);
                  return <path key={`${t.id}-${to}`} d={`M${x1},${y1} H${mid} V${y2} H${x2 - 2}`} fill="none" stroke={late ? "#dc2626" : "var(--ix-muted)"} strokeWidth={1.5} markerEnd="url(#tk-arrow)" opacity={0.8}><title>{`${t.key} blocks ${rows[j].t.key}${late ? " (starts before it can)" : ""}`}</title></path>;
                }),
              )}
            </svg>
            {rows.map(({ t, epic }) => {
              const r = range(t);
              const p = ctx.projects.find((x) => x.id === t.projectId);
              const dragging = drag?.id === t.id;
              const shift = dragging ? Math.round(drag!.dx / px) * px : 0;
              const left = r ? xOf(r[0]) + (dragging && drag!.mode !== "end" ? shift : 0) : 0;
              const width = r ? xOf(r[1]) - xOf(r[0]) + px + (dragging ? (drag!.mode === "end" ? shift : drag!.mode === "start" ? -shift : 0) : 0) : 0;
              return (
                <div key={t.id} className="tk-tl-row">
                  {r ? (
                    <div className={`tk-tl-bar${epic ? " epic" : ""}${t.done ? " done" : ""}${dragging ? " drag" : ""}`} style={{ left, width: Math.max(px, width), ["--bc" as string]: epic ? "#7c3aed" : (p?.color ?? "#2563eb") }} onPointerDown={(e) => onDown(e, t, "move")} title={`${t.key} ${t.title}: ${r[0]} → ${r[1]}`}>
                      {canWrite && (t.start || t.due) && <span className="h l" onPointerDown={(e) => onDown(e, t, "start")} />}
                      <span className="lbl">{t.title}</span>
                      {canWrite && (t.start || t.due) && <span className="h r" onPointerDown={(e) => onDown(e, t, "end")} />}
                    </div>
                  ) : (
                    canWrite && <button className="tk-tl-set" onClick={() => { const s = iso(new Date()); void ctx.patch(t.id, { start: s, due: iso(new Date(Date.now() + 7 * DAY)) }); }}>Add dates</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
