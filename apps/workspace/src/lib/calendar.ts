import crypto from "node:crypto";
import type { Attendee, Calendar, Event } from "@prisma/client";
import { db } from "./db";
import { HttpError, type Me, can } from "./auth";
import { expand, parseRule } from "./rrule";
import { notify } from "./notify";
import { bad } from "./http";
import { isZone } from "./auth";

export type EventWithAttendees = Event & { attendees: Attendee[] };

export const CONF_RE = /https?:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[a-z0-9.-]*zoom\.us\/[^\s"'<>]+|teams\.microsoft\.com\/[^\s"'<>]+|teams\.live\.com\/[^\s"'<>]+|[a-z0-9.-]*webex\.com\/[^\s"'<>]+|whereby\.com\/[^\s"'<>]+)/i;
export function findConference(...texts: (string | null | undefined)[]) {
  for (const t of texts) {
    const m = t ? CONF_RE.exec(t) : null;
    if (m) return m[0];
  }
  return null;
}

// ── Who can see and change what ────────────────────────────────────────────

/** none < busy (free/busy only) < read < edit < manage (share and settings) < owner */
export type Access = "none" | "busy" | "read" | "edit" | "manage" | "owner";
const RANK: Record<Access, number> = { none: 0, busy: 1, read: 2, edit: 3, manage: 4, owner: 5 };
export const atLeast = (a: Access, b: Access) => RANK[a] >= RANK[b];

type CalWithShares = Calendar & { shares?: { userId: string; role: string }[] };

export function accessTo(me: Me, c: CalWithShares): Access {
  if (c.ws !== me.ws) return "none";
  if (c.kind !== "team" && c.ownerId === me.userId) return "owner";
  const share = c.shares?.find((s) => s.userId === me.userId)?.role as Access | undefined;
  let a: Access = share && RANK[share] !== undefined ? share : "none";
  if (c.kind === "team") a = RANK[a] >= RANK.edit ? a : can(me, "calendar.create") ? (c.createdBy === me.userId || me.owner ? "manage" : "edit") : "read";
  else if (RANK[(c.wsAccess as Access) ?? "busy"] > RANK[a]) a = (c.wsAccess as Access) ?? "busy";
  if (me.owner && c.kind === "team") a = "manage";
  return a;
}

/** My calendars, team calendars, and other people's calendars I added to my list. */
export async function visibleCalendars(me: Me) {
  const subs = await db.calendarSub.findMany({ where: { userId: me.userId } });
  const cals = await db.calendar.findMany({
    where: { ws: me.ws, OR: [{ kind: "team" }, { ownerId: me.userId }, { id: { in: subs.map((s) => s.calendarId) } }] },
    include: { shares: true },
    orderBy: [{ kind: "asc" }, { primary: "desc" }, { createdAt: "asc" }],
  });
  return cals.filter((c) => atLeast(accessTo(me, c), "busy"));
}

export function canEditEvent(me: Me, ev: Event, cal: CalWithShares, attendees?: Attendee[]) {
  if (ev.ws !== me.ws) return false;
  if (cal.kind === "subscribed") return false;
  if (ev.creatorId === me.userId) return true;
  if (atLeast(accessTo(me, cal), "edit")) return true;
  return !!ev.guestsCanModify && !!attendees?.some((a) => a.userId === me.userId);
}

/** An event the person may see (their calendars, shared calendars, or invited), else 404. */
export async function loadEvent(me: Me, id: string) {
  const ev = await db.event.findUnique({ where: { id }, include: { attendees: true, calendar: { include: { shares: true } } } });
  if (!ev || ev.ws !== me.ws || ev.deletedAt) throw new HttpError(404, "Not found");
  const invited = ev.attendees.some((a) => a.userId === me.userId);
  if (!atLeast(accessTo(me, ev.calendar), "read") && !invited && ev.creatorId !== me.userId) throw new HttpError(404, "Not found");
  return ev;
}

export type Occurrence = {
  id: string;
  /** Occurrence start (ISO) for recurring series, else null. */
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
  emailReminders: number[];
  conferenceUrl: string | null;
  creatorId: string;
  attendees: { userId: string | null; email: string; name: string; response: string; comment: string; optional: boolean; proposedStart: string | null; proposedEnd: string | null }[];
  myResponse: string | null;
  canEdit: boolean;
  google: boolean;
  visibility: string;
  transparency: string;
  eventType: string;
  autoDecline: boolean;
  declineMessage: string;
  guestsCanModify: boolean;
  guestsCanInvite: boolean;
  guestsSeeList: boolean;
  /** Only free/busy can be shown (a private event, or a calendar shared as busy only). */
  masked: boolean;
  /** From Google, organized by someone else (reply with Yes / No / Maybe; the details are theirs to change). */
  googleOrganizer: string | null;
};

function dto(me: Me, ev: EventWithAttendees, cal: CalWithShares, start: Date, occ: Date | null): Occurrence {
  const dur = ev.end.getTime() - ev.start.getTime();
  const mine = ev.attendees.find((a) => a.userId === me.userId);
  const access = accessTo(me, cal);
  const isGuest = !!mine || ev.creatorId === me.userId;
  const masked = !isGuest && (access === "busy" || (ev.visibility === "private" && !atLeast(access, "edit")));
  const editable = canEditEvent(me, ev, cal, ev.attendees);
  const hideGuests = !editable && !ev.guestsSeeList && ev.creatorId !== me.userId;
  return {
    id: ev.id,
    occ: occ ? occ.toISOString() : null,
    seriesId: ev.recurringId,
    title: masked ? "Busy" : ev.title,
    description: masked ? "" : ev.description,
    location: masked ? "" : ev.location,
    start: start.toISOString(),
    end: new Date(start.getTime() + dur).toISOString(),
    allDay: ev.allDay,
    tz: ev.tz,
    rrule: masked ? null : ev.rrule,
    calendarId: ev.calendarId,
    color: ev.color ?? cal.color,
    reminders: ev.reminders,
    emailReminders: ev.emailReminders,
    conferenceUrl: masked ? null : (ev.conferenceUrl ?? findConference(ev.location, ev.description)),
    creatorId: ev.creatorId,
    attendees: masked ? [] : ev.attendees.filter((a) => !hideGuests || a.userId === me.userId).map((a) => ({ userId: a.userId, email: a.email, name: a.name, response: a.response, comment: a.comment, optional: a.optional, proposedStart: a.proposedStart?.toISOString() ?? null, proposedEnd: a.proposedEnd?.toISOString() ?? null })),
    myResponse: ev.creatorId === me.userId ? (ev.rsvpSelf ?? "yes") : (mine?.response ?? null),
    canEdit: !masked && editable && !ev.googleOrganizer,
    google: !!ev.googleId,
    visibility: ev.visibility,
    transparency: ev.transparency,
    eventType: ev.eventType,
    autoDecline: ev.autoDecline,
    declineMessage: masked ? "" : ev.declineMessage,
    guestsCanModify: ev.guestsCanModify,
    guestsCanInvite: ev.guestsCanInvite,
    guestsSeeList: ev.guestsSeeList,
    masked,
    googleOrganizer: masked ? null : ev.googleOrganizer,
  };
}

/** Every occurrence the person can see in [from, to). */
export async function occurrences(me: Me, from: Date, to: Date): Promise<Occurrence[]> {
  const cals = await visibleCalendars(me);
  const calIds = cals.map((c) => c.id);
  const evs = await db.event.findMany({
    where: {
      ws: me.ws,
      deletedAt: null,
      OR: [{ calendarId: { in: calIds } }, { attendees: { some: { userId: me.userId } } }],
      AND: [{ OR: [{ rrule: { not: null } }, { AND: [{ start: { lt: to } }, { end: { gt: from } }] }] }],
    },
    include: { attendees: true, calendar: { include: { shares: true } } },
  });
  const out: Occurrence[] = [];
  const exceptions = new Map<string, Set<number>>();
  for (const e of evs) if (e.recurringId && e.originalStart) {
    const s = exceptions.get(e.recurringId) ?? new Set<number>();
    s.add(e.originalStart.getTime());
    exceptions.set(e.recurringId, s);
  }
  for (const e of evs) {
    if (e.rrule) {
      const skip = exceptions.get(e.id);
      for (const s of expand(e, from, to)) if (!skip?.has(s.getTime())) out.push(dto(me, e, e.calendar, s, s));
    } else if (e.start < to && e.end > from) {
      out.push(dto(me, e, e.calendar, e.start, e.recurringId && e.originalStart ? e.originalStart : null));
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// ── Writing ───────────────────────────────────────────────────────────────

export type EventInput = {
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  tz?: string;
  rrule?: string | null;
  reminders?: number[];
  emailReminders?: number[];
  color?: string | null;
  conferenceUrl?: string | null;
  attendees?: { userId?: string; email?: string; name?: string; optional?: boolean }[];
  visibility?: string;
  transparency?: string;
  eventType?: string;
  autoDecline?: boolean;
  declineMessage?: string;
  guestsCanModify?: boolean;
  guestsCanInvite?: boolean;
  guestsSeeList?: boolean;
};

const RRULE_OK = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/;

function times(input: EventInput, fallback?: { start: Date; end: Date; allDay: boolean }) {
  const allDay = input.allDay ?? fallback?.allDay ?? false;
  const norm = (s: string) => (allDay ? new Date(`${s.slice(0, 10)}T00:00:00.000Z`) : new Date(s));
  let start = input.start ? norm(input.start) : fallback?.start;
  let end = input.end ? norm(input.end) : fallback?.end;
  if (!start || isNaN(start.getTime())) bad("A start time is required.");
  if (!end || isNaN(end.getTime())) end = new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000));
  if (allDay && input.allDay !== undefined && fallback && !fallback.allDay) {
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  }
  if (input.start && input.end && end < start) bad("The event ends before it starts.");
  if (end <= start) end = new Date(start.getTime() + (allDay ? 86_400_000 : 30 * 60_000));
  return { start, end, allDay };
}

function cleanFields(input: EventInput) {
  const d: Record<string, unknown> = {};
  if (input.title !== undefined) d.title = String(input.title).trim().slice(0, 300) || "(No title)";
  if (input.description !== undefined) d.description = String(input.description).slice(0, 8000);
  if (input.location !== undefined) d.location = String(input.location).slice(0, 500);
  if (input.tz !== undefined) d.tz = input.tz && isZone(input.tz) ? input.tz : "UTC";
  if (input.rrule !== undefined) {
    const r = input.rrule ? String(input.rrule).replace(/^RRULE:/i, "").toUpperCase() : null;
    if (r && (!RRULE_OK.test(r) || !parseRule(r))) bad("That repeat rule isn't supported.");
    d.rrule = r;
  }
  const mins = (v: unknown) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 40320).slice(0, 5);
  if (input.reminders !== undefined) d.reminders = mins(input.reminders);
  if (input.emailReminders !== undefined) d.emailReminders = mins(input.emailReminders);
  if (input.color !== undefined) d.color = input.color && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : null;
  if (input.conferenceUrl !== undefined) d.conferenceUrl = input.conferenceUrl && /^https?:\/\//.test(input.conferenceUrl) ? String(input.conferenceUrl).slice(0, 1000) : null;
  if (input.visibility !== undefined) d.visibility = ["default", "public", "private"].includes(input.visibility) ? input.visibility : "default";
  if (input.transparency !== undefined) d.transparency = input.transparency === "free" ? "free" : "busy";
  if (input.eventType !== undefined) {
    d.eventType = ["default", "outOfOffice", "focusTime", "workingLocation"].includes(input.eventType) ? input.eventType : "default";
    if (d.eventType === "workingLocation") d.transparency = "free";
  }
  if (input.autoDecline !== undefined) d.autoDecline = !!input.autoDecline;
  if (input.declineMessage !== undefined) d.declineMessage = String(input.declineMessage).slice(0, 500);
  for (const k of ["guestsCanModify", "guestsCanInvite", "guestsSeeList"] as const) if (input[k] !== undefined) d[k] = !!input[k];
  return d;
}

async function resolveAttendees(me: Me, list: EventInput["attendees"], organizerId: string) {
  const out: { userId: string | null; email: string; name: string; optional: boolean }[] = [];
  const seen = new Set<string>();
  for (const a of (list ?? []).slice(0, 100)) {
    if (a.userId) {
      const m = await db.member.findUnique({ where: { ws_userId: { ws: me.ws, userId: a.userId } } });
      const u = m ? await db.user.findUnique({ where: { id: a.userId } }) : null;
      if (!u || seen.has(u.email.toLowerCase())) continue;
      seen.add(u.email.toLowerCase());
      out.push({ userId: u.id, email: u.email, name: u.name ?? "", optional: !!a.optional });
    } else if (a.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email.trim())) {
      const email = a.email.trim().toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      // A workspace person by email becomes an internal invite.
      const u = await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
      const isMember = u ? await db.member.findUnique({ where: { ws_userId: { ws: me.ws, userId: u.id } } }) : null;
      out.push({ userId: isMember ? u!.id : null, email, name: String(a.name ?? u?.name ?? "").slice(0, 200), optional: !!a.optional });
    }
  }
  return out.filter((a) => a.userId !== organizerId);
}

/** Set the guest list; returns the guests who were added (for invitations) and removed (for cancellations). */
async function setAttendees(me: Me, ev: Event, list: EventInput["attendees"]) {
  const want = await resolveAttendees(me, list, ev.creatorId);
  const have = await db.attendee.findMany({ where: { eventId: ev.id } });
  const wantEmails = new Set(want.map((a) => a.email.toLowerCase()));
  const removed = have.filter((h) => !wantEmails.has(h.email.toLowerCase()));
  await db.attendee.deleteMany({ where: { eventId: ev.id, email: { notIn: [...wantEmails] } } });
  const added: Attendee[] = [];
  for (const a of want) {
    const old = have.find((h) => h.email.toLowerCase() === a.email.toLowerCase());
    if (old) {
      if (old.optional !== a.optional) await db.attendee.update({ where: { id: old.id }, data: { optional: a.optional } });
      continue;
    }
    const row = await db.attendee.create({ data: { eventId: ev.id, userId: a.userId, email: a.email, name: a.name, optional: a.optional, token: a.userId ? null : crypto.randomBytes(18).toString("base64url") } });
    added.push(row);
    if (a.userId)
      await notify({ ws: me.ws, userId: a.userId, kind: "invite", title: `${me.name} invited you: ${ev.title}`, body: ev.start.toISOString(), link: `/calendar?event=${ev.id}` });
  }
  await autoDeclineFor(ev, added.filter((a) => a.userId));
  return { added, removed };
}

/** Invited people who are out of office or in focus time with auto-decline then decline, with their message. */
async function autoDeclineFor(ev: Event, guests: Attendee[]) {
  for (const g of guests) {
    const blocks = await db.event.findMany({
      where: { creatorId: g.userId!, deletedAt: null, autoDecline: true, eventType: { in: ["outOfOffice", "focusTime"] }, start: { lt: ev.end }, end: { gt: ev.start } },
      take: 1,
    });
    const b = blocks[0];
    if (!b) continue;
    await db.attendee.update({ where: { id: g.id }, data: { response: "no", comment: b.declineMessage || (b.eventType === "outOfOffice" ? "Out of office" : "In focus time") } });
    await notify({ ws: ev.ws, userId: ev.creatorId, kind: "rsvp", title: `${g.name || g.email} declined automatically: ${ev.title}`, body: b.declineMessage || (b.eventType === "outOfOffice" ? "Out of office" : "In focus time"), link: `/calendar?event=${ev.id}` });
  }
}

/** A new out-of-office or focus block with auto-decline turns down invitations already in that time. */
async function declineExisting(me: Me, ev: Event) {
  if (!ev.autoDecline || !["outOfOffice", "focusTime"].includes(ev.eventType)) return 0;
  const mine = await db.attendee.findMany({ where: { userId: me.userId, response: { in: ["needs", "maybe", "yes"] }, event: { deletedAt: null, start: { lt: ev.end }, end: { gt: ev.start }, id: { not: ev.id } } }, include: { event: true } });
  for (const a of mine) {
    await db.attendee.update({ where: { id: a.id }, data: { response: "no", comment: ev.declineMessage || (ev.eventType === "outOfOffice" ? "Out of office" : "In focus time") } });
    await notify({ ws: me.ws, userId: a.event.creatorId, kind: "rsvp", title: `${me.name} declined: ${a.event.title}`, body: ev.declineMessage || "Out of office", link: `/calendar?event=${a.event.id}` });
  }
  return mine.length;
}

export async function writableCalendar(me: Me, calendarId?: string) {
  const cal = calendarId
    ? await db.calendar.findUnique({ where: { id: calendarId }, include: { shares: true } })
    : await db.calendar.findFirst({ where: { ws: me.ws, kind: "personal", ownerId: me.userId, primary: true }, include: { shares: true } });
  if (!cal || !atLeast(accessTo(me, cal), "read")) throw new HttpError(404, "Calendar not found");
  if (cal.kind === "subscribed") bad("Subscribed calendars are read-only.");
  if (!atLeast(accessTo(me, cal), "edit") && cal.kind !== "team") throw new HttpError(403, "You can see this calendar but not add to it.");
  return cal;
}

/** Guests who are outside their working hours or away at this time (a heads-up for the organizer). */
export async function guestWarnings(me: Me, ev: Pick<Event, "start" | "end" | "allDay"> & { id?: string }, userIds: string[]) {
  if (ev.allDay || !userIds.length) return [];
  const out: string[] = [];
  const users = await db.user.findMany({ where: { id: { in: userIds } } });
  const { workingHoursOf } = await import("./cal-plus");
  for (const u of users) {
    const away = await db.event.findFirst({ where: { creatorId: u.id, deletedAt: null, eventType: "outOfOffice", start: { lt: ev.end }, end: { gt: ev.start }, ...(ev.id ? { id: { not: ev.id } } : {}) } });
    if (away) {
      out.push(`${u.name ?? u.email} is out of office then.`);
      continue;
    }
    if (!workingHoursOf(u).covers(ev.start, ev.end)) out.push(`${u.name ?? u.email} is outside working hours then.`);
  }
  return out;
}

export async function createEvent(me: Me, input: EventInput) {
  const cal = await writableCalendar(me, input.calendarId);
  const t = times(input);
  const fields = cleanFields({ ...input, tz: input.tz ?? me.tz });
  const now = new Date();
  const ev = await db.event.create({
    data: { ws: me.ws, calendarId: cal.id, creatorId: me.userId, title: "(No title)", ...fields, ...t, createdAt: now, updatedAt: now } as never,
  });
  let added: Attendee[] = [];
  if (input.attendees) added = (await setAttendees(me, ev, input.attendees)).added;
  await declineExisting(me, ev);
  const { mailGuests } = await import("./cal-mail");
  if (added.some((a) => !a.userId)) await mailGuests(me, ev.id, "invite", added.filter((a) => !a.userId).map((a) => a.email));
  return ev;
}

const SIGNIFICANT = ["title", "description", "location", "start", "end", "allDay", "rrule", "conferenceUrl"];

/** Edit an event; for a series, scope "this" (one occurrence, `occ`), "following" (this and later) or "all". */
export async function updateEvent(me: Me, id: string, input: EventInput, scope: "this" | "following" | "all" = "all", occ?: string) {
  const ev = await loadEvent(me, id);
  if (!canEditEvent(me, ev, ev.calendar, ev.attendees)) throw new HttpError(403, "You can't edit this event.");
  if (input.calendarId && input.calendarId !== ev.calendarId) await writableCalendar(me, input.calendarId);
  // Guests allowed to modify can't change the guest list unless they may invite.
  if (ev.creatorId !== me.userId && !atLeast(accessTo(me, ev.calendar), "edit") && input.attendees && !ev.guestsCanInvite) delete input.attendees;
  const now = new Date();
  const fields = cleanFields(input);
  const { mailGuests } = await import("./cal-mail");
  if (ev.rrule && scope === "this") {
    if (!occ) bad("Which occurrence? (occ)");
    const o = new Date(occ);
    const dur = ev.end.getTime() - ev.start.getTime();
    const t = times(input, { start: o, end: new Date(o.getTime() + dur), allDay: ev.allDay });
    const ex = await db.event.create({
      data: {
        ws: ev.ws, calendarId: input.calendarId ?? ev.calendarId, creatorId: ev.creatorId, title: ev.title, description: ev.description, location: ev.location,
        tz: ev.tz, color: ev.color, conferenceUrl: ev.conferenceUrl, reminders: ev.reminders, emailReminders: ev.emailReminders, visibility: ev.visibility, transparency: ev.transparency,
        eventType: ev.eventType, guestsCanModify: ev.guestsCanModify, guestsCanInvite: ev.guestsCanInvite, guestsSeeList: ev.guestsSeeList,
        recurringId: ev.id, originalStart: o, ...fields, rrule: null, ...t, createdAt: now, updatedAt: now,
      } as never,
    });
    const att = input.attendees ?? ev.attendees.map((a) => ({ userId: a.userId ?? undefined, email: a.email, name: a.name, optional: a.optional }));
    await setAttendees(me, ex, att);
    // Keep replies people already gave on the series.
    for (const a of ev.attendees) await db.attendee.updateMany({ where: { eventId: ex.id, email: a.email }, data: { response: a.response } });
    await mailGuests(me, ex.id, "update");
    return ex;
  }
  if (ev.rrule && scope === "following" && occ) {
    // Split: the old series ends just before this occurrence; a new series starts here with the changes.
    const o = new Date(occ);
    if (o.getTime() <= ev.start.getTime()) return updateEvent(me, id, input, "all", occ);
    const dur = ev.end.getTime() - ev.start.getTime();
    const t = times(input, { start: o, end: new Date(o.getTime() + dur), allDay: ev.allDay });
    const until = new Date(o.getTime() - 1000);
    const stamp = until.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const oldRule = ev.rrule.split(";").filter((p) => !/^(UNTIL|COUNT)=/.test(p)).join(";");
    await db.event.update({ where: { id: ev.id }, data: { rrule: `${oldRule};UNTIL=${stamp}`, updatedAt: now } });
    const keepRule = fields.rrule !== undefined ? fields.rrule : ev.rrule.split(";").filter((p) => !/^COUNT=/.test(p)).join(";");
    const next = await db.event.create({
      data: {
        ws: ev.ws, calendarId: input.calendarId ?? ev.calendarId, creatorId: ev.creatorId, title: ev.title, description: ev.description, location: ev.location,
        tz: ev.tz, color: ev.color, conferenceUrl: ev.conferenceUrl, reminders: ev.reminders, emailReminders: ev.emailReminders, visibility: ev.visibility, transparency: ev.transparency,
        eventType: ev.eventType, autoDecline: ev.autoDecline, declineMessage: ev.declineMessage, guestsCanModify: ev.guestsCanModify, guestsCanInvite: ev.guestsCanInvite, guestsSeeList: ev.guestsSeeList,
        exdates: ev.exdates.filter((x) => new Date(x) >= o),
        ...fields, rrule: keepRule, ...t, createdAt: now, updatedAt: now,
      } as never,
    });
    // Changed occurrences after the split now belong to the new series.
    await db.event.updateMany({ where: { recurringId: ev.id, originalStart: { gte: o } }, data: { recurringId: next.id, updatedAt: now } });
    const att = input.attendees ?? ev.attendees.map((a) => ({ userId: a.userId ?? undefined, email: a.email, name: a.name, optional: a.optional }));
    await setAttendees(me, next, att);
    for (const a of ev.attendees) await db.attendee.updateMany({ where: { eventId: next.id, email: a.email }, data: { response: a.response } });
    await mailGuests(me, ev.id, "update");
    await mailGuests(me, next.id, "invite");
    return next;
  }
  let t: { start?: Date; end?: Date; allDay?: boolean } = {};
  if (input.start || input.end || input.allDay !== undefined) {
    if (ev.rrule && occ) {
      // Moving one occurrence of the whole series: shift the series by the same amount.
      const o = new Date(occ);
      const dur = ev.end.getTime() - ev.start.getTime();
      const nt = times(input, { start: o, end: new Date(o.getTime() + dur), allDay: ev.allDay });
      const delta = nt.start.getTime() - o.getTime();
      t = { start: new Date(ev.start.getTime() + delta), end: new Date(ev.start.getTime() + delta + (nt.end.getTime() - nt.start.getTime())), allDay: nt.allDay };
      if (delta) {
        fields.exdates = ev.exdates.map((x) => new Date(new Date(x).getTime() + delta).toISOString());
        const exs = await db.event.findMany({ where: { recurringId: ev.id } });
        for (const x of exs) if (x.originalStart) await db.event.update({ where: { id: x.id }, data: { originalStart: new Date(x.originalStart.getTime() + delta), updatedAt: now } });
      }
    } else t = times(input, ev);
  }
  const updated = await db.event.update({ where: { id: ev.id }, data: { ...fields, ...t, ...(input.calendarId ? { calendarId: input.calendarId } : {}), updatedAt: now } as never });
  let added: Attendee[] = [];
  let removed: Attendee[] = [];
  if (input.attendees) ({ added, removed } = await setAttendees(me, updated, input.attendees));
  await declineExisting(me, updated);
  const before = ev as unknown as Record<string, unknown>;
  const after = updated as unknown as Record<string, unknown>;
  const changed = SIGNIFICANT.some((k) => String(before[k]) !== String(after[k]));
  // Guests hear about a new time; replies stay as they were.
  if (String(ev.start) !== String(updated.start) || String(ev.end) !== String(updated.end)) {
    for (const a of ev.attendees.filter((x) => x.userId)) await notify({ ws: me.ws, userId: a.userId!, kind: "invite", title: `${me.name} changed the time: ${updated.title}`, body: updated.start.toISOString(), link: `/calendar?event=${ev.id}` });
    await db.attendee.updateMany({ where: { eventId: ev.id, proposedStart: { not: null } }, data: { proposedStart: null, proposedEnd: null } });
  }
  if (added.some((a) => !a.userId)) await mailGuests(me, ev.id, "invite", added.filter((a) => !a.userId).map((a) => a.email));
  if (changed) await mailGuests(me, ev.id, "update", undefined, added.map((a) => a.email));
  if (removed.some((a) => !a.userId)) await mailGuests(me, ev.id, "cancel", removed.filter((a) => !a.userId).map((a) => a.email), [], removed);
  return updated;
}

export async function deleteEvent(me: Me, id: string, scope: "this" | "following" | "all" = "all", occ?: string) {
  const ev = await loadEvent(me, id);
  if (!canEditEvent(me, ev, ev.calendar, ev.attendees)) throw new HttpError(403, "You can't delete this event.");
  const now = new Date();
  const { mailGuests } = await import("./cal-mail");
  if (ev.rrule && scope === "this") {
    if (!occ) bad("Which occurrence? (occ)");
    const iso = new Date(occ).toISOString();
    await db.event.update({ where: { id: ev.id }, data: { exdates: [...new Set([...ev.exdates, iso])], updatedAt: now } });
    await mailGuests(me, ev.id, "update");
    return { series: ev };
  }
  if (ev.rrule && scope === "following" && occ) {
    const o = new Date(occ);
    if (o.getTime() > ev.start.getTime()) {
      const stamp = new Date(o.getTime() - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const rule = ev.rrule.split(";").filter((p) => !/^(UNTIL|COUNT)=/.test(p)).join(";");
      await db.event.update({ where: { id: ev.id }, data: { rrule: `${rule};UNTIL=${stamp}`, updatedAt: now } });
      await db.event.updateMany({ where: { recurringId: ev.id, originalStart: { gte: o } }, data: { deletedAt: now, updatedAt: now } });
      await mailGuests(me, ev.id, "update");
      return { series: ev };
    }
  }
  if (ev.recurringId && scope === "this") {
    await db.event.update({ where: { id: ev.id }, data: { deletedAt: now, updatedAt: now } });
    if (ev.originalStart) {
      const s = await db.event.findUnique({ where: { id: ev.recurringId } });
      if (s) await db.event.update({ where: { id: s.id }, data: { exdates: [...new Set([...s.exdates, ev.originalStart.toISOString()])], updatedAt: now } });
    }
    await mailGuests(me, ev.id, "cancel");
    return { series: null };
  }
  const seriesId = ev.recurringId ?? ev.id;
  await mailGuests(me, seriesId, "cancel");
  await db.event.updateMany({ where: { OR: [{ id: seriesId }, { recurringId: seriesId }, { id: ev.id }], deletedAt: null }, data: { deletedAt: now, updatedAt: now } });
  for (const a of ev.attendees.filter((x) => x.userId)) await notify({ ws: me.ws, userId: a.userId!, kind: "invite", title: `${me.name} cancelled: ${ev.title}`, link: `/calendar` });
  return { series: null };
}

/** Reply yes / no / maybe, with an optional note and a proposed new time. */
export async function respond(me: Me, id: string, response: string, extra: { comment?: string; proposeStart?: string; proposeEnd?: string } = {}) {
  if (!["yes", "no", "maybe"].includes(response)) bad("Reply yes, no or maybe.");
  const ev = await loadEvent(me, id);
  const a = ev.attendees.find((x) => x.userId === me.userId);
  // Invited in Google (someone else organizes it): the reply goes back to Google with the next push.
  if (!a && ev.googleOrganizer && ev.calendar.ownerId === me.userId) {
    await db.event.update({ where: { id: ev.id }, data: { rsvpSelf: response, updatedAt: new Date() } });
    return { ok: true, google: true };
  }
  if (!a) throw new HttpError(400, "You aren't invited to this event.");
  const ps = extra.proposeStart ? new Date(extra.proposeStart) : null;
  const pe = extra.proposeEnd ? new Date(extra.proposeEnd) : null;
  if (ps && (isNaN(ps.getTime()) || !pe || isNaN(pe.getTime()) || pe <= ps)) bad("Propose a start and an end after it.");
  await db.attendee.update({ where: { id: a.id }, data: { response, comment: String(extra.comment ?? "").slice(0, 500), proposedStart: ps, proposedEnd: pe } });
  // A synced event: the organizer's Google copy gets the new reply with the next push.
  if (ev.googleId) await db.event.update({ where: { id: ev.id }, data: { updatedAt: new Date() } });
  if (ev.creatorId !== me.userId) {
    const word = response === "yes" ? "Yes" : response === "no" ? "No" : "Maybe";
    await notify({
      ws: me.ws, userId: ev.creatorId, kind: "rsvp",
      title: ps ? `${me.name} proposed a new time: ${ev.title}` : `${me.name} replied ${word}: ${ev.title}`,
      body: ps ? ps.toISOString() : (extra.comment ?? ""),
      link: `/calendar?event=${ev.id}`,
    });
  }
  return { ok: true };
}

/** The organizer takes a guest's proposed time. */
export async function acceptProposal(me: Me, id: string, email: string) {
  const ev = await loadEvent(me, id);
  if (!canEditEvent(me, ev, ev.calendar, ev.attendees)) throw new HttpError(403, "Only the organizer can change the time.");
  const a = ev.attendees.find((x) => x.email.toLowerCase() === email.toLowerCase());
  if (!a?.proposedStart || !a.proposedEnd) bad("That guest hasn't proposed a time.");
  const u = await updateEvent(me, id, { start: a.proposedStart.toISOString(), end: a.proposedEnd.toISOString() }, "all");
  await db.attendee.update({ where: { id: a.id }, data: { response: "yes", proposedStart: null, proposedEnd: null } });
  return u;
}

/** Busy blocks for people in the workspace (their own and team events, plus events they accepted). Free events don't count. */
export async function busy(me: Me, userIds: string[], from: Date, to: Date) {
  const out: Record<string, { start: string; end: string; kind?: string }[]> = {};
  for (const uid of userIds.slice(0, 12)) {
    const m = await db.member.findUnique({ where: { ws_userId: { ws: me.ws, userId: uid } } });
    if (!m) continue;
    const cals = await db.calendar.findMany({ where: { ws: me.ws, kind: "personal", ownerId: uid }, select: { id: true } });
    const evs = await db.event.findMany({
      where: {
        ws: me.ws,
        deletedAt: null,
        allDay: false,
        transparency: "busy",
        OR: [{ calendarId: { in: cals.map((c) => c.id) } }, { creatorId: uid }, { attendees: { some: { userId: uid, response: { in: ["yes", "maybe", "needs"] } } } }],
      },
    });
    const ex = new Map<string, Set<number>>();
    for (const e of evs) if (e.recurringId && e.originalStart) ex.set(e.recurringId, (ex.get(e.recurringId) ?? new Set()).add(e.originalStart.getTime()));
    const blocks: { start: string; end: string; kind?: string }[] = [];
    for (const e of evs) {
      const dur = e.end.getTime() - e.start.getTime();
      for (const s of expand(e, from, to)) if (!ex.get(e.id)?.has(s.getTime())) blocks.push({ start: s.toISOString(), end: new Date(s.getTime() + dur).toISOString(), ...(e.eventType !== "default" ? { kind: e.eventType } : {}) });
    }
    out[uid] = blocks.sort((a, b) => a.start.localeCompare(b.start));
  }
  return out;
}

export async function people(ws: string) {
  const ms = await db.member.findMany({ where: { ws } });
  const users = await db.user.findMany({ where: { id: { in: ms.map((m) => m.userId) } }, orderBy: { name: "asc" } });
  return users.map((u) => ({ id: u.id, name: u.name ?? u.email, email: u.email, image: u.image }));
}
