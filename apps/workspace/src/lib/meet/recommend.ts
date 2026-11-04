import type { Event } from "@prisma/client";
import { db } from "../db";
import { HttpError, type Me } from "../auth";
import { bad } from "../http";
import { expand } from "../rrule";
import { notify } from "../notify";
import { reportOf, scored } from "./read";

/**
 * Recommendations (helper B): recurring series a person often skips, or that
 * score low, get "decline" / "make it shorter" / "less often" suggestions
 * with the reason. Nothing changes until they click Accept; then the existing
 * Calendar functions do it (decline the series, reply to the organiser, or
 * change the series, which sends the usual invite update).
 *
 * Flexible meetings (Smart Scheduler): an organiser marks an event Flexible.
 * When it clashes with something, or with someone's focus time or working
 * hours, a better slot the same day is proposed. It moves by itself only when
 * every guest is in the workspace, the new time is the same day, inside
 * everyone's working hours, at least 2 hours away, and at most once a day;
 * otherwise the organiser gets a suggestion to accept.
 */

const WEEKS = 8;
const MIN_PAST = 3;
const SKIP_RATE = 0.5;
const LOW_SCORE = 50;
const DAY = 86_400_000;

/** A Me for background work (as the organiser), with the latest permission decisions we have. */
export async function meFor(userId: string, ws: string): Promise<Me | null> {
  const u = await db.user.findUnique({ where: { id: userId } });
  if (!u) return null;
  const s = await db.session.findFirst({ where: { userId, ws, guest: false }, orderBy: { permsAt: "desc" } });
  return { sid: s?.id ?? "", userId, ws, name: u.name ?? u.email, email: u.email, tz: u.tz || "UTC", owner: !!s?.owner, perms: (s?.perms as Record<string, boolean>) ?? {}, stale: false, guest: false };
}

type Rec = { eventId: string; kind: string; title: string; reason: string; details: Record<string, unknown>; key: string };

const minutesOf = (ev: Event) => Math.round((ev.end.getTime() - ev.start.getTime()) / 60_000);
function lessOften(rrule: string) {
  const parts = Object.fromEntries(rrule.split(";").map((p) => p.split("=") as [string, string]));
  if (parts.FREQ === "DAILY") return "FREQ=WEEKLY";
  if (parts.FREQ === "WEEKLY") {
    const n = Number(parts.INTERVAL ?? 1);
    return rrule.split(";").filter((p) => !p.startsWith("INTERVAL=")).concat(`INTERVAL=${n * 2}`).join(";");
  }
  return null;
}

/** Look at my recurring series and write new suggestions (never re-offering one I already reviewed). */
export async function refreshRecommendations(me: Me, now = new Date()) {
  const from = new Date(now.getTime() - WEEKS * 7 * DAY);
  const series = await db.event.findMany({
    where: { ws: me.ws, deletedAt: null, rrule: { not: null }, allDay: false, OR: [{ creatorId: me.userId }, { attendees: { some: { userId: me.userId, response: { not: "no" } } } }] },
    include: { attendees: true },
  });
  const recs: Rec[] = [];
  for (const ev of series) {
    const occ = expand(ev, from, now).filter((d) => d.getTime() < now.getTime() - 60 * 60_000);
    const meeting = await db.meeting.findFirst({ where: { ws: me.ws, eventId: ev.id }, orderBy: { createdAt: "desc" } });
    const organiser = ev.creatorId === me.userId;
    // Which days the series' meeting actually ran, and which of them I was in.
    let ran: string[] = [];
    let mine: string[] = [];
    if (meeting) {
      const rows = await db.readAttendance.findMany({ where: { meetingId: meeting.id, day: { gte: from.toISOString().slice(0, 10) } } });
      ran = [...new Set(rows.map((r) => r.day))];
      mine = [...new Set(rows.filter((r) => r.userId === me.userId).map((r) => r.day))];
    }
    const pastDays = occ.map((d) => d.toISOString().slice(0, 10)).filter((d) => ran.includes(d));
    const skipped = pastDays.filter((d) => !mine.includes(d)).length;
    const r = meeting ? reportOf(meeting) : null;
    const score = scored(r) ? r!.scores.read : null;
    const mins = minutesOf(ev);
    if (!organiser && pastDays.length >= MIN_PAST && skipped / pastDays.length >= SKIP_RATE) {
      recs.push({
        eventId: ev.id, kind: "decline", title: `Decline "${ev.title}"`,
        reason: `You frequently skip this meeting: you missed ${skipped} of the last ${pastDays.length} times it ran.`,
        details: { skipped, of: pastDays.length, rrule: ev.rrule }, key: `decline:${ev.id}`,
      });
    }
    if (score !== null && score < LOW_SCORE) {
      if (organiser) {
        if (mins >= 45) recs.push({ eventId: ev.id, kind: "shorter", title: `Make "${ev.title}" shorter`, reason: `Its Read score is ${score} (under ${LOW_SCORE}). Try ${mins - 15 >= 30 ? mins - 15 : 30} minutes instead of ${mins}.`, details: { minutes: mins - 15 >= 30 ? mins - 15 : 30, was: mins, score }, key: `shorter:${ev.id}` });
        const next = lessOften(ev.rrule!);
        if (next) recs.push({ eventId: ev.id, kind: "less_often", title: `Hold "${ev.title}" less often`, reason: `Its Read score is ${score} (under ${LOW_SCORE}) and it repeats ${/DAILY/.test(ev.rrule!) ? "every day" : "every week or more"}. Meeting half as often frees time.`, details: { rrule: next, was: ev.rrule, score }, key: `less:${ev.id}` });
      } else {
        recs.push({ eventId: ev.id, kind: "suggest", title: `Suggest a shorter "${ev.title}"`, reason: `Its Read score is ${score} (under ${LOW_SCORE}). Accept sends the organiser a note suggesting it be shorter or less often.`, details: { score }, key: `suggest:${ev.id}` });
      }
    }
  }
  let made = 0;
  for (const r of recs) {
    const old = await db.meetRecommendation.findUnique({ where: { userId_key: { userId: me.userId, key: r.key } } });
    if (old) continue;
    await db.meetRecommendation.create({ data: { ws: me.ws, userId: me.userId, eventId: r.eventId, kind: r.kind, title: r.title, reason: r.reason, details: r.details as never, key: r.key } });
    made++;
  }
  return made;
}

const lastRefresh = new Map<string, number>();
export async function listRecommendations(me: Me, tab: "new" | "reviewed" = "new", force = false) {
  const k = `${me.ws}:${me.userId}`;
  if (force || Date.now() - (lastRefresh.get(k) ?? 0) > 10 * 60_000) {
    lastRefresh.set(k, Date.now());
    await refreshRecommendations(me);
  }
  const rows = await db.meetRecommendation.findMany({
    where: { ws: me.ws, userId: me.userId, status: tab === "new" ? "new" : { not: "new" } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const evs = await db.event.findMany({ where: { id: { in: rows.map((r) => r.eventId) } }, select: { id: true, title: true, start: true, end: true, rrule: true, deletedAt: true } });
  return rows.map((r) => {
    const ev = evs.find((e) => e.id === r.eventId);
    return { id: r.id, kind: r.kind, title: r.title, reason: r.reason, details: r.details, status: r.status, result: r.result, createdAt: r.createdAt, reviewedAt: r.reviewedAt, event: ev && !ev.deletedAt ? { id: ev.id, title: ev.title, start: ev.start, end: ev.end, rrule: ev.rrule } : null };
  });
}

/** Accept (do it through Calendar) or ignore (hide it). Only ever after the person's click. */
export async function reviewRecommendation(me: Me, id: string, action: "accept" | "ignore") {
  const r = await db.meetRecommendation.findUnique({ where: { id } });
  if (!r || r.userId !== me.userId || r.ws !== me.ws) throw new HttpError(404, "Not found");
  if (r.status !== "new") bad("This suggestion was already reviewed.");
  if (action === "ignore") {
    await db.meetRecommendation.update({ where: { id }, data: { status: "ignored", reviewedAt: new Date() } });
    return { status: "ignored" };
  }
  if (!me.perms["calendar.open"]) throw new HttpError(403, "Your role can't change calendar events.", { key: "calendar.open" });
  const cal = await import("../calendar");
  const d = (r.details ?? {}) as Record<string, unknown>;
  let result = "";
  try {
    if (r.kind === "decline") {
      await cal.respond(me, r.eventId, "no", { comment: "Declined the series (Meet recommendation)." });
      result = "You declined the series.";
    } else if (r.kind === "suggest") {
      const ev = await cal.loadEvent(me, r.eventId);
      const mine = ev.attendees.find((a) => a.userId === me.userId);
      await cal.respond(me, r.eventId, mine?.response && mine.response !== "needs" ? mine.response : "yes", { comment: "Suggestion: could this meeting be shorter or less often? Its recent Read scores were low." });
      result = "Your note went to the organiser.";
    } else if (r.kind === "shorter") {
      const ev = await cal.loadEvent(me, r.eventId);
      const minutes = Number(d.minutes) || 30;
      await cal.updateEvent(me, r.eventId, { start: ev.start.toISOString(), end: new Date(ev.start.getTime() + minutes * 60_000).toISOString() }, "all");
      result = `The series is now ${minutes} minutes; guests were sent the update.`;
    } else if (r.kind === "less_often") {
      await cal.updateEvent(me, r.eventId, { rrule: String(d.rrule) }, "all");
      result = "The series repeats less often now; guests were sent the update.";
    } else if (r.kind === "move") {
      const to = d.to as { start: string; end: string };
      await cal.updateEvent(me, r.eventId, { start: to.start, end: to.end }, "all");
      await db.meetFlexible.updateMany({ where: { eventId: r.eventId }, data: { movedAt: new Date() } });
      result = "Moved; guests were sent the update.";
    } else bad("Unknown suggestion.");
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "The change couldn't be made.";
    await db.meetRecommendation.update({ where: { id }, data: { status: "failed", result: msg, reviewedAt: new Date() } });
    throw e instanceof HttpError ? e : new HttpError(500, msg);
  }
  await db.meetRecommendation.update({ where: { id }, data: { status: "accepted", result, reviewedAt: new Date() } });
  return { status: "accepted", result };
}

// ── Flexible meetings ─────────────────────────────────────────────────────

export async function flexibleOf(me: Me, eventId: string) {
  const { loadEvent } = await import("../calendar");
  const ev = await loadEvent(me, eventId);
  const f = await db.meetFlexible.findUnique({ where: { eventId } });
  return { eventId, on: !!f?.on, canSet: ev.creatorId === me.userId && !ev.googleOrganizer && !ev.allDay && !ev.rrule, repeats: !!ev.rrule, movedAt: f?.movedAt ?? null };
}

export async function setFlexible(me: Me, eventId: string, on: boolean) {
  const { loadEvent } = await import("../calendar");
  const ev = await loadEvent(me, eventId);
  if (ev.creatorId !== me.userId || ev.googleOrganizer) throw new HttpError(403, "Only the organiser can make a meeting flexible.");
  if (ev.allDay || ev.rrule) bad("Only single, timed meetings can be flexible for now.");
  await db.meetFlexible.upsert({ where: { eventId }, create: { eventId, ws: me.ws, userId: me.userId, on }, update: { on } });
  return { eventId, on };
}

type Block = { start: number; end: number };
const overlaps = (a: Block, b: Block) => a.start < b.end && b.start < a.end;

/** Why this event should move (a clash, someone's focus time, outside working hours), or null. */
async function problemWith(org: Me, ev: Event & { attendees: { userId: string | null; response: string; name: string; email: string }[] }) {
  const { busy } = await import("../calendar");
  const { hoursOf, at, localDate } = await import("../cal-smart");
  const ids = [...new Set([ev.creatorId, ...ev.attendees.filter((a) => a.userId && a.response !== "no").map((a) => a.userId!)])];
  const b = await busy(org, ids, new Date(ev.start.getTime() - DAY), new Date(ev.end.getTime() + DAY));
  const self: Block = { start: ev.start.getTime(), end: ev.end.getTime() };
  const hrs = await hoursOf(ids);
  for (const id of ids) {
    const name = hrs.get(id)?.name ?? "Someone";
    // Their other busy time (not this event itself).
    const all = (b[id] ?? []).map((x) => ({ start: Date.parse(x.start), end: Date.parse(x.end), kind: x.kind }));
    const same = all.filter((x) => x.start === self.start && x.end === self.end && !x.kind);
    const others = [...all.filter((x) => !(x.start === self.start && x.end === self.end && !x.kind)), ...same.slice(1)];
    const clash = others.find((x) => overlaps(x, self));
    if (clash) return clash.kind === "focusTime" ? `It falls in ${id === org.userId ? "your" : `${name}'s`} focus time.` : `${id === org.userId ? "You have" : `${name} has`} another meeting at the same time.`;
    const h = hrs.get(id);
    if (h) {
      const d = localDate(ev.start, h.tz);
      if (ev.start.getTime() < at(d, h.hours.start, h.tz).getTime() || ev.end.getTime() > at(d, h.hours.end, h.tz).getTime()) return `It is outside ${id === org.userId ? "your" : `${name}'s`} working hours.`;
    }
  }
  return null;
}

/**
 * Check every flexible event in the next few days. Returns what happened
 * (moved / proposed) for tests and logs. Conservative by design: same day
 * only, never within 2 hours of the start, one automatic move a day.
 */
export async function flexTick(now = new Date()) {
  const flex = await db.meetFlexible.findMany({ where: { on: true } });
  const out: { eventId: string; action: "moved" | "proposed"; reason: string; to: { start: string; end: string } }[] = [];
  for (const f of flex) {
    const ev = await db.event.findUnique({ where: { id: f.eventId }, include: { attendees: true } });
    if (!ev || ev.deletedAt || ev.rrule || ev.allDay) continue;
    if (ev.start.getTime() < now.getTime() + 2 * 3_600_000 || ev.start.getTime() > now.getTime() + 5 * DAY) continue;
    const org = await meFor(f.userId, f.ws);
    if (!org || !org.perms["calendar.open"]) continue;
    await db.meetFlexible.update({ where: { eventId: f.eventId }, data: { checkedAt: now } });
    const why = await problemWith(org, ev);
    if (!why) continue;
    const { findSlots, localDate } = await import("../cal-smart");
    const day = localDate(ev.start, org.tz);
    const guests = ev.attendees.filter((a) => a.response !== "no");
    const mins = minutesOf(ev);
    const slots = await findSlots(org, guests.filter((a) => a.userId).map((a) => a.userId!), day, day, mins, { limit: 3, earliest: new Date(now.getTime() + 2 * 3_600_000) });
    const best = slots.find((s) => localDate(s.start, org.tz) === day);
    if (!best) continue;
    const internal = guests.every((a) => !!a.userId);
    const recentlyMoved = f.movedAt && now.getTime() - f.movedAt.getTime() < DAY;
    const key = `move:${ev.id}:${best.start}`;
    if (await db.meetRecommendation.findUnique({ where: { userId_key: { userId: f.userId, key } } })) continue;
    const fromT = { start: ev.start.toISOString(), end: ev.end.toISOString() };
    const { fmtTime } = await import("../cal-smart");
    const reason = `${why} Everyone is free at ${fmtTime(best.start, org.tz)} the same day (${best.reason}).`;
    if (internal && !recentlyMoved) {
      const { updateEvent } = await import("../calendar");
      await updateEvent(org, ev.id, { start: best.start, end: best.end }, "all");
      await db.meetFlexible.update({ where: { eventId: ev.id }, data: { movedAt: now } });
      await db.meetRecommendation.create({ data: { ws: f.ws, userId: f.userId, eventId: ev.id, kind: "move", title: `Moved "${ev.title}" to ${fmtTime(best.start, org.tz)}`, reason, details: { from: fromT, to: { start: best.start, end: best.end }, auto: true }, key, status: "accepted", result: "Moved automatically (every guest is in the workspace). Guests were told.", reviewedAt: now } });
      await notify({ ws: f.ws, userId: f.userId, kind: "meet.flexible", title: `Moved your flexible meeting: ${ev.title}`, body: reason, link: `/calendar?event=${ev.id}`, key: `flex:${ev.id}:${best.start}` });
      out.push({ eventId: ev.id, action: "moved", reason, to: { start: best.start, end: best.end } });
    } else {
      await db.meetRecommendation.create({ data: { ws: f.ws, userId: f.userId, eventId: ev.id, kind: "move", title: `Move "${ev.title}" to ${fmtTime(best.start, org.tz)}?`, reason: `${reason}${internal ? "" : " Some guests are outside the workspace, so it waits for you."}`, details: { from: fromT, to: { start: best.start, end: best.end } }, key } });
      await notify({ ws: f.ws, userId: f.userId, kind: "meet.flexible", title: `A better time for: ${ev.title}`, body: reason, link: `/meet/recommendations`, key: `flexp:${ev.id}:${best.start}` });
      out.push({ eventId: ev.id, action: "proposed", reason, to: { start: best.start, end: best.end } });
    }
  }
  return out;
}
