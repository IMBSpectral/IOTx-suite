export type Access = "none" | "busy" | "read" | "edit" | "manage" | "owner";
export type Cal = {
  id: string; name: string; color: string; kind: string; ownerId: string | null; createdBy?: string;
  description?: string; primary?: boolean; ownerName?: string | null; access?: Access; mine?: boolean; other?: boolean; hidden?: boolean;
  icsUrl?: string | null; icsError?: string | null; icsFetchedAt?: string | null; feed?: string | null; wsAccess?: string; shares?: { userId: string; role: string }[];
  /** Public access (managers see it): none | busy | full, and the public page. */
  publicMode?: string; publicUrl?: string | null;
};
export type Range = { start: string; end: string };
export type Settings = {
  weekStart: 0 | 1 | 6; timeFormat: "12" | "24"; defaultMinutes: number; defaultReminders: number[]; secondTz: string | null;
  showWeekends: boolean; showDeclined: boolean; hours: Record<string, Range[]>; location: Record<string, string>; tz: string;
  /** Profile: "YYYY-MM-DD" or "--MM-DD", and who sees it (private | workspace). */
  birthday?: string | null; birthdayShare?: string;
};
export type Attendee = { userId: string | null; email: string; name: string; response: string; comment?: string; optional?: boolean; proposedStart?: string | null; proposedEnd?: string | null };
export type Occ = {
  id: string;
  occ: string | null;
  seriesId: string | null;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  tz: string;
  rrule: string | null;
  calendarId: string;
  color: string;
  reminders: number[];
  emailReminders?: number[];
  conferenceUrl: string | null;
  creatorId: string;
  attendees: Attendee[];
  myResponse: string | null;
  canEdit: boolean;
  google: boolean;
  visibility?: string;
  transparency?: string;
  eventType?: string;
  autoDecline?: boolean;
  declineMessage?: string;
  guestsCanModify?: boolean;
  guestsCanInvite?: boolean;
  guestsSeeList?: boolean;
  masked?: boolean;
  /** From Google, organized by someone else. */
  googleOrganizer?: string | null;
  /** Shown from saved data while offline: nothing can be changed. */
  readOnly?: boolean;
};
export type DueTask = { id: string; title: string; due: string; status: string; project: string; projectId: string; color: string; overdue: boolean; assigneeId: string | null };
export type Person = { id: string; name: string; email: string; image: string | null };

export type View = "day" | "4day" | "week" | "month" | "year" | "agenda";

export const DAY_MS = 86_400_000;
export const HOUR_PX = 48;

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Display preferences from the person's calendar settings (set once settings load). */
const prefs = { weekStart: 1, h24: false };
export function setDisplayPrefs(p: { weekStart?: number; h24?: boolean }) {
  Object.assign(prefs, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
}
export const weekStart = () => prefs.weekStart;
/** Weeks start on the chosen day (Monday by default). */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() - prefs.weekStart + 7) % 7));
/** Weekday names in display order. */
export const weekdayOrder = () => Array.from({ length: 7 }, (_, i) => (prefs.weekStart + i) % 7);
export const pad = (n: number) => String(n).padStart(2, "0");
export const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeKey = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const fromKey = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** An all-day occurrence covers UTC dates; show it on the same local dates. */
export function allDayRange(o: { start: string; end: string }) {
  const s = new Date(o.start), e = new Date(o.end);
  return { start: new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()), end: new Date(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()) };
}

export function rangeFor(view: View, cursor: Date, agendaDays = 30): { from: Date; to: Date; days: Date[] } {
  if (view === "day") {
    const f = startOfDay(cursor);
    return { from: f, to: addDays(f, 1), days: [f] };
  }
  if (view === "4day") {
    const f = startOfDay(cursor);
    return { from: f, to: addDays(f, 4), days: Array.from({ length: 4 }, (_, i) => addDays(f, i)) };
  }
  if (view === "year") {
    const f = new Date(cursor.getFullYear(), 0, 1);
    return { from: f, to: new Date(cursor.getFullYear() + 1, 0, 1), days: [] };
  }
  if (view === "week") {
    const f = startOfWeek(cursor);
    return { from: f, to: addDays(f, 7), days: Array.from({ length: 7 }, (_, i) => addDays(f, i)) };
  }
  if (view === "month") {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const f = startOfWeek(first);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const weeks = Math.ceil((Math.round((startOfDay(last).getTime() - f.getTime()) / DAY_MS) + 1) / 7);
    const n = weeks * 7;
    return { from: f, to: addDays(f, n), days: Array.from({ length: n }, (_, i) => addDays(f, i)) };
  }
  const f = startOfDay(cursor);
  return { from: f, to: addDays(f, agendaDays), days: Array.from({ length: agendaDays }, (_, i) => addDays(f, i)) };
}

export function fmtTime(d: Date, tz?: string) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hourCycle: prefs.h24 ? "h23" : "h12", ...(tz ? { timeZone: tz } : {}) });
}
export function fmtHour(h: number) {
  return prefs.h24 ? `${pad(h)}:00` : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
}

/** Every IANA zone the browser knows (falls back to a short list). */
export function zones(): string[] {
  try {
    // The browser's list leaves out "UTC" and old aliases (Asia/Calcutta); callers add the saved ones.
    return ["UTC", ...(Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  } catch {
    return ["UTC", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
  }
}
export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Offset of a zone from UTC at an instant, in minutes. */
export function tzOffset(at: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000) / 60000;
}
/** A wall-clock date and time in a zone, as an instant. */
export function zonedToDate(date: string, time: string, tz: string) {
  const [y, m, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = tzOffset(new Date(guess), tz);
  const t = guess - off * 60000;
  return new Date(guess - tzOffset(new Date(t), tz) * 60000);
}
/** An instant as wall-clock date and time in a zone. */
export function dateIn(at: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${pad(+p.hour % 24)}:${p.minute}` };
}
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function fmtRange(o: Occ) {
  if (o.allDay) {
    const r = allDayRange(o);
    const last = addDays(r.end, -1);
    const f = (d: Date) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return sameDay(r.start, last) ? `${f(r.start)} · All day` : `${f(r.start)} – ${f(last)} · All day`;
  }
  const s = new Date(o.start), e = new Date(o.end);
  const day = s.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  return sameDay(s, e) ? `${day} · ${fmtTime(s)} – ${fmtTime(e)}` : `${day} ${fmtTime(s)} – ${e.toLocaleDateString([], { month: "short", day: "numeric" })} ${fmtTime(e)}`;
}

export const COLORS = ["#4f46e5", "#0891b2", "#16a34a", "#ca8a04", "#ea580c", "#dc2626", "#db2777", "#7c3aed", "#475569"];
export const WEEKDAYS = [
  ["MO", "M"], ["TU", "T"], ["WE", "W"], ["TH", "T"], ["FR", "F"], ["SA", "S"], ["SU", "S"],
] as const;
export const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
