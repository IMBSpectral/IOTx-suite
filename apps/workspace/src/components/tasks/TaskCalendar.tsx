"use client";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { TypeIcon, type Task } from "./ui";
import type { Ctx } from "./TasksApp";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The project's issues on a month calendar by due date; drag to reschedule, click a day to create. */
export default function TaskCalendar({ ctx, tasks }: { ctx: Ctx; tasks: Task[] }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const days = useMemo(() => {
    const start = new Date(month);
    start.setDate(1 - ((start.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) if (t.due) m.set(t.due, [...(m.get(t.due) ?? []), t]);
    return m;
  }, [tasks]);
  const unscheduled = tasks.filter((t) => !t.due && !t.done && t.type !== "epic");
  const today = iso(new Date());

  return (
    <div className="tk-cal">
      <div className="tk-boardbar">
        <button className="ws-btn" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
        <button className="ix-iconbtn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
        <button className="ix-iconbtn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
        <b>{month.toLocaleDateString([], { month: "long", year: "numeric" })}</b>
        <span style={{ flex: 1 }} />
        <span className="ws-muted small">Drag an issue to another day to change its due date.</span>
      </div>
      <div className="tk-cal-body">
        <div className="tk-cal-grid">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="hd">{d}</div>)}
          {days.map((d) => {
            const k = iso(d);
            const items = byDay.get(k) ?? [];
            return (
              <div
                key={k}
                className={`cell${d.getMonth() !== month.getMonth() ? " out" : ""}${k === today ? " today" : ""}${over === k ? " over" : ""}`}
                onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(k); } }}
                onDragLeave={() => setOver((o) => (o === k ? null : o))}
                onDrop={(e) => { e.preventDefault(); const id = drag; setDrag(null); setOver(null); const t = tasks.find((x) => x.id === id); if (t && t.due !== k) void ctx.patch(t.id, { due: k }); }}
              >
                <div className="dn">
                  <span>{d.getDate()}</span>
                  {ctx.canWrite && <button className="add" aria-label={`Create an issue due ${k}`} onClick={() => ctx.create({ due: k } as Partial<Task>)}><Plus size={12} /></button>}
                </div>
                {items.slice(0, 4).map((t) => (
                  <button key={t.id} className={`tk-cal-chip${t.done ? " done" : ""}${t.overdue ? " late" : ""}${t.flagged ? " flagged" : ""}`} draggable={ctx.canWrite} onDragStart={() => setDrag(t.id)} onDragEnd={() => setDrag(null)} onClick={() => ctx.open(t.id)} title={`${t.key} ${t.title}`}>
                    <TypeIcon type={t.type} size={12} /> <span>{t.title}</span>
                  </button>
                ))}
                {items.length > 4 && <span className="more">+{items.length - 4} more</span>}
              </div>
            );
          })}
        </div>
        <aside className="tk-cal-side" onDragOver={(e) => drag && e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = drag; setDrag(null); if (id) void ctx.patch(id, { due: null }); }}>
          <h4>Unscheduled <span className="ws-muted">{unscheduled.length}</span></h4>
          <p className="ws-muted small">Drag onto a day to set its due date.</p>
          {unscheduled.slice(0, 50).map((t) => (
            <button key={t.id} className="tk-cal-chip" draggable={ctx.canWrite} onDragStart={() => setDrag(t.id)} onDragEnd={() => setDrag(null)} onClick={() => ctx.open(t.id)}>
              <TypeIcon type={t.type} size={12} /> <span className="tk-key">{t.key}</span> <span>{t.title}</span>
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
