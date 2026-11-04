"use client";
import { useState } from "react";
import { addDays, allDayRange, dateKey, fmtTime, fromKey, sameDay, startOfDay, weekdayOrder, type DueTask, type Occ } from "./types";
import { byLength, covers, dateAtPoint, isMultiDate, occKey, stack, useBarDrag } from "./bars";
import Bar from "./Bar";

type Item = { o?: Occ; t?: DueTask };

export default function MonthGrid({
  days, month, events, tasks, canCreate, onCreate, onOpen, onMove, onOpenTask, onMoveTask, onDay,
}: {
  days: Date[];
  month: number;
  events: Occ[];
  tasks: DueTask[];
  canCreate: boolean;
  onCreate: (start: Date, end: Date, allDay: boolean) => void;
  onOpen: (o: Occ) => void;
  onMove: (o: Occ, start: Date, end: Date) => void;
  onOpenTask: (t: DueTask) => void;
  /** Drag a task to another day: its due date moves there. */
  onMoveTask?: (t: DueTask, day: string) => void;
  onDay: (d: Date) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const [dragged, setDragged] = useState<Occ | null>(null);
  const [draggedTask, setDraggedTask] = useState<DueTask | null>(null);
  const bars = useBarDrag(onMove, onOpen);
  const today = new Date();
  /** Lanes shown per week before "+N more". */
  const MAX = 3;

  // Bars (all-day and multi-day) first, earliest and longest on top; then the day's timed events and tasks.
  const shown = bars.preview(events);
  const long = shown.filter(isMultiDate).sort(byLength);
  const short = shown.filter((o) => !isMultiDate(o)).sort((a, b) => a.start.localeCompare(b.start));
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => days.slice(i * 7, i * 7 + 7));

  // Dragging a timed event or a task (HTML drag and drop) to another day.
  const drop = (k: string | null) => {
    setOver(null);
    if (!k) return;
    const d = fromKey(k);
    if (draggedTask) {
      const t = draggedTask;
      setDraggedTask(null);
      if (t.due !== k) onMoveTask?.(t, k);
      return;
    }
    const o = dragged;
    setDragged(null);
    if (!o || !o.canEdit) return;
    const s = o.allDay ? allDayRange(o).start : new Date(o.start);
    const delta = Math.round((startOfDay(d).getTime() - startOfDay(s).getTime()) / 86_400_000);
    if (!delta) return;
    onMove(o, addDays(new Date(o.start), delta), addDays(new Date(o.end), delta));
  };

  return (
    <div className="mg">
      <div className="mg-head">
        {weekdayOrder().map((d) => (
          <div key={d}>{new Date(2024, 0, 7 + d).toLocaleDateString([], { weekday: "short" })}</div>
        ))}
      </div>
      <div className="mg-body">
        {weeks.map((row) => {
          const { placed } = stack<Item>(row, [
            ...long.map((o) => ({ key: occKey(o), data: { o }, covers: (d: Date) => covers(o, d) })),
            ...short.map((o) => ({ key: occKey(o), data: { o }, covers: (d: Date) => sameDay(d, new Date(o.start)) })),
            ...tasks.map((t) => ({ key: `task:${t.id}`, data: { t }, covers: (d: Date) => dateKey(d) === t.due })),
          ]);
          const hidden = row.map((_, i) => placed.filter((p) => p.lane >= MAX && p.col <= i && i < p.col + p.span).length);
          return (
            <div key={dateKey(row[0])} className="mg-week" style={{ gridTemplateRows: `26px repeat(${MAX}, var(--mg-lane)) minmax(18px, 1fr)` }}
              onDragOver={(e) => { e.preventDefault(); const k = dateAtPoint(e.clientX, e.clientY); if (k !== over) setOver(k); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(null); }}
              onDrop={(e) => drop(dateAtPoint(e.clientX, e.clientY))}>
              {row.map((d, i) => {
                const k = dateKey(d);
                return (
                  <div key={k} data-date={k} style={{ gridColumn: i + 1, gridRow: "1 / -1" }}
                    className={`mg-cell${d.getMonth() !== month ? " out" : ""}${sameDay(d, today) ? " today" : ""}${over === k ? " over" : ""}`}
                    onClick={(e) => {
                      if (e.target === e.currentTarget && canCreate) onCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9), new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10), false);
                    }} />
                );
              })}
              {row.map((d, i) => (
                <button key={`dn${i}`} className={`dn ws-link${sameDay(d, today) ? " today" : ""}`} style={{ gridColumn: i + 1, gridRow: 1 }} onClick={() => onDay(d)} aria-label={`Open ${d.toDateString()}`}>
                  {d.getDate()}
                </button>
              ))}
              {placed.filter((p) => p.lane < MAX).map((p) => {
                const style = { gridColumn: `${p.col + 1} / span ${p.span}`, gridRow: p.lane + 2 };
                if (p.data.t) {
                  const t = p.data.t;
                  return (
                    <button key={p.key} className={`chipev task${t.overdue ? " overdue" : ""}${t.status === "done" ? " done" : ""}`} style={style} onClick={() => onOpenTask(t)} title={`Task · ${t.project} · drag to change the due date`} draggable={!!onMoveTask} onDragStart={() => setDraggedTask(t)} onDragEnd={() => setDraggedTask(null)}>
                      ☐ {t.title}
                    </button>
                  );
                }
                const o = p.data.o!;
                if (isMultiDate(o) || o.allDay)
                  return <Bar key={p.key} o={o} contL={p.contL} contR={p.contR} style={style} dragging={bars.draggingKey === p.key} onPointerDown={(e) => bars.down(e, o)} onOpen={() => onOpen(o)} timeLabel={!o.allDay && !p.contL} />;
                return (
                  <button key={p.key} className={`chipev timed${o.eventType === "outOfOffice" ? " ooo" : ""}${o.myResponse === "no" ? " declined" : ""}`} style={style}
                    draggable={o.canEdit} onDragStart={() => setDragged(o)} onDragEnd={() => setDragged(null)} onClick={() => onOpen(o)} title={o.title}>
                    <i style={{ background: o.color }} />
                    {fmtTime(new Date(o.start))} {o.title}
                  </button>
                );
              })}
              {hidden.map((n, i) =>
                n > 0 ? (
                  <button key={`more${i}`} className="more" style={{ gridColumn: i + 1, gridRow: MAX + 2 }} onClick={() => onDay(row[i])}>
                    +{n} more
                  </button>
                ) : null,
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
