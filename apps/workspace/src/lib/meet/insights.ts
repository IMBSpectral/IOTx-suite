import type { Meeting } from "@prisma/client";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad } from "../http";
import { expand } from "../rrule";
import { createTask, loadProject } from "../tasks";
import { FILLERS, fillerCount, NON_INCLUSIVE } from "./report";
import { isReadAdmin, reportHref, reportOf, scored, visibleReports, whenOf, type Period, type Report } from "./read";

/**
 * Across-meeting views (helper B): For You (topics over time, what you
 * missed, action items and key questions), Coaching (speech numbers from
 * MeetSpeaker, never faces) and Meeting Policy (scores by day, time, size
 * and length).
 */

export function periodOf(q: URLSearchParams | Record<string, string | undefined>, now = new Date()): Period & { days: number } {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : q[k]) ?? undefined;
  const days = Math.max(1, Math.min(365, Number(get("days")) || 30));
  const to = get("to") ? new Date(get("to")!) : now;
  const from = get("from") ? new Date(get("from")!) : new Date(to.getTime() - days * 86_400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) bad("That period isn't valid.");
  return { from, to, days };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Is an action item's owner this person (by name, first name, email name or user id)? */
export function ownedBy(owner: string, me: { userId: string; name: string; email: string }) {
  const o = norm(owner);
  if (!o) return false;
  if (o === me.userId.toLowerCase()) return true;
  const name = norm(me.name);
  const first = name.split(" ")[0];
  const local = me.email.toLowerCase().split("@")[0];
  return o === name || o === first || o === local || o.split(/\s*(?:,|&|\band\b)\s*/).some((x) => x === name || x === first);
}

// ── For You ───────────────────────────────────────────────────────────────

export async function forYou(me: Me, p: Period) {
  const reps = await visibleReports(me, p);
  // Topics: the same topic name across meetings, oldest first, with the chapter that covered it.
  const topics = new Map<string, { name: string; meetings: { code: string; title: string; at: string; note: string; href: string }[] }>();
  for (const { m, r } of [...reps].reverse()) {
    for (const t of r.topics) {
      const k = norm(t);
      if (!k) continue;
      const e = topics.get(k) ?? { name: t, meetings: [] };
      const ch = r.chapters.find((c) => norm(c.title).includes(k) || k.includes(norm(c.title)) || norm(c.summary).includes(k));
      if (!e.meetings.some((x) => x.code === m.code))
        e.meetings.push({ code: m.code, title: m.title, at: whenOf(m).toISOString(), note: (ch?.summary || r.summary.split(/(?<=[.!?])\s/)[0] || "").slice(0, 240), href: reportHref(m.code, ch?.start ?? null) });
      topics.set(k, e);
    }
  }
  const topicList = [...topics.values()].sort((a, b) => b.meetings.length - a.meetings.length || b.meetings.at(-1)!.at.localeCompare(a.meetings.at(-1)!.at)).slice(0, 30);

  // Action items and key questions from every report in the period.
  const made = await db.readActionTask.findMany({ where: { meetingId: { in: reps.map((x) => x.m.id) } } });
  const madeTasks = await db.task.findMany({ where: { id: { in: made.map((t) => t.taskId) } }, select: { id: true, projectId: true } });
  const taskHref = (id: string | undefined) => {
    const t = madeTasks.find((x) => x.id === id);
    return t ? `/workspace/tasks?project=${t.projectId}&task=${t.id}` : null;
  };
  const actions = reps.flatMap(({ m, r }) =>
    r.actionItems.map((a, idx) => ({
      code: m.code, meeting: m.title, at: whenOf(m).toISOString(), idx, title: a.title, owner: a.owner, due: a.due,
      mine: ownedBy(a.owner, me), href: reportHref(m.code, a.start), taskHref: taskHref(made.find((t) => t.meetingId === m.id && t.idx === idx)?.taskId),
    })),
  );
  const questions = reps.flatMap(({ m, r }) =>
    r.keyQuestions.map((q) => ({ code: m.code, meeting: m.title, at: whenOf(m).toISOString(), question: q.question, askedBy: q.askedBy, answered: q.answered, mine: ownedBy(q.askedBy, me), href: reportHref(m.code, q.start) })),
  );
  return { topics: topicList, missed: await missed(me, p), actions, questions, reports: reps.length };
}

/** Meetings I was invited to (Meet invitees or the calendar event's guests) that ran without me, most engaging first. */
export async function missed(me: Me, p: Period) {
  const evIds = (await db.attendee.findMany({ where: { userId: me.userId, response: { not: "no" }, event: { ws: me.ws } }, select: { eventId: true } })).map((a) => a.eventId);
  const ms = await db.meeting.findMany({
    where: {
      ws: me.ws, startedAt: { not: null, gte: p.from, lt: p.to }, hostId: { not: me.userId },
      OR: [{ invitees: { has: me.userId } }, ...(evIds.length ? [{ eventId: { in: evIds } }] : [])],
    },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
  const out = [];
  for (const m of ms) {
    const was = await db.meetParticipant.findFirst({ where: { meetingId: m.id, userId: me.userId, status: "admitted" } });
    // A series reuses one meeting: being there on another day doesn't count for this day.
    const today = whenOf(m).toISOString().slice(0, 10);
    const days = await db.readAttendance.findMany({ where: { meetingId: m.id, userId: me.userId }, select: { day: true } });
    if (days.length ? days.some((d) => d.day === today) : !!was) continue;
    const r = reportOf(m);
    out.push({
      code: m.code, title: m.title, at: whenOf(m).toISOString(), topics: r?.topics.slice(0, 3) ?? [], summary: r?.summary.split(/(?<=[.!?])\s/)[0]?.slice(0, 240) ?? "",
      engagement: scored(r) ? r!.scores.engagement : null, href: reportHref(m.code), hasReport: !!r,
    });
  }
  return out.sort((a, b) => (b.engagement ?? -1) - (a.engagement ?? -1) || b.at.localeCompare(a.at));
}

/** One action item becomes a task, in a project I pick or my "Meeting follow-ups" project (assigned to me when it's mine). */
export async function actionToTask(me: Me, b: { code?: string; idx?: number; projectId?: string }) {
  if (!can(me, "tasks.open") || !can(me, "tasks.create")) throw new HttpError(403, "Your role can't create tasks.", { key: "tasks.create" });
  const { meetingByCode } = await import("./read");
  const m = await meetingByCode(me, String(b.code ?? ""));
  const r = reportOf(m);
  const idx = Number(b.idx);
  const a = r?.actionItems[idx];
  if (!a) bad("That action item isn't in the report.");
  const done = await db.readActionTask.findUnique({ where: { meetingId_idx: { meetingId: m.id, idx } } });
  if (done) return { taskId: done.taskId, existing: true, taskHref: `/workspace/tasks?task=${done.taskId}` };
  let projectId = b.projectId;
  if (!projectId) {
    const p = await db.project.findFirst({ where: { ws: me.ws, name: "Meeting follow-ups", archived: false, members: { some: { userId: me.userId } } } });
    if (p) projectId = p.id;
    else {
      if (!can(me, "tasks.project.create")) bad("Pick a project for the task.");
      projectId = (await db.project.create({ data: { ws: me.ws, name: "Meeting follow-ups", color: "#0284c7", createdBy: me.userId, members: { create: [{ userId: me.userId }] } } })).id;
    }
  }
  const project = await loadProject(me, projectId);
  const t = await createTask(me, {
    projectId: project.id,
    title: a.title,
    description: `From the meeting "${m.title}" (${whenOf(m).toISOString().slice(0, 10)})${a.owner ? `\nOwner named in the meeting: ${a.owner}` : ""}\nReport: ${reportHref(m.code, a.start)}`,
    assigneeId: ownedBy(a.owner, me) ? me.userId : null,
    due: a.due || null,
    labels: ["meeting"],
  });
  await db.readActionTask.create({ data: { meetingId: m.id, idx, taskId: t.id, userId: me.userId } });
  return { taskId: t.id, projectId: project.id, taskHref: `/workspace/tasks?project=${project.id}&task=${t.id}` };
}

// ── Coaching ──────────────────────────────────────────────────────────────

export const WPM_TARGET = { low: 130, high: 175 };
/** Which filler words and non-inclusive terms a line has (the same definitions the report uses). */
const fillersIn = (text: string) => FILLERS.filter((f) => (text.match(f.re) ?? []).length > 0).map((f) => f.name);
const nonInclusiveIn = (text: string) => NON_INCLUSIVE.filter((f) => (text.match(f.re) ?? []).length > 0).map((f) => `${f.term} (try ${f.instead})`);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Coaching for one person over a period, from MeetSpeaker rows (talk time,
 * words per minute, fillers, non-inclusive terms, questions, longest
 * monologue) and MeetSegment rows (moments outside the target, with links).
 * Admins may look at anyone; everyone else sees themselves.
 */
export async function coaching(me: Me, p: Period, userId?: string) {
  const who = userId && userId !== me.userId ? userId : me.userId;
  if (who !== me.userId && !isReadAdmin(me)) throw new HttpError(403, "Only admins can see someone else's coaching.");
  const u = await db.user.findUnique({ where: { id: who } });
  if (!u || !(await db.member.findUnique({ where: { ws_userId: { ws: me.ws, userId: who } } }))) throw new HttpError(404, "Not found");
  const rows = await db.meetSpeaker.findMany({ where: { userId: who, meeting: { ws: me.ws, OR: [{ startedAt: { gte: p.from, lt: p.to } }, { startedAt: null, createdAt: { gte: p.from, lt: p.to } }] } }, include: { meeting: true } });
  const all = rows.length ? await db.meetSpeaker.findMany({ where: { meetingId: { in: rows.map((r) => r.meetingId) } } }) : [];
  const meetings = rows
    .map((s) => {
      const total = all.filter((x) => x.meetingId === s.meetingId).reduce((a, x) => a + x.talkSec, 0);
      const mins = s.talkSec / 60;
      return {
        code: s.meeting.code, title: s.meeting.title, at: whenOf(s.meeting).toISOString(), href: reportHref(s.meeting.code),
        wpm: Math.round(s.wpm), words: s.words, talkSec: Math.round(s.talkSec), fillers: s.fillers, fillersPerMin: mins > 0 ? +(s.fillers / mins).toFixed(1) : 0,
        nonInclusive: s.nonInclusive, questions: s.questions, longestMonologueSec: Math.round(s.longestMonologueSec),
        talkRatio: total > 0 ? Math.round((s.talkSec / total) * 100) : 0, speakers: all.filter((x) => x.meetingId === s.meetingId).length,
        meetingId: s.meetingId, name: s.name,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));

  const range = (k: keyof (typeof meetings)[number]) => {
    const v = meetings.map((m) => Number(m[k])).filter((x) => Number.isFinite(x));
    if (!v.length) return null;
    return { min: Math.min(...v), max: Math.max(...v), avg: Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 10) / 10 };
  };
  // Moments: their own lines that ran too fast or slow, with fillers or non-inclusive words, or long monologues.
  const moments: { kind: "fast" | "slow" | "filler" | "noninclusive" | "monologue"; code: string; title: string; start: number; text: string; detail: string; href: string }[] = [];
  for (const m of meetings) {
    const segs = await db.meetSegment.findMany({
      where: { meetingId: m.meetingId, OR: [{ identity: { in: [who, `u_${who}`] } }, { speaker: { equals: m.name, mode: "insensitive" } }] },
      orderBy: { seq: "asc" },
    });
    let run: { start: number; end: number } | null = null;
    for (const s of segs) {
      const dur = s.end - s.start;
      const n = words(s.text);
      const push = (kind: (typeof moments)[number]["kind"], detail: string) => moments.push({ kind, code: m.code, title: m.title, start: s.start, text: s.text.slice(0, 200), detail, href: reportHref(m.code, s.start) });
      if (dur >= 8 && n >= 15) {
        const w = Math.round(n / (dur / 60));
        if (w > WPM_TARGET.high) push("fast", `${w} words a minute`);
        else if (w < WPM_TARGET.low - 30) push("slow", `${w} words a minute`);
      }
      if (fillerCount(s.text) >= 2) push("filler", fillersIn(s.text).map((x) => `"${x}"`).join(", "));
      const ni = nonInclusiveIn(s.text);
      if (ni.length) push("noninclusive", ni.join(", "));
      // Back-to-back lines of theirs (gaps under 2 s) make one stretch of talking.
      if (run && s.start - run.end < 2) run.end = s.end;
      else {
        if (run && run.end - run.start >= 150) moments.push({ kind: "monologue", code: m.code, title: m.title, start: run.start, text: "", detail: `${Math.round((run.end - run.start) / 60)} min without a break`, href: reportHref(m.code, run.start) });
        run = { start: s.start, end: s.end };
      }
    }
    if (run && run.end - run.start >= 150) moments.push({ kind: "monologue", code: m.code, title: m.title, start: run.start, text: "", detail: `${Math.round((run.end - run.start) / 60)} min without a break`, href: reportHref(m.code, run.start) });
  }
  const inTarget = meetings.filter((m) => m.wpm >= WPM_TARGET.low && m.wpm <= WPM_TARGET.high).length;
  return {
    person: { id: u.id, name: u.name ?? u.email },
    target: WPM_TARGET,
    summary: {
      meetings: meetings.length,
      wpm: range("wpm"), fillersPerMin: range("fillersPerMin"), nonInclusive: range("nonInclusive"), questions: range("questions"),
      talkRatio: range("talkRatio"), longestMonologueSec: range("longestMonologueSec"),
      paceInTarget: meetings.length ? Math.round((inTarget / meetings.length) * 100) : null,
    },
    meetings: meetings.map(({ meetingId: _a, name: _b, ...x }) => x),
    moments: moments.slice(0, 200),
  };
}

// ── Meeting Policy ────────────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PARTS = [
  { k: "early", label: "Before 9", from: 0, to: 9 },
  { k: "morning", label: "9–12", from: 9, to: 12 },
  { k: "midday", label: "12–14", from: 12, to: 14 },
  { k: "afternoon", label: "14–17", from: 14, to: 17 },
  { k: "evening", label: "After 17", from: 17, to: 24 },
];
const ON_TIME_SEC = 5 * 60;

/** Calendar start of the occurrence this meeting ran for (series: the nearest occurrence to when it started). */
async function calendarStart(m: Meeting) {
  if (!m.eventId || !m.startedAt) return null;
  const ev = await db.event.findUnique({ where: { id: m.eventId } });
  if (!ev || ev.allDay) return null;
  if (!ev.rrule) return ev.start;
  const occ = expand(ev, new Date(m.startedAt.getTime() - 12 * 3_600_000), new Date(m.startedAt.getTime() + 12 * 3_600_000));
  return occ.sort((a, b) => Math.abs(a.getTime() - m.startedAt!.getTime()) - Math.abs(b.getTime() - m.startedAt!.getTime()))[0] ?? null;
}

export function partsInZone(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(d);
  const wd = f.find((x) => x.type === "weekday")?.value ?? "Sun";
  return { dow: DAYS.indexOf(wd), hour: Number(f.find((x) => x.type === "hour")?.value ?? 0) % 24 };
}

/**
 * Read score, sentiment, engagement and on-time rate grouped by day of week,
 * time of day, size (1:1, 3–7, 8+) and length (≤30, 30–60, >60 min).
 * Personal: meetings I was in. Workspace: every meeting (admins only).
 * On time = Meet started within 5 minutes of the calendar start.
 */
export async function policy(me: Me, p: Period, scope: "me" | "workspace" = "me") {
  if (scope === "workspace" && !isReadAdmin(me)) throw new HttpError(403, "Only admins can see the whole workspace.");
  let ms: Meeting[];
  if (scope === "workspace") {
    ms = await db.meeting.findMany({ where: { ws: me.ws, startedAt: { not: null, gte: p.from, lt: p.to } } });
  } else {
    ms = await db.meeting.findMany({
      where: { ws: me.ws, startedAt: { not: null, gte: p.from, lt: p.to }, OR: [{ hostId: me.userId }, { participants: { some: { userId: me.userId, status: "admitted" } } }, { speakers: { some: { userId: me.userId } } }] },
    });
  }
  const rows: { dow: number; hour: number; size: number; minutes: number; r: Report | null; onTime: boolean | null }[] = [];
  for (const m of ms) {
    const r = reportOf(m);
    const [pc, sc] = await Promise.all([
      db.meetParticipant.count({ where: { meetingId: m.id, status: "admitted" } }),
      db.meetSpeaker.count({ where: { meetingId: m.id } }),
    ]);
    const size = Math.max(pc, sc, 1);
    const minutes = m.durationSec ? m.durationSec / 60 : m.endedAt && m.startedAt ? (m.endedAt.getTime() - m.startedAt.getTime()) / 60_000 : 0;
    const cs = await calendarStart(m);
    const onTime = cs ? (m.startedAt!.getTime() - cs.getTime()) / 1000 <= ON_TIME_SEC : null;
    rows.push({ ...partsInZone(m.startedAt!, me.tz || "UTC"), size, minutes, r: scored(r) ? r : null, onTime });
  }
  const group = (buckets: { k: string; label: string; test: (x: (typeof rows)[number]) => boolean }[]) =>
    buckets.map((b) => {
      const xs = rows.filter(b.test);
      const sc = xs.filter((x) => x.r);
      const avg = (f: (r: Report) => number) => (sc.length ? Math.round(sc.reduce((a, x) => a + f(x.r!), 0) / sc.length) : null);
      const timed = xs.filter((x) => x.onTime !== null);
      return {
        k: b.k, label: b.label, meetings: xs.length, scored: sc.length,
        read: avg((r) => r.scores.read), sentiment: avg((r) => r.scores.sentiment), engagement: avg((r) => r.scores.engagement),
        onTime: timed.length ? Math.round((timed.filter((x) => x.onTime).length / timed.length) * 100) : null, timed: timed.length,
      };
    });
  const overall = group([{ k: "all", label: "All", test: () => true }])[0];
  return {
    scope, meetings: rows.length, overall,
    day: group([1, 2, 3, 4, 5, 6, 0].map((d) => ({ k: String(d), label: DAYS[d], test: (x) => x.dow === d }))),
    time: group(PARTS.map((t) => ({ k: t.k, label: t.label, test: (x) => x.hour >= t.from && x.hour < t.to }))),
    size: group([
      { k: "1:1", label: "1:1", test: (x) => x.size <= 2 },
      { k: "3-7", label: "3–7", test: (x) => x.size >= 3 && x.size <= 7 },
      { k: "8+", label: "8+", test: (x) => x.size >= 8 },
    ]),
    duration: group([
      { k: "<=30", label: "≤30 min", test: (x) => x.minutes <= 30 },
      { k: "30-60", label: "30–60 min", test: (x) => x.minutes > 30 && x.minutes <= 60 },
      { k: ">60", label: ">60 min", test: (x) => x.minutes > 60 },
    ]),
  };
}
