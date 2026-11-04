"use client";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Lock, MapPin, X } from "lucide-react";
import TimeGrid from "../TimeGrid";
import MonthGrid from "../MonthGrid";
import { addDays, allDayRange, dateKey, rangeFor, sameDay, startOfDay, startOfWeek, tzOffset, type Occ } from "../types";

type PublicEvent = { id: string; title: string; description: string; location: string; start: string; end: string; allDay: boolean; busy: boolean };
type Data = { calendar: { name: string; description: string; color: string; mode: "busy" | "full"; tz: string }; events: PublicEvent[] };
type View = "month" | "week" | "agenda";
const API = "/workspace/api/calendar/embed";
const okZone = (z: string | null) => {
  if (!z) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};
const noop = () => {};

/** Public, read-only view of a calendar (and its iframe): month, week or schedule, in a chosen time zone. No sign-in. */
export default function EmbedPage({ token, view: initialView, title, color, tz, noTitle }: { token: string; view: View; title: string | null; color: string | null; tz: string | null; noTitle: boolean }) {
  const [view, setView] = useState<View>(initialView);
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<PublicEvent | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (window.innerWidth < 560 && initialView === "week") setView("agenda");
  }, [initialView]);

  const zone = okZone(tz) ? tz! : data?.calendar.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { from, to, days } = useMemo(() => rangeFor(view === "agenda" ? "agenda" : view, cursor, 30), [view, cursor]);

  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ from: addDays(from, -1).toISOString(), to: addDays(to, 1).toISOString() });
    fetch(`${API}/${encodeURIComponent(token)}?${q}`, { credentials: "omit" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) return setErr(j.error ?? "This calendar isn't public.");
        setErr("");
        setData(j);
      })
      .catch(() => live && setErr("Couldn't load the calendar."));
    return () => {
      live = false;
    };
  }, [token, from, to]);

  const accent = color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : data?.calendar.color ?? "#4f46e5";
  // Draw in the chosen zone: shift each instant so the browser's wall clock shows that zone's time.
  const shift = (iso: string) => {
    const t = new Date(iso);
    return new Date(t.getTime() + (tzOffset(t, zone) + t.getTimezoneOffset()) * 60_000).toISOString();
  };
  const occ: Occ[] = (data?.events ?? []).map((e) => ({
    id: e.id, occ: null, seriesId: null, title: e.title, description: e.description, location: e.location,
    start: e.allDay ? e.start : shift(e.start), end: e.allDay ? e.end : shift(e.end), allDay: e.allDay, tz: zone, rrule: null,
    calendarId: "public", color: accent, reminders: [], conferenceUrl: null, creatorId: "", attendees: [], myResponse: null, canEdit: false, google: false,
    transparency: "busy", masked: e.busy, eventType: "default",
  }));
  const show = (o: Occ) => setOpen(data?.events.find((e) => e.id === o.id) ?? null);
  const step = (n: number) => setCursor(view === "month" ? new Date(cursor.getFullYear(), cursor.getMonth() + n, 1) : addDays(cursor, (view === "week" ? 7 : 30) * n));
  const period =
    view === "month"
      ? cursor.toLocaleDateString([], { month: "long", year: "numeric" })
      : view === "week"
        ? `${startOfWeek(cursor).toLocaleDateString([], { month: "short", day: "numeric" })} – ${addDays(startOfWeek(cursor), 6).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`
        : `From ${cursor.toLocaleDateString([], { month: "long", day: "numeric" })}`;
  const when = (e: PublicEvent) => {
    if (e.allDay) {
      const r = allDayRange(e);
      const last = addDays(r.end, -1);
      const f = (d: Date) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      return sameDay(r.start, last) ? `${f(r.start)} · All day` : `${f(r.start)} – ${f(last)}`;
    }
    const f = new Intl.DateTimeFormat([], { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const t = new Intl.DateTimeFormat([], { timeZone: zone, hour: "numeric", minute: "2-digit" });
    return `${f.format(new Date(e.start))} – ${t.format(new Date(e.end))}`;
  };

  if (!mounted) return <main className="emb" />;
  return (
    <main className="emb" style={{ ["--accent" as string]: accent }}>
      <div className="emb-bar">
        {!noTitle && <h1>{title || data?.calendar.name || "Calendar"}</h1>}
        <button className="ws-btn sm" onClick={() => setCursor(startOfDay(new Date()))}>Today</button>
        <button className="ix-iconbtn" onClick={() => step(-1)} aria-label="Previous"><ChevronLeft size={17} /></button>
        <button className="ix-iconbtn" onClick={() => step(1)} aria-label="Next"><ChevronRight size={17} /></button>
        <h2>{period}</h2>
        <span style={{ flex: 1 }} />
        <div className="ws-seg" role="group" aria-label="View">
          {(["month", "week", "agenda"] as const).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{v === "month" ? "Month" : v === "week" ? "Week" : "Schedule"}</button>
          ))}
        </div>
      </div>
      <div className="emb-main">
        {err && <div className="ws-empty" role="alert">{err}</div>}
        {!err && view === "month" && (
          <MonthGrid days={days} month={cursor.getMonth()} events={occ} tasks={[]} canCreate={false} onCreate={noop} onOpen={show} onMove={noop} onOpenTask={noop}
            onDay={(d) => { setCursor(d); setView("week"); }} />
        )}
        {!err && view === "week" && <TimeGrid days={days} events={occ} tasks={[]} canCreate={false} onCreate={noop} onOpen={show} onMove={noop} onOpenTask={noop} />}
        {!err && view === "agenda" && (
          <div className="ag">
            {days.map((d) => {
              const evs = occ.filter((o) => (o.allDay ? allDayRange(o).start <= d && allDayRange(o).end > d : new Date(o.start) < addDays(d, 1) && new Date(o.end) > d));
              if (!evs.length) return null;
              return (
                <div key={dateKey(d)} className={`ag-day${sameDay(d, new Date()) ? " today" : ""}`}>
                  <h4>{d.toLocaleDateString([], { weekday: "short" })} {d.getDate()}<span>{d.toLocaleDateString([], { month: "long" })}</span></h4>
                  <div>
                    {evs.map((o) => (
                      <div key={o.id} className="ag-item" role="button" tabIndex={0} onClick={() => show(o)} onKeyDown={(e) => e.key === "Enter" && show(o)}>
                        <span className="dot" style={{ background: o.color }} />
                        <span className="t">{o.allDay ? "All day" : new Date(o.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>{o.title}{o.location ? <small className="ws-muted"> · {o.location}</small> : null}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {data && !occ.some((o) => new Date(o.end) > from && new Date(o.start) < to) && <div className="ws-empty">Nothing in the next 30 days.</div>}
          </div>
        )}
      </div>
      <div className="emb-foot">
        <span>Times in {zone.replace(/_/g, " ")}</span>
        <span>{data?.calendar.mode === "busy" ? "Free/busy only · " : ""}IOTx Calendar</span>
      </div>
      {open && (
        <div className="ix-pop emb-pop" role="dialog" aria-label={open.title}>
          <div className="ws-row" style={{ alignItems: "flex-start" }}>
            <h3 style={{ flex: 1 }}>{open.title}</h3>
            <button className="ix-iconbtn" onClick={() => setOpen(null)} aria-label="Close"><X size={16} /></button>
          </div>
          <div className="ev-meta">
            <div><Clock size={15} /><span>{when(open)}</span></div>
            {open.location && <div><MapPin size={15} /><span>{open.location}</span></div>}
            {open.busy && <div><Lock size={15} /><span className="ws-muted">Only free/busy is shared.</span></div>}
          </div>
          {open.description && <p style={{ whiteSpace: "pre-wrap", fontSize: 13, margin: "8px 0 0" }}>{open.description}</p>}
        </div>
      )}
    </main>
  );
}
