"use client";
import { addDays, allDayRange, dateKey, rangeFor, sameDay, weekdayOrder, type DueTask, type Occ } from "./types";

/** Google's Year view: twelve small months; days with events are marked, and a click opens that day. */
export default function YearView({ year, events, tasks, onDay }: { year: number; events: Occ[]; tasks: DueTask[]; onDay: (d: Date) => void }) {
  const today = new Date();
  // Count events per local day once.
  const count = new Map<string, number>();
  const bump = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);
  for (const o of events) {
    if (o.allDay) {
      const r = allDayRange(o);
      for (let d = r.start; d < r.end; d = addDays(d, 1)) bump(dateKey(d));
    } else bump(dateKey(new Date(o.start)));
  }
  for (const t of tasks) bump(t.due);
  const order = weekdayOrder();
  return (
    <div className="yv">
      {Array.from({ length: 12 }, (_, m) => {
        const first = new Date(year, m, 1);
        const days = rangeFor("month", first).days;
        return (
          <section key={m} className="yv-month" aria-label={first.toLocaleDateString([], { month: "long", year: "numeric" })}>
            <h4>{first.toLocaleDateString([], { month: "long" })}</h4>
            <div className="yv-grid">
              {order.map((d) => <span key={d} className="wd">{new Date(2024, 0, 7 + d).toLocaleDateString([], { weekday: "narrow" })}</span>)}
              {days.map((d) => {
                const n = count.get(dateKey(d)) ?? 0;
                const out = d.getMonth() !== m;
                return (
                  <button key={d.toISOString()} className={`${out ? "out " : ""}${sameDay(d, today) ? "today " : ""}${n && !out ? "has" : ""}`}
                    onClick={() => onDay(d)} aria-label={`${d.toDateString()}${n ? `, ${n} ${n === 1 ? "item" : "items"}` : ""}`} tabIndex={out ? -1 : 0}>
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
