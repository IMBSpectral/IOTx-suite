"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Keyboard, Plus, RefreshCw, Search, Sparkles, Users, WifiOff, X } from "lucide-react";
import type { Boot } from "@/lib/page";
import { api, ApiError } from "@/lib/client";
import TimeGrid from "./TimeGrid";
import MonthGrid from "./MonthGrid";
import YearView from "./YearView";
import EventEditor, { draftCopy, draftFrom, draftNew, draftToBody, type Draft } from "./EventEditor";
import EventDetail, { ScopeAsk, type Scope } from "./EventDetail";
import QuickCreate from "./QuickCreate";
import FindTime from "./FindTime";
import AiBar from "./ai/AiBar";
import AiPanel, { type Issue, type PlanBlock } from "./ai/AiPanel";
import PrepModal from "./ai/PrepModal";
import CalendarsMenu from "./CalendarsMenu";
import CalendarSettings, { Shortcuts, type SettingsTab } from "./CalendarSettings";
import { covers } from "./bars";
import type { WorkLoc } from "./WorkLocation";
import { addDays, allDayRange, dateKey, fmtTime, rangeFor, sameDay, setDisplayPrefs, startOfDay, startOfWeek, weekdayOrder, type Cal, type DueTask, type Occ, type Settings, type View } from "./types";

type Google = { allowed: boolean; connected: boolean; lastSyncAt: string | null; error: string | null; connectUrl: string };
type Hit = { id: string; title: string; start: string; end: string; allDay: boolean; location: string; repeats: boolean; color: string; calendar: string };

const VIEWS: { id: View; label: string; key: string }[] = [
  { id: "day", label: "Day", key: "d" }, { id: "4day", label: "4 days", key: "x" }, { id: "week", label: "Week", key: "w" },
  { id: "month", label: "Month", key: "m" }, { id: "year", label: "Year", key: "y" }, { id: "agenda", label: "Schedule", key: "a" },
];
const DEFAULT_SETTINGS: Settings = { weekStart: 1, timeFormat: "12", defaultMinutes: 60, defaultReminders: [10], secondTz: null, showWeekends: true, showDeclined: true, hours: {}, location: {}, tz: "UTC" };

export default function CalendarApp({ boot }: { boot: Boot }) {
  const { me } = boot;
  // Offline: the service worker serves the last saved events; nothing can be changed until the network is back.
  const [offline, setOffline] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const canCreate = !!me.perms["calendar.create"] && !offline;
  const [view, setView] = useState<View>("week");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [cals, setCals] = useState<Cal[]>([]);
  const [events, setEvents] = useState<Occ[]>([]);
  const [tasks, setTasks] = useState<DueTask[]>([]);
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<Draft | null>(null);
  const [quick, setQuick] = useState<Draft | null>(null);
  const [detail, setDetail] = useState<Occ | null>(null);
  const [ask, setAsk] = useState<{ verb: string; run: (s: Scope) => void } | null>(null);
  const [find, setFind] = useState<{ ids: string[]; date: string; draft?: Draft } | null>(null);
  const [google, setGoogle] = useState<Google | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [keys, setKeys] = useState(false);
  const [agendaDays, setAgendaDays] = useState(30);
  // Search
  const [q, setQ] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Calendar AI
  const [panel, setPanel] = useState(false);
  const [panelTab, setPanelTab] = useState<"today" | "ask">("today");
  const [weekIssues, setWeekIssues] = useState<Issue[]>([]);
  const [plan, setPlan] = useState<PlanBlock[] | null>(null);
  const [prepFor, setPrepFor] = useState<{ id: string; occ: string | null } | null>(null);
  const [menu, setMenu] = useState<null | "cals" | "month">(null);

  const setSettings = (s: Settings) => {
    setDisplayPrefs({ weekStart: s.weekStart, h24: s.timeFormat === "24" });
    setSettingsState(s);
  };
  const { from, to, days: allDays } = useMemo(() => rangeFor(view, cursor, agendaDays), [view, cursor, agendaDays, settings.weekStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = view === "week" && !settings.showWeekends ? allDays.filter((d) => d.getDay() !== 0 && d.getDay() !== 6) : allDays;
  // Dates are formatted in the browser's zone: render after mount so server HTML never disagrees.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    try {
      const v = localStorage.getItem("ws.cal.view") as View | null;
      if (v && VIEWS.some((x) => x.id === v)) setView(v);
      if (window.innerWidth < 760 && !v) setView("day");
      const pv = localStorage.getItem("ws.cal.ai");
      setPanel(pv ? pv === "1" && window.innerWidth >= 900 : window.innerWidth >= 1280);
      const h = localStorage.getItem("ws.cal.hidden");
      if (h) setHidden(new Set(JSON.parse(h)));
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("ws.cal.view", view);
      localStorage.setItem("ws.cal.hidden", JSON.stringify([...hidden]));
    } catch {}
  }, [view, hidden]);
  const togglePanel = (tab?: "today" | "ask") => {
    const next = tab ? true : !panel;
    if (tab) setPanelTab(tab);
    setPanel(next);
    try {
      localStorage.setItem("ws.cal.ai", next ? "1" : "0");
    } catch {}
  };
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest?.(".cal-pop-anchor") && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 4000);
  };

  const load = useCallback(async () => {
    let saved = false;
    try {
      const r = await fetch(`/workspace/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`, { cache: "no-store" });
      if (r.status === 401) return window.location.reload();
      const d = (await r.json().catch(() => ({}))) as { calendars: Cal[]; events: Occ[]; tasks: DueTask[]; settings?: Settings; error?: string };
      if (!r.ok) throw new Error(d.error ?? `Request failed (${r.status})`);
      // The service worker marks answers it made from saved data.
      saved = r.headers.get("x-cal-saved") === "1";
      setSavedAt(saved ? r.headers.get("x-cal-saved-at") : null);
      setCals(d.calendars);
      setEvents(d.events);
      setTasks(d.tasks);
      if (d.settings) setSettings(d.settings);
    } catch (e) {
      saved = !navigator.onLine;
      if (!saved) flash((e as Error).message);
    }
    setOffline(saved || !navigator.onLine);
    if (saved || !navigator.onLine) return;
    if (view !== "year")
      api<{ issues: Issue[] }>(`/calendar/ai/insights?from=${dateKey(from)}&to=${dateKey(addDays(to, -1))}`)
        .then((r) => setWeekIssues(r.issues))
        .catch(() => {});
  }, [from, to, view]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    // Back online (or gone): reload at once.
    window.addEventListener("online", load);
    window.addEventListener("offline", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", load);
      window.removeEventListener("offline", load);
    };
  }, [load]);

  // Offline copy: a service worker for /workspace/calendar only keeps the app shell and the event ranges loaded here.
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker
      .register("/workspace/calendar-sw.js", { scope: "/workspace/calendar" })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        const own = (u: string) => {
          try {
            const x = new URL(u);
            return x.origin === location.origin && x.pathname.startsWith("/workspace/_next/static/");
          } catch {
            return false;
          }
        };
        const urls = performance.getEntriesByType("resource").map((e) => e.name).filter(own);
        reg.active?.postMessage({ type: "shell", user: me.id, page: location.pathname, urls });
      })
      .catch(() => {});
  }, [me.id]);

  useEffect(() => {
    api<Google>("/calendar/google").then(setGoogle).catch(() => {});
    // Deep link from a notification: ?event=<id>
    const id = new URLSearchParams(window.location.search).get("event");
    if (id)
      api<{ event: Occ & { start: string } }>(`/calendar/events/${id}`)
        .then(({ event }) => {
          setCursor(startOfDay(new Date(event.start)));
          setPendingOpen(id);
        })
        .catch(() => {});
  }, []);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingOpen) return;
    const o = events.find((e) => e.id === pendingOpen);
    if (o) {
      // ?prep=1 (the Daily Read's prep links) opens the meeting prep instead of the details.
      if (new URLSearchParams(window.location.search).get("prep") === "1") setPrepFor({ id: o.id, occ: o.occ });
      else setDetail(o);
      setPendingOpen(null);
    }
  }, [events, pendingOpen]);

  // Search as you type (Google: the magnifier on the toolbar).
  useEffect(() => {
    if (q === null || q.trim().length < 2) return setHits(null);
    const t = setTimeout(() => api<{ results: Hit[] }>(`/calendar/search?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.results)).catch(() => setHits([])), 220);
    return () => clearTimeout(t);
  }, [q]);

  const shown = offline ? events.map((o) => ({ ...o, canEdit: false, readOnly: true })) : events;
  // Working location (the strip under each date): a marker for one day, else the weekly pattern from Working hours.
  const locMarks = shown.filter((o) => o.eventType === "workingLocation" && o.creatorId === me.id && o.allDay);
  const locOn = Object.keys(settings.location ?? {}).length > 0 || locMarks.length > 0;
  const workLoc = (d: Date): WorkLoc => {
    const m = locMarks.find((o) => covers(o, d));
    if (m) return { label: m.title, day: true };
    const w = settings.location?.[String(d.getDay())];
    return w ? { label: w, day: false } : null;
  };
  const visible = shown.filter((o) => o.eventType !== "workingLocation").filter((o) => (!hidden.has(o.calendarId) || (o.myResponse !== null && !cals.some((c) => c.id === o.calendarId))) && (settings.showDeclined || o.myResponse !== "no"));
  const myCal = cals.find((c) => c.kind === "personal" && c.mine && c.primary) ?? cals.find((c) => c.kind === "personal" && c.ownerId === me.id);
  const calOf = (id: string) => cals.find((c) => c.id === id);

  const setWorkLoc = async (d: Date, label: string | null, weekly: boolean) => {
    try {
      if (weekly) {
        const location = { ...settings.location };
        if (label) location[String(d.getDay())] = label;
        else delete location[String(d.getDay())];
        setSettings({ ...settings, location });
        const r = await api<{ settings: Settings }>("/calendar/settings", { method: "PUT", body: { location } });
        setSettings(r.settings);
      } else {
        const mark = locMarks.find((o) => covers(o, d));
        if (mark && !label) await api(`/calendar/events/${mark.id}`, { method: "DELETE" });
        else if (mark && label) await api(`/calendar/events/${mark.id}`, { method: "PATCH", body: { title: label } });
        else if (label)
          await api("/calendar/events", { body: { title: label, start: dateKey(d), end: dateKey(addDays(d, 1)), allDay: true, eventType: "workingLocation", transparency: "free", reminders: [], calendarId: myCal?.id } });
      }
      flash(label ? `Working location: ${label}${weekly ? ` every ${d.toLocaleDateString([], { weekday: "long" })}` : ""}` : "Working location cleared");
    } catch (e) {
      flash((e as Error).message);
    }
    void load();
  };

  const step = (n: number) => {
    if (view === "day") setCursor(addDays(cursor, n));
    else if (view === "4day") setCursor(addDays(cursor, 4 * n));
    else if (view === "week") setCursor(addDays(cursor, 7 * n));
    else if (view === "month") setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
    else if (view === "year") setCursor(new Date(cursor.getFullYear() + n, 0, 1));
    else setCursor(addDays(cursor, agendaDays * n));
  };
  const span = (s: Date, e: Date) =>
    s.getMonth() === e.getMonth()
      ? `${s.toLocaleDateString([], { month: "long" })} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}`
      : `${s.toLocaleDateString([], { month: "short", day: "numeric" })} – ${e.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
  const title =
    view === "day"
      ? cursor.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })
      : view === "week"
        ? span(startOfWeek(cursor), addDays(startOfWeek(cursor), 6))
        : view === "4day"
          ? span(cursor, addDays(cursor, 3))
          : view === "month"
            ? cursor.toLocaleDateString([], { month: "long", year: "numeric" })
            : view === "year"
              ? String(cursor.getFullYear())
              : `From ${cursor.toLocaleDateString([], { month: "long", day: "numeric" })}`;

  // ── Actions
  const newDraft = (s: Date, e: Date, allDay: boolean) => draftNew(s, e, allDay, myCal?.id ?? cals[0]?.id ?? "", { reminders: settings.defaultReminders });
  const openNew = (s: Date, e: Date, allDay: boolean) => {
    if (!canCreate) return flash("Your role can't create events.");
    setQuick(newDraft(s, e, allDay));
  };
  const openFull = (s: Date, e: Date, allDay: boolean) => {
    if (!canCreate) return flash("Your role can't create events.");
    setEditor(newDraft(s, e, allDay));
  };
  const createNow = () => {
    const s = new Date();
    s.setMinutes(s.getMinutes() < 30 ? 30 : 60, 0, 0);
    const base = sameDay(cursor, new Date()) ? s : new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 9);
    openFull(base, new Date(base.getTime() + settings.defaultMinutes * 60_000), false);
  };

  const uploadFiles = async (eventId: string, files: File[]) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`/workspace/api/calendar/events/${eventId}/files`, { method: "POST", body: fd });
      if (!r.ok) flash(`${f.name}: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? "upload failed"}`);
    }
  };

  const save = async (d: Draft) => {
    const b = draftToBody(d);
    const run = async (scope?: Scope) => {
      setSaving(true);
      try {
        const r = d.id
          ? await api<{ event: { id: string }; warnings?: string[] }>(`/calendar/events/${d.id}`, { method: "PATCH", body: { ...b, ...(d.isSeries ? { scope, occ: d.occ } : {}) } })
          : await api<{ event: { id: string }; warnings?: string[] }>("/calendar/events", { body: b });
        if (!d.id && d.files.length) await uploadFiles(r.event.id, d.files);
        setEditor(null);
        setQuick(null);
        setDetail(null);
        flash(r.warnings?.length ? r.warnings.join(" ") : d.id ? "Event saved" : "Event created");
        await load();
      } catch (e) {
        flash((e as Error).message);
      } finally {
        setSaving(false);
      }
    };
    if (d.id && d.isSeries) setAsk({ verb: "Edit", run: (s) => { setAsk(null); void run(s); } });
    else await run();
  };

  const move = async (o: Occ, s: Date, e: Date) => {
    const body = o.allDay ? { start: dateKey(s), end: dateKey(e), allDay: true } : { start: s.toISOString(), end: e.toISOString() };
    const run = async (scope?: Scope) => {
      // Optimistic move.
      setEvents((xs) => xs.map((x) => (x === o ? { ...x, start: o.allDay ? new Date(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate())).toISOString() : s.toISOString(), end: o.allDay ? new Date(Date.UTC(e.getFullYear(), e.getMonth(), e.getDate())).toISOString() : e.toISOString() } : x)));
      try {
        const r = await api<{ warnings?: string[] }>(`/calendar/events/${o.id}`, { method: "PATCH", body: { ...body, ...(o.rrule ? { scope, occ: o.occ } : {}) } });
        if (r.warnings?.length) flash(r.warnings.join(" "));
      } catch (err) {
        flash((err as Error).message);
      }
      load();
    };
    if (o.rrule) setAsk({ verb: "Move", run: (sc) => { setAsk(null); void run(sc); } });
    else await run();
  };

  const remove = (o: Occ) => {
    const run = async (scope?: Scope) => {
      try {
        await api(`/calendar/events/${o.id}?${new URLSearchParams(o.rrule ? { scope: scope ?? "all", occ: o.occ ?? "" } : {})}`, { method: "DELETE" });
        setDetail(null);
        flash("Event deleted");
        load();
      } catch (e) {
        flash((e as Error).message);
      }
    };
    if (o.rrule) setAsk({ verb: "Delete", run: (s) => { setAsk(null); void run(s); } });
    else if (confirm(`Delete “${o.title}”?`)) void run();
  };

  const respond = async (o: Occ, r: "yes" | "no" | "maybe", extra?: { comment?: string; proposeStart?: string; proposeEnd?: string }) => {
    try {
      await api(`/calendar/events/${o.id}/respond`, { body: { response: r, ...extra } });
      setDetail({ ...o, myResponse: r, attendees: o.attendees.map((a) => (a.userId === me.id ? { ...a, response: r, comment: extra?.comment ?? a.comment } : a)) });
      if (extra?.proposeStart) flash("New time proposed to the organizer");
      load();
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api<{ ok: boolean; error?: string; created: number; updated: number; deleted: number; pushed: number }>("/calendar/google", { body: { action: "sync" } });
      flash(r.ok ? `Synced with Google: ${r.created} new, ${r.updated} changed, ${r.deleted} removed, ${r.pushed} sent` : `Sync failed: ${r.error}`);
      api<Google>("/calendar/google").then(setGoogle).catch(() => {});
      load();
    } catch (e) {
      if (e instanceof ApiError && e.data.reconnect) setGoogle((g) => (g ? { ...g, connected: false } : g));
      flash((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  // Dragging a task chip to another day moves its due date (in Tasks too).
  const moveTask = async (t: DueTask, day: string) => {
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: { due: day } });
      flash(`Due date moved to ${new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`);
    } catch (e) {
      flash((e as Error).message);
    }
    void load();
  };

  const openTask = (t: DueTask) => {
    window.location.href = `/workspace/tasks?project=${t.projectId}&task=${t.id}`;
  };

  // ── Keyboard shortcuts (Google Calendar's set)
  const modalOpen = !!(editor || quick || ask || find || settingsTab || prepFor || keys);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true]")) return;
      if (detail && !modalOpen) {
        if (e.key === "e" && detail.canEdit) {
          e.preventDefault();
          setEditor(draftFrom(detail, detail.color !== calOf(detail.calendarId)?.color ? detail.color : null));
          setDetail(null);
        } else if ((e.key === "Delete" || e.key === "Backspace" || e.key === "#") && detail.canEdit) remove(detail);
        return;
      }
      if (modalOpen) return;
      const v = VIEWS.find((x) => x.key === e.key);
      if (v) return setView(v.id);
      if (e.key === "t") setCursor(startOfDay(new Date()));
      else if (e.key === "j" || e.key === "n") step(1);
      else if (e.key === "k" || e.key === "p") step(-1);
      else if (e.key === "c" && canCreate) { e.preventDefault(); createNow(); }
      else if (e.key === "/") { e.preventDefault(); setQ((x) => x ?? ""); setTimeout(() => searchRef.current?.focus(), 0); }
      else if (e.key === "?") setKeys(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // ── Mini month (a popover on the title: no second sidebar inside the suite)
  const miniMonth = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const miniDays = rangeFor("month", miniMonth).days;
  const mini = (
    <div className="cal-mini">
      <div className="cal-mini-head">
        {/* Jump to any month and year, not only one month at a time. */}
        <span className="cal-mini-pick">
          <select aria-label="Month" value={miniMonth.getMonth()} onChange={(e) => setCursor(new Date(miniMonth.getFullYear(), Number(e.target.value), 1))}>
            {Array.from({ length: 12 }, (_, m) => (
              <option key={m} value={m}>{new Date(2000, m, 1).toLocaleDateString([], { month: "long" })}</option>
            ))}
          </select>
          <select aria-label="Year" value={miniMonth.getFullYear()} onChange={(e) => setCursor(new Date(Number(e.target.value), miniMonth.getMonth(), 1))}>
            {Array.from({ length: 101 }, (_, i) => new Date().getFullYear() - 50 + i).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </span>
        <span>
          <button className="ix-iconbtn" style={{ width: 24, height: 24 }} onClick={() => setCursor(new Date(cursor.getFullYear() - 1, cursor.getMonth(), 1))} aria-label="Previous year" title="Previous year"><ChevronsLeft size={14} /></button>
          <button className="ix-iconbtn" style={{ width: 24, height: 24 }} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft size={14} /></button>
          <button className="ix-iconbtn" style={{ width: 24, height: 24 }} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight size={14} /></button>
          <button className="ix-iconbtn" style={{ width: 24, height: 24 }} onClick={() => setCursor(new Date(cursor.getFullYear() + 1, cursor.getMonth(), 1))} aria-label="Next year" title="Next year"><ChevronsRight size={14} /></button>
        </span>
      </div>
      <div className="cal-mini-grid">
        {weekdayOrder().map((d) => <span key={d}>{new Date(2024, 0, 7 + d).toLocaleDateString([], { weekday: "narrow" })}</span>)}
        {miniDays.map((d) => (
          <button key={d.toISOString()} className={`${d.getMonth() !== miniMonth.getMonth() ? "out " : ""}${sameDay(d, new Date()) ? "today " : ""}${sameDay(d, cursor) ? "sel" : ""}`} onClick={() => { setCursor(d); setMenu(null); }}>
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );

  // Plan my day: tentative focus blocks shown on the grid until accepted or dismissed.
  const planOcc: Occ[] = (plan ?? []).map((p) => ({
    id: `plan:${p.taskId}`, occ: null, seriesId: null, title: `Focus: ${p.title}`, description: p.reason, location: "", start: p.start, end: p.end, allDay: false, tz: me.tz,
    rrule: null, calendarId: "", color: "#16a34a", reminders: [], conferenceUrl: null, creatorId: me.id, attendees: [], myResponse: "needs", canEdit: false, google: false,
  }));
  const openOcc = (o: Occ) => {
    if (o.id.startsWith("plan:")) return togglePanel("today");
    setDetail(o);
  };
  const issueCount = weekIssues.filter((i) => i.kind !== "backtoback").length;
  const briefDate = days.some((d) => sameDay(d, new Date())) ? dateKey(new Date()) : dateKey(view === "day" ? cursor : days[0] ?? cursor);

  if (!mounted)
    return (
      <div className="ws-app">
        <div className="ws-center" style={{ minHeight: 0, flex: 1 }}><div className="ws-spinner" aria-hidden /></div>
      </div>
    );
  return (
    <div className="ws-app cal-app">
      <div className="cal-wrap">
        <div className="ws-toolbar">
          {canCreate && (
            <button className="ws-btn primary" onClick={createNow} title="Create (c)">
              <Plus size={15} /> <span>Create</span>
            </button>
          )}
          <button className="ws-btn" onClick={() => setCursor(startOfDay(new Date()))} title="Today (t)">Today</button>
          <button className="ix-iconbtn" onClick={() => step(-1)} aria-label="Previous" title="Previous (k)"><ChevronLeft size={18} /></button>
          <button className="ix-iconbtn" onClick={() => step(1)} aria-label="Next" title="Next (j)"><ChevronRight size={18} /></button>
          <div className="cal-pop-anchor">
            <button className="cal-title-btn" onClick={() => setMenu((m) => (m === "month" ? null : "month"))} aria-haspopup="dialog" aria-expanded={menu === "month"}>
              <h2>{title}</h2>
              <ChevronDown size={15} />
            </button>
            {menu === "month" && <div className="ix-pop cal-pop">{mini}</div>}
          </div>
          <span className="ix-sp" style={{ flex: 1 }} />
          {q === null ? (
            <button className="ix-iconbtn" onClick={() => { setQ(""); setTimeout(() => searchRef.current?.focus(), 0); }} aria-label="Search" title="Search (/)"><Search size={17} /></button>
          ) : (
            <div className="cal-search cal-pop-anchor">
              <Search size={15} />
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events or guests" aria-label="Search events"
                onKeyDown={(e) => { if (e.key === "Escape") { setQ(null); setHits(null); } }} />
              <button className="ix-iconbtn" style={{ width: 24, height: 24 }} onClick={() => { setQ(null); setHits(null); }} aria-label="Close search"><X size={14} /></button>
              {hits && (
                <div className="ix-pop cal-pop cal-hits" role="listbox" aria-label="Search results">
                  {hits.length === 0 && <div className="ws-muted" style={{ padding: 10 }}>No events match.</div>}
                  {hits.map((h) => (
                    <button key={h.id + h.start} role="option" aria-selected={false} onClick={() => { setCursor(startOfDay(new Date(h.start))); if (view === "year" || view === "agenda") setView("week"); setPendingOpen(h.id); setQ(null); setHits(null); }}>
                      <span className="dot" style={{ background: h.color }} />
                      <span className="d">{new Date(h.start).toLocaleDateString([], { day: "numeric", month: "short", year: new Date(h.start).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined })}</span>
                      <span style={{ flex: 1, minWidth: 0 }}><b>{h.title}</b><small className="ws-muted"> {h.allDay ? "All day" : fmtTime(new Date(h.start))}{h.repeats ? " · repeats" : ""} · {h.calendar}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {issueCount > 0 && view !== "year" && (
            <button className="ws-btn cal-issues" onClick={() => togglePanel("today")} title="Conflicts and overload in this period">
              <AlertTriangle size={14} /> {issueCount} <span className="ws-hide-mobile">{issueCount === 1 ? "issue" : "issues"}</span>
            </button>
          )}
          {!offline && <button className="ws-btn ws-hide-mobile" onClick={() => setFind({ ids: [], date: dateKey(cursor) })}><Users size={15} /> Find a time</button>}
          {google?.connected && (
            <button className="ix-iconbtn" onClick={syncNow} disabled={syncing} aria-label="Sync with Google" title="Sync with Google">
              <RefreshCw size={16} className={syncing ? "spin" : ""} />
            </button>
          )}
          <select className="ws-select cal-view-select" aria-label="View" value={view} onChange={(e) => setView(e.target.value as View)}>
            {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
          <div className="ws-seg cal-view-seg" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.id} aria-pressed={view === v.id} onClick={() => setView(v.id)} title={`${v.label} (${v.key})`}>{v.label}</button>
            ))}
          </div>
          <div className="cal-pop-anchor">
            <button className="ix-iconbtn" onClick={() => setMenu((m) => (m === "cals" ? null : "cals"))} aria-label="Calendars and settings" title="Calendars and settings" aria-expanded={menu === "cals"}>
              <CalendarDays size={17} />
            </button>
            {menu === "cals" && (
              <CalendarsMenu cals={cals} hidden={hidden} setHidden={setHidden} google={google} syncing={syncing} syncNow={syncNow}
                openSettings={(t) => { setSettingsTab(t); setMenu(null); }} print={() => { setMenu(null); setTimeout(() => window.print(), 50); }} />
            )}
          </div>
          <button className={`ws-btn ai-toggle${panel ? " on" : ""}`} onClick={() => togglePanel()} aria-pressed={panel} title="Calendar assistant">
            <Sparkles size={15} /> <span className="ws-hide-mobile">Assistant</span>
          </button>
        </div>
        {canCreate && (
          <AiBar calendarId={myCal?.id ?? cals[0]?.id ?? ""} flash={flash} focusSignal={0}
            onCreated={(start) => { setCursor(startOfDay(new Date(start))); load(); }}
            onEdit={(d) => setEditor(d)} />
        )}
        {offline && (
          <div className="ws-banner cal-offline" role="status">
            <WifiOff size={15} />
            <span><b>Offline — showing saved events</b>{savedAt ? ` (saved ${new Date(savedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })})` : ""}. Changes are off until you're back online.</span>
          </div>
        )}
        {google?.allowed && !google.connected && !offline && (
          <div className="ws-banner">
            <span>See your Google Calendar here and keep both in step.</span>
            <a className="ws-btn primary" href={google.connectUrl}>Connect Google Calendar</a>
          </div>
        )}
        <div className="cal-body">
        <div className="cal-main">
        <div className="cal-print-title">{title}</div>
        {(view === "day" || view === "week" || view === "4day") && (
          <TimeGrid days={days} events={[...visible, ...planOcc]} tasks={tasks} canCreate={canCreate} onCreate={openNew} onOpen={openOcc} onMove={move} onOpenTask={openTask} onMoveTask={moveTask}
            hours={settings.hours} secondTz={settings.secondTz} defaultMinutes={settings.defaultMinutes}
            workLoc={locOn ? workLoc : undefined} onWorkLoc={offline ? undefined : setWorkLoc} />
        )}
        {view === "month" && (
          <MonthGrid days={days} month={cursor.getMonth()} events={visible} tasks={tasks} canCreate={canCreate} onCreate={openNew} onOpen={setDetail} onMove={move} onOpenTask={openTask} onMoveTask={moveTask}
            onDay={(d) => { setCursor(d); setView("day"); }} />
        )}
        {view === "year" && <YearView year={cursor.getFullYear()} events={visible} tasks={tasks} onDay={(d) => { setCursor(d); setView("day"); }} />}
        {view === "agenda" && <Agenda days={days} events={visible} tasks={tasks} onOpen={setDetail} onOpenTask={openTask} onMore={() => setAgendaDays((n) => Math.min(n + 30, 360))} canMore={agendaDays < 360} />}
        </div>
        {panel && (
          <AiPanel tab={panelTab} setTab={setPanelTab} date={briefDate} weekIssues={weekIssues} plan={plan} setPlan={setPlan} onChanged={load} canCreate={canCreate}
            onPrepare={(id, occ) => setPrepFor({ id, occ })} flash={flash} onClose={() => togglePanel()}
            onOpenEvent={(id, start) => { const o = events.find((e) => e.id === id && e.start === start); if (o) setDetail(o); }} />
        )}
        </div>
      </div>

      {detail && (
        <EventDetail o={detail} cal={calOf(detail.calendarId)} meId={me.id} onClose={() => setDetail(null)} flash={flash} onChanged={load}
          onEdit={() => { setEditor(draftFrom(detail, detail.color !== calOf(detail.calendarId)?.color ? detail.color : null)); setDetail(null); }}
          onDuplicate={canCreate && !detail.id.startsWith("bday:") ? () => { setEditor({ ...draftCopy(detail, detail.color !== calOf(detail.calendarId)?.color ? detail.color : null), calendarId: calOf(detail.calendarId)?.access && ["owner", "manage", "edit"].includes(calOf(detail.calendarId)!.access!) ? detail.calendarId : myCal?.id ?? detail.calendarId }); setDetail(null); } : undefined}
          onDelete={() => remove(detail)} onRespond={(r, extra) => respond(detail, r, extra)} onPrepare={offline ? undefined : () => { setPrepFor({ id: detail.id, occ: detail.occ }); setDetail(null); }} />
      )}
      {quick && (
        <QuickCreate draft={quick} busy={saving} onSave={save} onClose={() => setQuick(null)} onMore={(d) => { setQuick(null); setEditor(d); }} />
      )}
      {editor && (
        <EventEditor draft={editor} calendars={cals} people={boot.people} meId={me.id} busy={saving} onSave={save} onClose={() => setEditor(null)}
          onFindTime={(d) => { setFind({ ids: d.guests.filter((g) => g.userId).map((g) => g.userId!), date: d.sDate, draft: d }); setEditor(null); }} />
      )}
      {find && (
        <FindTime people={boot.people} me={{ id: me.id, name: me.name, email: me.email, image: null }} initial={find.ids} date={find.date} onClose={() => { if (find.draft) setEditor(find.draft); setFind(null); }}
          onPick={(s, e, ids) => {
            const base = find.draft ?? newDraft(s, e, false);
            const guests = [...base.guests.filter((g) => !g.userId || ids.includes(g.userId))];
            for (const id of ids) if (!guests.some((g) => g.userId === id)) { const p = boot.people.find((x) => x.id === id); if (p) guests.push({ userId: p.id, email: p.email, name: p.name }); }
            setEditor({ ...base, sDate: dateKey(s), sTime: `${String(s.getHours()).padStart(2, "0")}:${String(s.getMinutes()).padStart(2, "0")}`, eDate: dateKey(e), eTime: `${String(e.getHours()).padStart(2, "0")}:${String(e.getMinutes()).padStart(2, "0")}`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, guests });
            setFind(null);
          }} />
      )}
      {settingsTab && (
        <CalendarSettings tab={settingsTab} google={!!google?.connected} cals={cals} people={boot.people} meId={me.id} settings={settings} canTeam={!!me.perms["calendar.team"]}
          onSettings={setSettings} onChanged={load} onClose={() => { setSettingsTab(null); load(); }} flash={flash} />
      )}
      {keys && (
        <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && setKeys(false)}>
          <div className="ws-modal" style={{ width: 420 }} role="dialog" aria-label="Keyboard shortcuts">
            <header><Keyboard size={16} /><h3>Keyboard shortcuts</h3><button className="ix-iconbtn" onClick={() => setKeys(false)} aria-label="Close"><X size={18} /></button></header>
            <div className="body"><Shortcuts /></div>
          </div>
        </div>
      )}
      {ask && <ScopeAsk verb={ask.verb} onPick={ask.run} onClose={() => setAsk(null)} />}
      {prepFor && <PrepModal eventId={prepFor.id} occ={prepFor.occ} suite={boot.suite} onClose={() => setPrepFor(null)} />}
      {toast && <div className="ws-toast" role="status">{toast}</div>}
    </div>
  );
}

function Agenda({ days, events, tasks, onOpen, onOpenTask, onMore, canMore }: { days: Date[]; events: Occ[]; tasks: DueTask[]; onOpen: (o: Occ) => void; onOpenTask: (t: DueTask) => void; onMore: () => void; canMore: boolean }) {
  const rows = days
    .map((d) => {
      const next = addDays(d, 1);
      const evs = events.filter((o) => {
        if (o.allDay) {
          const r = allDayRange(o);
          return r.start <= d && r.end > d;
        }
        return new Date(o.start) < next && new Date(o.end) > d;
      });
      return { d, evs, ts: tasks.filter((t) => t.due === dateKey(d)) };
    })
    .filter((r) => r.evs.length || r.ts.length);
  return (
    <div className="ag">
      {!rows.length && <div className="ws-empty">Nothing in the next {days.length} days.</div>}
      {rows.map(({ d, evs, ts }) => (
        <div key={d.toISOString()} className={`ag-day${sameDay(d, new Date()) ? " today" : ""}`}>
          <h4>
            {d.toLocaleDateString([], { weekday: "short" })} {d.getDate()}
            <span>{d.toLocaleDateString([], { month: "long", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined })}</span>
          </h4>
          <div>
            {evs.map((o) => (
              <div key={o.id + (o.occ ?? "")} className={`ag-item${o.myResponse === "no" ? " declined" : ""}`} role="button" tabIndex={0} onClick={() => onOpen(o)} onKeyDown={(e) => e.key === "Enter" && onOpen(o)}>
                <span className="dot" style={{ background: o.color }} />
                <span className="t">{o.allDay ? "All day" : `${fmtTime(new Date(o.start))} – ${fmtTime(new Date(o.end))}`}</span>
                <span style={{ flex: 1, minWidth: 0 }}>{o.title}{o.location ? <small className="ws-muted"> · {o.location}</small> : null}</span>
                {o.conferenceUrl && <a className="join" style={{ padding: "3px 10px", fontSize: 12 }} href={o.conferenceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Join</a>}
              </div>
            ))}
            {ts.map((t) => (
              <div key={t.id} className="ag-item" role="button" tabIndex={0} onClick={() => onOpenTask(t)} onKeyDown={(e) => e.key === "Enter" && onOpenTask(t)}>
                <span className="dot" style={{ background: t.overdue ? "var(--ws-danger)" : "var(--ws-ok)", borderRadius: 3 }} />
                <span className="t">{t.overdue ? "Overdue" : "Due"}</span>
                <span style={{ flex: 1, minWidth: 0, textDecoration: t.status === "done" ? "line-through" : undefined }}>{t.title} <small className="ws-muted">· {t.project}</small></span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {canMore && <div style={{ textAlign: "center", padding: 14 }}><button className="ws-btn" onClick={onMore}>Show the next 30 days</button></div>}
    </div>
  );
}
