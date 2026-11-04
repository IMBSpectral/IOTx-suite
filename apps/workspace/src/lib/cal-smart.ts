import { db } from "./db";
import type { Me } from "./auth";
import { busy, occurrences, people, type Occurrence } from "./calendar";
import { partsIn, ymd, zonedToUtc, pad, dateOnly } from "./time";

/**
 * Calendar intelligence that needs no AI and never guesses: working hours,
 * free-time search across people (their own events, accepted invites and
 * Google-synced events all count as busy), the daily brief, and conflict /
 * overload detection with suggested fixes. The AI layer (cal-ai.ts) uses these
 * as tools; every change it proposes is a draft the person confirms.
 */

export type WorkHours = { start: string; end: string; days: number[]; lunchStart: string; lunchEnd: string; buffer: number };
export const DEFAULT_HOURS: WorkHours = { start: "09:30", end: "18:30", days: [1, 2, 3, 4, 5, 6], lunchStart: "13:00", lunchEnd: "14:00", buffer: 10 };

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const toMin = (hm: string) => {
  const m = HM.exec(hm);
  return m ? +m[1] * 60 + +m[2] : 0;
};
export const fromMin = (n: number) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

export function cleanHours(v: unknown): WorkHours {
  const o = (v && typeof v === "object" ? v : {}) as Partial<WorkHours>;
  const hm = (x: unknown, d: string) => (typeof x === "string" && HM.test(x) ? x : d);
  const h: WorkHours = {
    start: hm(o.start, DEFAULT_HOURS.start),
    end: hm(o.end, DEFAULT_HOURS.end),
    days: Array.isArray(o.days) ? [...new Set(o.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : DEFAULT_HOURS.days,
    lunchStart: hm(o.lunchStart, DEFAULT_HOURS.lunchStart),
    lunchEnd: hm(o.lunchEnd, DEFAULT_HOURS.lunchEnd),
    buffer: Math.max(0, Math.min(60, Math.round(Number(o.buffer ?? DEFAULT_HOURS.buffer)) || 0)),
  };
  if (toMin(h.end) <= toMin(h.start)) h.end = DEFAULT_HOURS.end;
  if (toMin(h.lunchEnd) < toMin(h.lunchStart)) h.lunchEnd = h.lunchStart;
  if (!h.days.length) h.days = DEFAULT_HOURS.days;
  return h;
}

export async function hoursOf(userIds: string[]) {
  const us = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, tz: true, workHours: true, name: true, email: true } });
  return new Map(us.map((u) => [u.id, { tz: u.tz || "UTC", hours: cleanHours(u.workHours), name: u.name ?? u.email }]));
}

// ── Local-day helpers ─────────────────────────────────────────────────────

/** "2026-10-27" in a zone -> [start, end) instants of that local day. */
export function dayWindow(date: string, tz: string) {
  const [y, m, d] = date.split("-").map(Number);
  const start = zonedToUtc(y, m, d, 0, 0, tz);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  const end = zonedToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0, tz);
  return { start, end };
}
export const at = (date: string, hm: string, tz: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const mi = toMin(hm);
  return zonedToUtc(y, m, d, Math.floor(mi / 60), mi % 60, tz);
};
export const localDate = (t: Date | number | string, tz: string) => ymd(partsIn(new Date(t), tz));
export const localHM = (t: Date | number | string, tz: string) => {
  const p = partsIn(new Date(t), tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
};
export function addDaysStr(date: string, n: number) {
  const d = dateOnly(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const weekdayOf = (date: string) => dateOnly(date).getUTCDay();
export const fmtWhen = (t: Date | string, tz: string) =>
  new Date(t).toLocaleString("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const fmtTime = (t: Date | string, tz: string) => new Date(t).toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" });

type Block = { start: number; end: number };
const overlaps = (a: Block, b: Block) => a.start < b.end && b.start < a.end;

// ── People in the directory ───────────────────────────────────────────────

export type Person = { id: string; name: string; email: string };
export type Match = { matched: Person[]; external: { email: string }[]; unmatched: string[]; ambiguous: { mention: string; options: Person[] }[] };

/**
 * Names and emails the person typed -> workspace people. Never invents anyone:
 * a name with no match is reported as unmatched, two or more matches as ambiguous.
 */
export function matchPeople(mentions: string[], directory: Person[], meId: string): Match {
  const out: Match = { matched: [], external: [], unmatched: [], ambiguous: [] };
  const add = (p: Person) => !out.matched.some((x) => x.id === p.id) && p.id !== meId && out.matched.push(p);
  for (const raw of mentions.slice(0, 20)) {
    const m = raw.trim().replace(/^@/, "");
    const low = m.toLowerCase();
    if (!m || ["me", "i", "myself", "us", "we"].includes(low)) continue;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) {
      const p = directory.find((x) => x.email.toLowerCase() === low);
      if (p) add(p);
      else if (!out.external.some((x) => x.email === low)) out.external.push({ email: low });
      continue;
    }
    const words = low.split(/\s+/);
    const exact = directory.filter((p) => p.name.toLowerCase() === low);
    const byWords = directory.filter((p) => {
      const n = p.name.toLowerCase().split(/\s+/);
      const local = p.email.toLowerCase().split("@")[0];
      return words.every((w) => n.some((x) => x === w || (w.length >= 3 && x.startsWith(w)))) || local === low || local.split(/[._-]/).includes(low);
    });
    const hits = exact.length ? exact : byWords;
    if (hits.length === 1) add(hits[0]);
    else if (hits.length > 1) out.ambiguous.push({ mention: m, options: hits.slice(0, 5) });
    else out.unmatched.push(m);
  }
  return out;
}

export async function directory(me: Me): Promise<Person[]> {
  return (await people(me.ws)).map((p) => ({ id: p.id, name: p.name, email: p.email }));
}

// ── Free time ─────────────────────────────────────────────────────────────

export type Slot = { start: string; end: string; score: number; reason: string };

/**
 * The best slots of `minutes` for everyone in `userIds` (me included) between
 * two local dates (inclusive), inside everyone's working hours, never over
 * lunch, never over a busy block; softly away from back-to-back meetings,
 * preferring mid-morning / mid-afternoon, earlier days and lighter days.
 */
export async function findSlots(me: Me, userIds: string[], fromDate: string, toDate: string, minutes: number, opts: { limit?: number; earliest?: Date; dayPart?: "morning" | "afternoon" | null } = {}) {
  const ids = [...new Set([me.userId, ...userIds])].slice(0, 12);
  const tz = me.tz || "UTC";
  const from = dayWindow(fromDate, tz).start;
  const to = dayWindow(toDate, tz).end;
  const [b, hrs] = await Promise.all([busy(me, ids, new Date(from.getTime() - 86_400_000), new Date(to.getTime() + 86_400_000)), hoursOf(ids)]);
  const blocks = new Map(ids.map((id) => [id, (b[id] ?? []).map((x) => ({ start: Date.parse(x.start), end: Date.parse(x.end) }))]));
  const dur = Math.max(15, Math.min(8 * 60, minutes)) * 60_000;
  const earliest = Math.max(opts.earliest?.getTime() ?? 0, Date.now() + 15 * 60_000);
  const cands: (Slot & { day: string; t: number })[] = [];
  const days = Math.min(31, Math.round((dateOnly(toDate).getTime() - dateOnly(fromDate).getTime()) / 86_400_000) + 1);
  for (let i = 0; i < days; i++) {
    const day = addDaysStr(fromDate, i);
    const mine = hrs.get(me.userId)?.hours ?? DEFAULT_HOURS;
    if (!mine.days.includes(weekdayOf(day))) continue;
    for (let mm = toMin(mine.start); mm + minutes <= toMin(mine.end); mm += 15) {
      const s = at(day, fromMin(mm), tz).getTime();
      const e = s + dur;
      if (s < earliest) continue;
      if (opts.dayPart === "morning" && mm >= 12 * 60) continue;
      if (opts.dayPart === "afternoon" && mm < 12 * 60) continue;
      let ok = true;
      let tight = 0;
      let dayLoad = 0;
      for (const id of ids) {
        const h = hrs.get(id) ?? { tz, hours: DEFAULT_HOURS, name: "" };
        const ld = localDate(s, h.tz);
        if (!h.hours.days.includes(weekdayOf(ld))) { ok = false; break; }
        const ws = at(ld, h.hours.start, h.tz).getTime(), we = at(ld, h.hours.end, h.tz).getTime();
        if (s < ws || e > we) { ok = false; break; }
        const lunch = { start: at(ld, h.hours.lunchStart, h.tz).getTime(), end: at(ld, h.hours.lunchEnd, h.tz).getTime() };
        if (lunch.end > lunch.start && overlaps({ start: s, end: e }, lunch)) { ok = false; break; }
        const bl = blocks.get(id) ?? [];
        if (bl.some((x) => overlaps({ start: s, end: e }, x))) { ok = false; break; }
        const buf = h.hours.buffer * 60_000;
        if (bl.some((x) => overlaps({ start: s - buf, end: e + buf }, x))) tight++;
        dayLoad = Math.max(dayLoad, bl.filter((x) => x.start >= ws && x.end <= we).reduce((a, x) => a + (x.end - x.start), 0) / 3_600_000);
      }
      if (!ok) continue;
      let score = 100 - i * 4 - tight * 18 - Math.max(0, dayLoad - 3) * 6;
      const sweet = (mm >= 600 && mm <= 690) || (mm >= 870 && mm <= 960);
      if (sweet) score += 10;
      if (mm % 60 === 0) score += 3;
      else if (mm % 30 === 0) score += 1;
      const parts: string[] = [ids.length > 1 ? (ids.length === 2 ? "You're both free" : `All ${ids.length} of you are free`) : "You're free"];
      if (!tight) parts.push("no back-to-back meetings");
      else parts.push("close to another meeting");
      if (sweet) parts.push(mm < 720 ? "mid-morning" : "mid-afternoon");
      if (dayLoad < 2) parts.push("light day");
      else if (dayLoad > 4) parts.push(`busy day (${Math.round(dayLoad)}h of meetings)`);
      cands.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), score: Math.round(score), reason: parts.join(" · "), day, t: s });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.t - b.t);
  const limit = opts.limit ?? 3;
  const pick: typeof cands = [];
  // Spread the picks over different days first, then fill.
  for (const c of cands) if (pick.length < limit && !pick.some((p) => p.day === c.day)) pick.push(c);
  for (const c of cands) if (pick.length < limit && !pick.includes(c) && !pick.some((p) => Math.abs(p.t - c.t) < dur)) pick.push(c);
  return pick.sort((a, b) => a.t - b.t).map(({ start, end, score, reason }) => ({ start, end, score, reason }));
}

/** Free windows in my working day (minus lunch and busy time), from `after`. */
export function freeWindows(date: string, tz: string, hours: WorkHours, events: Block[], after = 0) {
  if (!hours.days.includes(weekdayOf(date))) return [] as Block[];
  let free: Block[] = [{ start: Math.max(at(date, hours.start, tz).getTime(), after), end: at(date, hours.end, tz).getTime() }];
  const cut = (b: Block) => {
    const next: Block[] = [];
    for (const f of free) {
      if (!overlaps(f, b)) next.push(f);
      else {
        if (b.start > f.start) next.push({ start: f.start, end: b.start });
        if (b.end < f.end) next.push({ start: b.end, end: f.end });
      }
    }
    free = next;
  };
  cut({ start: at(date, hours.lunchStart, tz).getTime(), end: at(date, hours.lunchEnd, tz).getTime() });
  for (const e of events) cut(e);
  return free.filter((f) => f.end - f.start >= 15 * 60_000);
}

// ── Daily brief, conflicts and overload ───────────────────────────────────

export type Issue = {
  kind: "conflict" | "outside" | "backtoback" | "overload";
  date: string;
  title: string;
  detail: string;
  eventIds: string[];
  fix?: { label: string; eventId: string; occ: string | null; isSeries: boolean; start: string; end: string };
};

const timed = (o: Occurrence) => !o.allDay && o.myResponse !== "no";

/** Problems in [fromDate, toDate] for me: overlaps, outside working hours, long back-to-back runs, overloaded days. */
export async function issues(me: Me, fromDate: string, toDate: string, evs?: Occurrence[]): Promise<Issue[]> {
  const tz = me.tz || "UTC";
  const hours = (await hoursOf([me.userId])).get(me.userId)?.hours ?? DEFAULT_HOURS;
  const all = (evs ?? (await occurrences(me, dayWindow(fromDate, tz).start, dayWindow(toDate, tz).end))).filter(timed);
  const out: Issue[] = [];
  const days = Math.min(31, Math.round((dateOnly(toDate).getTime() - dateOnly(fromDate).getTime()) / 86_400_000) + 1);
  for (let i = 0; i < days; i++) {
    const day = addDaysStr(fromDate, i);
    const w = dayWindow(day, tz);
    const list = all.filter((o) => Date.parse(o.start) < w.end.getTime() && Date.parse(o.end) > w.start.getTime()).sort((a, b) => a.start.localeCompare(b.start));
    if (!list.length) continue;
    const blocks = list.map((o) => ({ start: Date.parse(o.start), end: Date.parse(o.end) }));
    // Overlaps (double-bookings)
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++)
        if (overlaps(blocks[a], blocks[b])) {
          const move = list[b].canEdit ? list[b] : list[a].canEdit ? list[a] : null;
          out.push({
            kind: "conflict",
            date: day,
            title: `${list[a].title} overlaps ${list[b].title}`,
            detail: `${fmtTime(list[a].start, tz)}–${fmtTime(list[a].end, tz)} and ${fmtTime(list[b].start, tz)}–${fmtTime(list[b].end, tz)}`,
            eventIds: [list[a].id, list[b].id],
            ...(move ? { fix: await fixFor(me, move, day, hours) } : {}),
          });
        }
    // Outside working hours / on a day off
    const workDay = hours.days.includes(weekdayOf(day));
    const ws = at(day, hours.start, tz).getTime(), we = at(day, hours.end, tz).getTime();
    for (let k = 0; k < list.length; k++) {
      const bl = blocks[k];
      if (!workDay || bl.start < ws || bl.end > we) {
        const o = list[k];
        out.push({
          kind: "outside",
          date: day,
          title: `${o.title} is outside your working hours`,
          detail: workDay ? `${fmtTime(o.start, tz)}–${fmtTime(o.end, tz)} · your day is ${hours.start}–${hours.end}` : `${new Date(o.start).toLocaleDateString("en-IN", { timeZone: tz, weekday: "long" })} is a day off`,
          eventIds: [o.id],
          ...(o.canEdit ? { fix: await fixFor(me, o, day, hours) } : {}),
        });
      }
    }
    // Back-to-back runs of 3+ meetings with less than the buffer between them
    let run = [0];
    const flush = () => {
      if (run.length >= 3) {
        const first = list[run[0]], last = list[run[run.length - 1]];
        out.push({ kind: "backtoback", date: day, title: `${run.length} meetings back to back`, detail: `${fmtTime(first.start, tz)}–${fmtTime(last.end, tz)} with no break`, eventIds: run.map((x) => list[x].id) });
      }
    };
    for (let k = 1; k < list.length; k++) {
      if (blocks[k].start - blocks[k - 1].end <= hours.buffer * 60_000) run.push(k);
      else {
        flush();
        run = [k];
      }
    }
    flush();
    // Overload: more than 5 hours of meetings
    const merged = mergeBlocks(blocks);
    const hoursIn = merged.reduce((a, x) => a + (Math.min(x.end, w.end.getTime()) - Math.max(x.start, w.start.getTime())), 0) / 3_600_000;
    if (hoursIn > 5) out.push({ kind: "overload", date: day, title: `${Math.round(hoursIn * 10) / 10}h of meetings`, detail: "Little time left for real work. Consider declining or shortening something.", eventIds: list.map((o) => o.id) });
  }
  return out;
}

function mergeBlocks(bs: Block[]) {
  const s = [...bs].sort((a, b) => a.start - b.start);
  const out: Block[] = [];
  for (const b of s) {
    const l = out[out.length - 1];
    if (l && b.start <= l.end) l.end = Math.max(l.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

/** A free slot for an event (same day, else the next 3 days) with its attendees: the suggested fix. */
async function fixFor(me: Me, o: Occurrence, day: string, _hours: WorkHours) {
  const minutes = Math.round((Date.parse(o.end) - Date.parse(o.start)) / 60_000);
  const ids = o.attendees.filter((a) => a.userId && a.response !== "no").map((a) => a.userId!) as string[];
  const tryDays = [day, addDaysStr(day, 1), addDaysStr(day, 2), addDaysStr(day, 3)];
  for (const d of tryDays) {
    const [s] = await findSlots(me, ids, d, d, minutes, { limit: 1 });
    if (s) return { label: `Move to ${fmtWhen(s.start, me.tz || "UTC")}`, eventId: o.id, occ: o.occ, isSeries: !!o.rrule, start: s.start, end: s.end };
  }
  return undefined;
}

export async function brief(me: Me, date: string) {
  const tz = me.tz || "UTC";
  const w = dayWindow(date, tz);
  const hours = (await hoursOf([me.userId])).get(me.userId)?.hours ?? DEFAULT_HOURS;
  const all = await occurrences(me, w.start, w.end);
  const events = all.filter((o) => o.myResponse !== "no");
  const t = events.filter((o) => !o.allDay);
  const now = Date.now();
  const isToday = localDate(now, tz) === date;
  const free = freeWindows(date, tz, hours, t.map((o) => ({ start: Date.parse(o.start), end: Date.parse(o.end) })), isToday ? now : 0);
  const gaps = free.filter((f) => f.end - f.start >= 30 * 60_000).map((f) => ({ start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString(), minutes: Math.round((f.end - f.start) / 60_000) }));
  const focus = gaps.filter((g) => g.minutes >= 90).slice(0, 2);
  const meetingMinutes = mergeBlocks(t.map((o) => ({ start: Math.max(Date.parse(o.start), w.start.getTime()), end: Math.min(Date.parse(o.end), w.end.getTime()) }))).reduce((a, x) => a + (x.end - x.start) / 60_000, 0);
  const dayStart = dateOnly(date);
  const tasks = me.perms["tasks.open"]
    ? await db.task.findMany({
        where: { ws: me.ws, assigneeId: me.userId, completedAt: null, due: { lte: dayStart }, project: { archived: false, members: { some: { userId: me.userId } } } },
        include: { project: { select: { name: true, color: true } } },
        orderBy: [{ due: "asc" }, { priority: "desc" }],
        take: 20,
      })
    : [];
  const openTasks = me.perms["tasks.open"]
    ? await db.task.findMany({ where: { ws: me.ws, completedAt: null, project: { archived: false, members: { some: { userId: me.userId } } } }, select: { id: true, title: true, assigneeId: true, due: true }, take: 400 })
    : [];
  const dir = await directory(me);
  const prep = t.map((o) => {
    const notes: string[] = [];
    const others = o.attendees.filter((a) => a.userId !== me.userId);
    const waiting = others.filter((a) => a.response === "needs");
    const declined = others.filter((a) => a.response === "no");
    if (others.length) notes.push(`${others.length} ${others.length === 1 ? "guest" : "guests"}${waiting.length ? `, ${waiting.length} not replied` : ""}${declined.length ? `, ${declined.length} declined` : ""}`);
    if (!o.description.trim()) notes.push("No agenda yet");
    if (o.conferenceUrl) notes.push("Video link ready");
    else if (!o.location && others.length) notes.push("No place or video link");
    const rel = relatedTasks(o.title, others.map((a) => a.userId).filter(Boolean) as string[], openTasks, Date.parse(o.start));
    if (rel.length) notes.push(`${rel.length} related ${rel.length === 1 ? "task" : "tasks"}`);
    return { id: o.id, occ: o.occ, notes };
  });
  void dir;
  return {
    date,
    tz,
    hours,
    events: events.map((o) => ({ id: o.id, occ: o.occ, title: o.title, start: o.start, end: o.end, allDay: o.allDay, color: o.color, conferenceUrl: o.conferenceUrl, location: o.location, myResponse: o.myResponse, attendees: o.attendees.length, rrule: !!o.rrule, canEdit: o.canEdit })),
    meetingMinutes: Math.round(meetingMinutes),
    gaps,
    focus,
    issues: await issues(me, date, date, all),
    tasks: tasks.map((x) => ({ id: x.id, title: x.title, projectId: x.projectId, project: x.project.name, due: x.due!.toISOString().slice(0, 10), overdue: x.due! < dayStart, priority: x.priority })),
    prep,
  };
}

const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "meeting", "call", "sync", "weekly", "daily", "team", "about", "review", "catch", "chat"]);
export const keywords = (s: string) => [...new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !STOP.has(w)))];

/** Open tasks that share a word with the meeting, or belong to a guest and are due within a week of it. */
export function relatedTasks<T extends { id: string; title: string; assigneeId: string | null; due: Date | null }>(title: string, guestIds: string[], tasks: T[], when: number) {
  const kw = keywords(title);
  // Tasks about the meeting's subject come first (most shared words), then guests' tasks due near it.
  const scored = tasks.map((t) => {
    const tw = keywords(t.title);
    const hits = kw.filter((k) => tw.includes(k)).length;
    const near = !!t.assigneeId && guestIds.includes(t.assigneeId) && !!t.due && Math.abs(t.due.getTime() - when) < 7 * 86_400_000;
    return { t, hits, near };
  });
  return scored.filter((s) => s.hits || s.near).sort((a, b) => b.hits - a.hits).map((s) => s.t);
}
