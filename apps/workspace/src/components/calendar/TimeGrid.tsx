"use client";
import { useEffect, useRef, useState } from "react";
import { addDays, dateKey, DAY_MS, fmtHour, fmtTime, HOUR_PX, sameDay, type DueTask, type Occ, type Range } from "./types";
import { byLength, covers, isLong, occKey, stack, useBarDrag } from "./bars";
import Bar from "./Bar";
import WorkStrip, { type WorkLoc } from "./WorkLocation";

const LANE_PX = 22;

type Placed = { o: Occ; top: number; height: number; col: number; cols: number; s: Date; e: Date };
type Drag =
  | { kind: "create"; day: number; startMin: number; curMin: number; moved: boolean }
  | { kind: "move" | "resize"; o: Occ; day: number; grabMin: number; dMin: number; dDay: number; moved: boolean; x0: number; y0: number };

const SNAP = 15;
const snap = (m: number) => Math.round(m / SNAP) * SNAP;

function layout(evs: Occ[], day: Date): Placed[] {
  const d0 = day.getTime(), d1 = addDays(day, 1).getTime();
  const items = evs
    .map((o) => ({ o, s: new Date(Math.max(new Date(o.start).getTime(), d0)), e: new Date(Math.min(new Date(o.end).getTime(), d1)) }))
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s.getTime() - b.s.getTime() || b.e.getTime() - a.e.getTime());
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const n = Math.max(1, ...cluster.map((p) => p.col + 1));
    for (const p of cluster) p.cols = n;
    cluster = [];
  };
  for (const it of items) {
    if (it.s.getTime() >= clusterEnd) flush();
    const used = new Set(cluster.filter((p) => p.e > it.s).map((p) => p.col));
    let col = 0;
    while (used.has(col)) col++;
    const mins = (it.s.getTime() - d0) / 60000;
    const dur = Math.max(20, (it.e.getTime() - it.s.getTime()) / 60000);
    const p: Placed = { o: it.o, s: it.s, e: it.e, top: (mins / 60) * HOUR_PX, height: (dur / 60) * HOUR_PX - 2, col, cols: 1 };
    cluster.push(p);
    out.push(p);
    clusterEnd = Math.max(clusterEnd, it.e.getTime());
  }
  flush();
  return out;
}

export default function TimeGrid({
  days, events, tasks, onCreate, onOpen, onMove, onOpenTask, onMoveTask, canCreate, hours, secondTz, defaultMinutes = 60, workLoc, onWorkLoc,
}: {
  /** Working location per day (the strip under each date), and changing it. */
  workLoc?: (d: Date) => WorkLoc;
  onWorkLoc?: (d: Date, label: string | null, weekly: boolean) => void;
  days: Date[];
  events: Occ[];
  tasks: DueTask[];
  canCreate: boolean;
  onCreate: (start: Date, end: Date, allDay: boolean) => void;
  onOpen: (o: Occ) => void;
  onMove: (o: Occ, start: Date, end: Date) => void;
  onOpenTask: (t: DueTask) => void;
  onMoveTask?: (t: DueTask, day: string) => void;
  /** Working hours per weekday (0 = Sunday): time outside them is shaded. */
  hours?: Record<string, Range[]>;
  /** A second time zone shown beside the hours. */
  secondTz?: string | null;
  /** Length of an event made with a single click. */
  defaultMinutes?: number;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [now, setNow] = useState(() => new Date());
  const today = new Date();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    // Scroll to 7:30 (or now) on first show.
    if (body.current) body.current.scrollTop = Math.max(0, (Math.min(new Date().getHours(), 17) - 1.5) * HOUR_PX);
    return () => clearInterval(t);
  }, []);

  const gutter = secondTz ? 104 : 56;
  const cols = `${gutter}px repeat(${days.length}, minmax(0, 1fr))`;
  const zoneLabel = (tz: string) => new Intl.DateTimeFormat([], { timeZone: tz, timeZoneName: "short" }).formatToParts(days[0] ?? new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz;
  /** Shaded blocks outside working hours, in minutes from midnight. */
  const offHours = (day: Date) => {
    if (!hours) return [];
    const list = [...(hours[String(day.getDay())] ?? [])].sort((a, b) => a.start.localeCompare(b.start));
    const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    const out: [number, number][] = [];
    let at = 0;
    for (const x of list) {
      if (toMin(x.start) > at) out.push([at, toMin(x.start)]);
      at = Math.max(at, toMin(x.end));
    }
    if (at < 1440) out.push([at, 1440]);
    return out;
  };
  const bars = useBarDrag(onMove, onOpen);
  // Timed events of a day or more join the all-day row as bars.
  const timed = events.filter((o) => !isLong(o));
  const long = bars.preview(events.filter(isLong)).sort(byLength);
  const dayKeys = days.map(dateKey);
  const { placed: allDayPlaced, lanes } = stack(days, [
    ...long.map((o) => ({ key: occKey(o), data: { o } as { o?: Occ; t?: DueTask }, covers: (d: Date) => covers(o, d) })),
    ...tasks.filter((t) => dayKeys.includes(t.due)).map((t) => ({ key: `task:${t.id}`, data: { t } as { o?: Occ; t?: DueTask }, covers: (d: Date) => dateKey(d) === t.due })),
  ]);
  const showLoc = !!workLoc;
  const rows = Math.max(1, lanes);

  const minuteAt = (clientY: number) => {
    const el = body.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(24 * 60, ((clientY - rect.top + el.scrollTop) / HOUR_PX) * 60));
  };
  const dayAt = (clientX: number, clientY: number) => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const d = (el as HTMLElement).dataset?.day;
      if (d !== undefined) return Number(d);
    }
    return null;
  };

  const onColDown = (e: React.PointerEvent, di: number) => {
    if (!canCreate || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".tg-ev")) return;
    const m = Math.floor(minuteAt(e.clientY) / SNAP) * SNAP;
    // On touch screens a swipe scrolls the day (the browser cancels the pointer); only a tap creates.
    if (e.pointerType !== "touch") (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "create", day: di, startMin: m, curMin: m + SNAP, moved: false });
  };
  const onEvDown = (e: React.PointerEvent, o: Occ, di: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const resize = (e.target as HTMLElement).classList.contains("rs");
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: resize ? "resize" : "move", o, day: di, grabMin: minuteAt(e.clientY), dMin: 0, dDay: 0, moved: false, x0: e.clientX, y0: e.clientY });
  };
  const onMoveP = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === "create") {
      if (e.pointerType === "touch") return;
      const m = Math.ceil(minuteAt(e.clientY) / SNAP) * SNAP;
      setDrag({ ...drag, curMin: Math.max(m, drag.startMin + SNAP), moved: drag.moved || m > drag.startMin + SNAP });
    } else {
      const moved = drag.moved || Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4;
      const dMin = snap(minuteAt(e.clientY) - drag.grabMin);
      const d = drag.kind === "move" ? dayAt(e.clientX, e.clientY) : null;
      setDrag({ ...drag, dMin, dDay: d === null ? drag.dDay : d - drag.day, moved });
    }
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === "create") {
      const day = days[d.day];
      const s = new Date(day.getTime() + d.startMin * 60000);
      const end = d.moved ? new Date(day.getTime() + d.curMin * 60000) : new Date(s.getTime() + defaultMinutes * 60000);
      onCreate(s, end, false);
      return;
    }
    if (!d.moved) {
      onOpen(d.o);
      return;
    }
    if (!d.o.canEdit) return;
    const s = new Date(d.o.start), en = new Date(d.o.end);
    if (d.kind === "move") {
      const ns = new Date(addDays(s, d.dDay).getTime() + d.dMin * 60000);
      onMove(d.o, ns, new Date(ns.getTime() + (en.getTime() - s.getTime())));
    } else {
      const ne = new Date(Math.max(s.getTime() + SNAP * 60000, en.getTime() + d.dMin * 60000));
      onMove(d.o, s, ne);
    }
  };

  return (
    <div className="tg" onPointerMove={onMoveP} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
      <div className="tg-head" style={{ gridTemplateColumns: cols }}>
        <div className="gutter" />
        {days.map((d) => (
          <div key={d.toISOString()} className={`dh${sameDay(d, today) ? " today" : ""}`}>
            {d.toLocaleDateString([], { weekday: "short" })}
            <b>{d.getDate()}</b>
            {showLoc && <WorkStrip day={d} value={workLoc!(d)} canEdit={!!onWorkLoc} onSet={(label, weekly) => onWorkLoc?.(d, label, weekly)} />}
          </div>
        ))}
      </div>
      <div className="tg-allday" style={{ gridTemplateColumns: cols }}>
        <div className="gutter">{secondTz ? <span className="tz2">{zoneLabel(secondTz)}</span> : null}all-day</div>
        {/* One bar per event across its days, stacked in lanes; the day cells underneath take double-clicks and drops. */}
        <div className="tg-lanes" style={{ gridColumn: `2 / span ${days.length}`, gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, ${LANE_PX}px)` }}>
          {days.map((d, i) => {
            const k = dateKey(d);
            return (
              <div
                key={k}
                className="cell"
                data-date={k}
                style={{ gridColumn: i + 1, gridRow: `1 / span ${rows}` }}
                onDoubleClick={() => canCreate && onCreate(d, addDays(d, 1), true)}
                onDragOver={(e) => { if (e.dataTransfer.types.includes("x-iotx-task")) e.preventDefault(); }}
                onDrop={(e) => {
                  const raw = e.dataTransfer.getData("x-iotx-task");
                  const t = tasks.find((x) => x.id === raw);
                  if (t && t.due !== k) onMoveTask?.(t, k);
                }}
              />
            );
          })}
          {allDayPlaced.map((p) => {
            const style = { gridColumn: `${p.col + 1} / span ${p.span}`, gridRow: p.lane + 1 };
            if (p.data.t) {
              const t = p.data.t;
              return (
                <button key={p.key} className={`chipev task${t.overdue ? " overdue" : ""}${t.status === "done" ? " done" : ""}`} style={style} onClick={() => onOpenTask(t)} title={`Task · ${t.project} · drag to change the due date`} draggable={!!onMoveTask} onDragStart={(e) => e.dataTransfer.setData("x-iotx-task", t.id)}>
                  ☐ {t.title}
                </button>
              );
            }
            const o = p.data.o!;
            return (
              <Bar key={p.key} o={o} contL={p.contL} contR={p.contR} style={style} dragging={bars.draggingKey === p.key}
                onPointerDown={(e) => bars.down(e, o)} onOpen={() => onOpen(o)} timeLabel={!o.allDay && !p.contL} />
            );
          })}
        </div>
      </div>
      <div className="tg-body" ref={body}>
        <div className="tg-grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_PX }}>
          <div className="tg-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h}>
                {secondTz && h > 0 && <span className="tz2">{fmtTime(new Date((days[0] ?? new Date()).getTime() + h * 3_600_000), secondTz).replace(/:00(?=\D|$)/, "")}</span>}
                {h === 0 ? "" : fmtHour(h)}
              </div>
            ))}
          </div>
          {days.map((day, di) => {
            const placed = layout(timed, day);
            const isToday = sameDay(day, today);
            return (
              <div key={day.toISOString()} className={`tg-col${isToday ? " today" : ""}`} data-day={di} onPointerDown={(e) => onColDown(e, di)}>
                {offHours(day).map(([a, b]) => <div key={a} className="tg-off" style={{ top: (a / 60) * HOUR_PX, height: ((b - a) / 60) * HOUR_PX }} />)}
                {isToday && <div className="tg-now" style={{ top: ((now.getTime() - day.getTime()) / 3_600_000) * HOUR_PX }} />}
                {drag?.kind === "create" && drag.day === di && (
                  <div className="tg-sel" style={{ top: (drag.startMin / 60) * HOUR_PX, height: ((drag.curMin - drag.startMin) / 60) * HOUR_PX }}>
                    {fmtTime(new Date(day.getTime() + drag.startMin * 60000))} – {fmtTime(new Date(day.getTime() + drag.curMin * 60000))}
                  </div>
                )}
                {placed.map((p) => {
                  const dragging = drag && drag.kind !== "create" && drag.o === p.o && drag.moved;
                  let top = p.top, height = p.height, shift = 0;
                  if (dragging) {
                    const dy = (drag.dMin / 60) * HOUR_PX;
                    if (drag.kind === "move") {
                      top += dy;
                      shift = drag.dDay;
                    } else height = Math.max(HOUR_PX / 4, height + dy);
                  }
                  const w = 100 / p.cols;
                  return (
                    <div
                      key={p.o.id + (p.o.occ ?? "")}
                      className={`tg-ev${p.o.myResponse === "maybe" || p.o.myResponse === "needs" ? " tentative" : ""}${p.o.myResponse === "no" ? " declined" : ""}${p.o.eventType === "outOfOffice" ? " ooo" : p.o.eventType === "focusTime" ? " focus" : ""}${p.o.transparency === "free" ? " free" : ""}${dragging ? " dragging" : ""}`}
                      style={{
                        top, height, background: p.o.color,
                        left: `calc(${p.col * w}% + 2px + ${shift * 100}%)`,
                        width: `calc(${w}% - 4px)`,
                        cursor: p.o.canEdit ? "grab" : "pointer",
                      }}
                      onPointerDown={(e) => onEvDown(e, p.o, di)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && onOpen(p.o)}
                      aria-label={`${p.o.title}, ${fmtTime(p.s)}`}
                    >
                      <b>{p.o.title}</b>
                      {height > 30 && <span>{fmtTime(new Date(p.o.start))} – {fmtTime(new Date(p.o.end))}</span>}
                      {p.o.canEdit && <span className="rs" />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export { DAY_MS };
