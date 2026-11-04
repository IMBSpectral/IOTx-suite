import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { User } from "@prisma/client";
import { db } from "./db";
import { HttpError, isZone, type Me } from "./auth";
import { bad, str } from "./http";
import { notify } from "./notify";
import { accessTo, atLeast, loadEvent, occurrences, visibleCalendars, canEditEvent } from "./calendar";
import { buildIcs, parseIcs, type IcsOut } from "./ics";
import { expand } from "./rrule";
import { partsIn, zonedToUtc } from "./time";
import { BASE, EMAIL_ORIGIN } from "./env";
import { icsFor, sendMail, when } from "./cal-mail";

/**
 * Calendar beyond events: per-person settings and working hours, more
 * calendars and sharing them, other people's calendars, search, iCal import,
 * export, feeds and subscriptions, replies from people without an account,
 * attachments, booking pages and email reminders.
 */

// ── Settings and working hours ─────────────────────────────────────────────

export type Range = { start: string; end: string };
export type CalSettings = {
  weekStart: 0 | 1 | 6;
  timeFormat: "12" | "24";
  defaultMinutes: number;
  defaultReminders: number[];
  secondTz: string | null;
  showWeekends: boolean;
  showDeclined: boolean;
  /** Working hours per weekday (0 = Sunday). */
  hours: Record<string, Range[]>;
  /** Working location per weekday: office | home | other text. */
  location: Record<string, string>;
};
const WEEKDAYS_9_6: Record<string, Range[]> = { "1": [{ start: "09:00", end: "18:00" }], "2": [{ start: "09:00", end: "18:00" }], "3": [{ start: "09:00", end: "18:00" }], "4": [{ start: "09:00", end: "18:00" }], "5": [{ start: "09:00", end: "18:00" }] };
export const DEFAULT_SETTINGS: CalSettings = { weekStart: 1, timeFormat: "12", defaultMinutes: 60, defaultReminders: [10], secondTz: null, showWeekends: true, showDeclined: true, hours: WEEKDAYS_9_6, location: {} };
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Settings, falling back to the AI planner's working hours (one range on chosen days) when no per-day hours were set. */
export function settingsOf(u: Pick<User, "calSettings" | "workHours">): CalSettings {
  const s = { ...DEFAULT_SETTINGS, ...((u.calSettings as Partial<CalSettings>) ?? {}) };
  if (!(u.calSettings as Partial<CalSettings> | null)?.hours && u.workHours) {
    const w = u.workHours as { start?: string; end?: string; days?: number[] };
    if (w.start && w.end && Array.isArray(w.days)) s.hours = Object.fromEntries(w.days.map((d) => [String(d % 7), [{ start: w.start!, end: w.end! }]]));
  }
  return s;
}

export function cleanSettings(input: Record<string, unknown>, prev: CalSettings): CalSettings {
  const s = { ...prev };
  if (input.weekStart !== undefined) s.weekStart = ([0, 1, 6] as const).find((x) => x === Number(input.weekStart)) ?? 1;
  if (input.timeFormat !== undefined) s.timeFormat = input.timeFormat === "24" ? "24" : "12";
  if (input.defaultMinutes !== undefined) s.defaultMinutes = [15, 20, 30, 45, 60, 90, 120].includes(Number(input.defaultMinutes)) ? Number(input.defaultMinutes) : 60;
  if (input.defaultReminders !== undefined) s.defaultReminders = (Array.isArray(input.defaultReminders) ? input.defaultReminders : []).map(Number).filter((n) => n >= 0 && n <= 40320).slice(0, 5);
  if (input.secondTz !== undefined) s.secondTz = typeof input.secondTz === "string" && isZone(input.secondTz) ? input.secondTz : null;
  if (input.showWeekends !== undefined) s.showWeekends = !!input.showWeekends;
  if (input.showDeclined !== undefined) s.showDeclined = !!input.showDeclined;
  if (input.hours !== undefined) {
    const h: Record<string, Range[]> = {};
    for (const [d, list] of Object.entries((input.hours ?? {}) as Record<string, Range[]>)) {
      if (!/^[0-6]$/.test(d) || !Array.isArray(list)) continue;
      const ok = list.filter((r) => HM.test(r.start) && HM.test(r.end) && r.start < r.end).slice(0, 4);
      if (ok.length) h[d] = ok;
    }
    s.hours = h;
  }
  if (input.location !== undefined) {
    const l: Record<string, string> = {};
    for (const [d, v] of Object.entries((input.location ?? {}) as Record<string, string>)) if (/^[0-6]$/.test(d) && typeof v === "string" && v.trim()) l[d] = v.trim().slice(0, 60);
    s.location = l;
  }
  return s;
}

/** Whether a time falls inside someone's working hours (in their zone). */
export function workingHoursOf(u: Pick<User, "calSettings" | "workHours" | "tz">) {
  const s = settingsOf(u);
  const tz = u.tz || "UTC";
  return {
    hours: s.hours,
    covers(start: Date, end: Date) {
      const a = partsIn(start, tz);
      const b = partsIn(new Date(end.getTime() - 60_000), tz);
      if (a.y !== b.y || a.m !== b.m || a.d !== b.d) return false;
      const wd = new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
      const ranges = s.hours[String(wd)] ?? [];
      const sm = `${String(a.h).padStart(2, "0")}:${String(a.mi).padStart(2, "0")}`;
      const em = `${String(b.h).padStart(2, "0")}:${String(b.mi + 1).padStart(2, "0")}`;
      return ranges.some((r) => r.start <= sm && em <= (r.end === "00:00" ? "24:00" : r.end));
    },
  };
}

export async function getSettings(me: Me) {
  const u = await db.user.findUniqueOrThrow({ where: { id: me.userId } });
  return { ...settingsOf(u), tz: u.tz, birthday: u.birthday, birthdayShare: u.birthdayShare };
}
export async function saveSettings(me: Me, input: Record<string, unknown>) {
  const u = await db.user.findUniqueOrThrow({ where: { id: me.userId } });
  // Birthday (profile): month and day, an optional year, and who sees it.
  if (input.birthday !== undefined || input.birthdayShare !== undefined) {
    const { cleanBirthday } = await import("./cal-more");
    await db.user.update({
      where: { id: me.userId },
      data: {
        ...(input.birthday !== undefined ? { birthday: cleanBirthday(input.birthday) } : {}),
        ...(input.birthdayShare !== undefined ? { birthdayShare: input.birthdayShare === "workspace" ? "workspace" : "private" } : {}),
      },
    });
  }
  const next = cleanSettings(input, settingsOf(u));
  // The assistant plans inside one range on chosen days: keep it in step with the per-day hours.
  let workHours: object | undefined;
  if (input.hours !== undefined) {
    const ranges = Object.values(next.hours).flat();
    const prev = (u.workHours as Record<string, unknown> | null) ?? {};
    if (ranges.length)
      workHours = { ...prev, days: Object.keys(next.hours).map(Number), start: ranges.map((r) => r.start).sort()[0], end: ranges.map((r) => r.end).sort().at(-1) };
  }
  await db.user.update({ where: { id: me.userId }, data: { calSettings: next as never, ...(workHours ? { workHours } : {}), ...(typeof input.tz === "string" && isZone(input.tz) ? { tz: input.tz } : {}) } });
  return getSettings(me);
}

// ── Calendars, sharing, other people's calendars ───────────────────────────

const COLOR = /^#[0-9a-f]{6}$/i;

export async function calendarList(me: Me) {
  const cals = await visibleCalendars(me);
  const subs = await db.calendarSub.findMany({ where: { userId: me.userId } });
  const owners = await db.user.findMany({ where: { id: { in: [...new Set(cals.map((c) => c.ownerId).filter(Boolean) as string[])] } }, select: { id: true, name: true, email: true } });
  return cals.map((c) => {
    const access = accessTo(me, c);
    const sub = subs.find((s) => s.calendarId === c.id);
    const owner = owners.find((o) => o.id === c.ownerId);
    return {
      id: c.id, kind: c.kind, name: c.name, description: c.description, color: sub?.color ?? c.color, primary: c.primary, ownerId: c.ownerId,
      ownerName: owner?.name ?? owner?.email ?? null, access, mine: access === "owner", other: !!sub, hidden: !!sub?.hidden,
      icsUrl: access === "owner" ? c.icsUrl : null, icsError: c.icsError, icsFetchedAt: c.icsFetchedAt,
      feed: atLeast(access, "manage") && c.feedToken ? `${EMAIL_ORIGIN}${BASE}/api/calendar/feed/${c.feedToken}.ics` : null,
      wsAccess: atLeast(access, "manage") ? c.wsAccess : undefined,
      publicMode: atLeast(access, "manage") ? c.publicMode : undefined,
      publicUrl: atLeast(access, "manage") && c.publicToken && c.publicMode !== "none" ? `${EMAIL_ORIGIN}${BASE}/embed/${c.publicToken}` : null,
      shares: atLeast(access, "manage") ? c.shares.map((s) => ({ userId: s.userId, role: s.role })) : undefined,
    };
  });
}

/** Another personal calendar, e.g. "Side project". */
export async function createCalendar(me: Me, b: { name?: string; color?: string; description?: string }) {
  const name = str(b.name, 80);
  if (!name) bad("Name the calendar.");
  if ((await db.calendar.count({ where: { ownerId: me.userId, kind: "personal" } })) >= 25) bad("You can have up to 25 calendars.");
  return db.calendar.create({ data: { ws: me.ws, kind: "personal", ownerId: me.userId, primary: false, name, description: str(b.description, 500), color: b.color && COLOR.test(b.color) ? b.color : "#0d9488", createdBy: me.userId } });
}

async function managed(me: Me, id: string) {
  const c = await db.calendar.findUnique({ where: { id }, include: { shares: true } });
  if (!c || c.ws !== me.ws) throw new HttpError(404, "Calendar not found");
  if (!atLeast(accessTo(me, c), "manage")) throw new HttpError(403, "You can't change this calendar's settings.");
  return c;
}

export async function updateCalendar(me: Me, id: string, b: Record<string, unknown>) {
  const c = await managed(me, id);
  const data: Record<string, unknown> = {};
  if (b.name !== undefined) data.name = str(b.name, 80) || c.name;
  if (b.description !== undefined) data.description = str(b.description, 500);
  if (typeof b.color === "string" && COLOR.test(b.color)) data.color = b.color;
  if (b.wsAccess !== undefined && c.kind !== "team") data.wsAccess = ["none", "busy", "read"].includes(String(b.wsAccess)) ? b.wsAccess : "busy";
  if (b.feed === true && !c.feedToken) data.feedToken = crypto.randomBytes(20).toString("base64url");
  if (b.feed === false) data.feedToken = null;
  if (b.feed === "reset") data.feedToken = crypto.randomBytes(20).toString("base64url");
  // Make available to public: free/busy only or all details, at an unguessable link (reset makes a new one).
  if (b.publicMode !== undefined) {
    if (c.kind === "subscribed") bad("Subscribed calendars can't be made public.");
    const mode = ["busy", "full"].includes(String(b.publicMode)) ? String(b.publicMode) : "none";
    data.publicMode = mode;
    if (mode !== "none" && !c.publicToken) data.publicToken = (await import("./cal-more")).newPublicToken();
    if (mode === "none") data.publicToken = null;
  }
  if (b.publicReset === true && c.publicToken) data.publicToken = (await import("./cal-more")).newPublicToken();
  await db.calendar.update({ where: { id }, data });
  if (Array.isArray(b.shares)) {
    const wanted = (b.shares as { userId: string; role: string }[]).filter((s) => ["busy", "read", "edit", "manage"].includes(s.role) && s.userId !== c.ownerId).slice(0, 200);
    const members = new Set((await db.member.findMany({ where: { ws: me.ws, userId: { in: wanted.map((w) => w.userId) } } })).map((m) => m.userId));
    const keep = wanted.filter((w) => members.has(w.userId));
    await db.calendarShare.deleteMany({ where: { calendarId: id, userId: { notIn: keep.map((k) => k.userId) } } });
    for (const s of keep) {
      const had = c.shares.find((x) => x.userId === s.userId);
      await db.calendarShare.upsert({ where: { calendarId_userId: { calendarId: id, userId: s.userId } }, create: { calendarId: id, userId: s.userId, role: s.role }, update: { role: s.role } });
      if (!had) {
        await db.calendarSub.upsert({ where: { userId_calendarId: { userId: s.userId, calendarId: id } }, create: { userId: s.userId, calendarId: id }, update: {} });
        await notify({ ws: me.ws, userId: s.userId, kind: "share", title: `${me.name} shared "${data.name ?? c.name}" with you`, link: "/calendar" });
      }
    }
  }
  return (await calendarList(me)).find((x) => x.id === id);
}

export async function deleteCalendar(me: Me, id: string) {
  const c = await managed(me, id);
  if (c.primary && c.kind === "personal") bad("Your main calendar can't be deleted.");
  if (c.kind === "team" && c.createdBy !== me.userId && !me.owner) throw new HttpError(403, "Only whoever made it can remove it.");
  await db.calendar.delete({ where: { id } });
  await db.calendarSub.deleteMany({ where: { calendarId: id } });
  return { ok: true };
}

/** Add a colleague's calendar to my list ("Other calendars"); I see what they share, at least free/busy. */
export async function addOther(me: Me, b: { userId?: string; calendarId?: string }) {
  let cal;
  if (b.calendarId) cal = await db.calendar.findUnique({ where: { id: b.calendarId }, include: { shares: true } });
  else if (b.userId) cal = await db.calendar.findFirst({ where: { ws: me.ws, kind: "personal", ownerId: b.userId, primary: true }, include: { shares: true } });
  if (!cal || cal.ws !== me.ws) throw new HttpError(404, "That calendar isn't available.");
  if (cal.ownerId === me.userId) bad("That's already your calendar.");
  if (!atLeast(accessTo(me, cal), "busy")) throw new HttpError(403, "They haven't shared that calendar with you.");
  await db.calendarSub.upsert({ where: { userId_calendarId: { userId: me.userId, calendarId: cal.id } }, create: { userId: me.userId, calendarId: cal.id }, update: { hidden: false } });
  return { ok: true, access: accessTo(me, cal) };
}
export async function setSub(me: Me, calendarId: string, b: { color?: string; hidden?: boolean; remove?: boolean }) {
  if (b.remove) {
    await db.calendarSub.deleteMany({ where: { userId: me.userId, calendarId } });
    return { ok: true };
  }
  const data: Record<string, unknown> = {};
  if (typeof b.color === "string" && COLOR.test(b.color)) data.color = b.color;
  if (typeof b.hidden === "boolean") data.hidden = b.hidden;
  await db.calendarSub.upsert({ where: { userId_calendarId: { userId: me.userId, calendarId } }, create: { userId: me.userId, calendarId, ...data }, update: data });
  return { ok: true };
}

// ── Search ─────────────────────────────────────────────────────────────────

/** Events (past and future) by title, description, location or guest. */
export async function searchEvents(me: Me, q: string) {
  const text = q.trim();
  if (text.length < 2) return [];
  const cals = await visibleCalendars(me);
  const ids = cals.filter((c) => atLeast(accessTo(me, c), "read")).map((c) => c.id);
  const rows = await db.event.findMany({
    where: {
      ws: me.ws,
      deletedAt: null,
      AND: [
        { OR: [{ calendarId: { in: ids } }, { attendees: { some: { userId: me.userId } } }, { creatorId: me.userId }] },
        { OR: [{ title: { contains: text, mode: "insensitive" } }, { description: { contains: text, mode: "insensitive" } }, { location: { contains: text, mode: "insensitive" } }, { attendees: { some: { OR: [{ email: { contains: text, mode: "insensitive" } }, { name: { contains: text, mode: "insensitive" } }] } } }] },
      ],
    },
    include: { calendar: { include: { shares: true } }, attendees: true },
    orderBy: { start: "desc" },
    take: 100,
  });
  const now = Date.now();
  return rows
    .filter((e) => !(e.visibility === "private" && e.creatorId !== me.userId && !atLeast(accessTo(me, e.calendar), "edit")))
    .map((e) => {
      const next = e.rrule ? (expand(e, new Date(), new Date(now + 400 * 86_400_000), 1)[0] ?? e.start) : e.start;
      return { id: e.id, title: e.title, start: next.toISOString(), end: new Date(next.getTime() + (e.end.getTime() - e.start.getTime())).toISOString(), allDay: e.allDay, location: e.location, repeats: !!e.rrule, color: e.color ?? e.calendar.color, calendar: e.calendar.name };
    })
    .sort((a, b) => Math.abs(new Date(a.start).getTime() - now) - Math.abs(new Date(b.start).getTime() - now));
}

// ── iCal: export, feed, import, subscribe ──────────────────────────────────

async function eventsOf(calendarId: string, masked: boolean): Promise<IcsOut[]> {
  const evs = await db.event.findMany({ where: { calendarId, deletedAt: null }, include: { attendees: true } });
  return evs.map((e) => ({
    uid: `${e.recurringId ?? e.id}@iotx`,
    title: masked || e.visibility === "private" ? "Busy" : e.title,
    description: masked || e.visibility === "private" ? "" : e.description,
    location: masked || e.visibility === "private" ? "" : e.location,
    url: masked ? null : e.conferenceUrl,
    start: e.start, end: e.end, allDay: e.allDay, rrule: e.rrule, exdates: e.exdates,
    recurrenceId: e.recurringId ? e.originalStart : null,
    transparent: e.transparency === "free",
    updated: e.updatedAt,
  }));
}

export async function exportCalendar(me: Me, calendarId: string) {
  const c = await db.calendar.findUnique({ where: { id: calendarId }, include: { shares: true } });
  if (!c || c.ws !== me.ws || !atLeast(accessTo(me, c), "busy")) throw new HttpError(404, "Calendar not found");
  return { name: c.name, ics: buildIcs(await eventsOf(c.id, accessTo(me, c) === "busy"), { name: c.name }) };
}

/** The secret iCal link (read-only; private events show as busy). */
export async function feed(token: string) {
  if (!token || token.length < 16) return null;
  const c = await db.calendar.findFirst({ where: { feedToken: token } });
  if (!c) return null;
  return buildIcs(await eventsOf(c.id, false), { name: c.name });
}

/** Import an .ics file into one of my calendars (events already imported are updated, not doubled). */
export async function importIcs(me: Me, calendarId: string, text: string) {
  const c = await db.calendar.findUnique({ where: { id: calendarId }, include: { shares: true } });
  if (!c || c.ws !== me.ws || !atLeast(accessTo(me, c), "edit") || c.kind === "subscribed") throw new HttpError(403, "Pick a calendar you can add to.");
  return upsertIcs(me.ws, c.id, me.userId, text, me.tz);
}

async function upsertIcs(ws: string, calendarId: string, creatorId: string, text: string, tz: string) {
  const items = parseIcs(text, tz).filter((e) => e.status !== "CANCELLED").slice(0, 5000);
  if (!items.length) bad("No events found in that file.");
  let created = 0, updated = 0;
  const masters = items.filter((e) => !e.recurrenceId);
  const now = new Date();
  const ids = new Map<string, string>();
  for (const e of masters) {
    const key = `ics:${e.uid}`.slice(0, 250);
    const data = { title: e.summary, description: e.description, location: e.location, start: e.start, end: e.end, allDay: e.allDay, tz: e.tz, rrule: e.rrule && /^FREQ=/.test(e.rrule) ? e.rrule.replace(/;?WKST=[A-Z]{2}/, "") : null, exdates: e.exdates, conferenceUrl: e.url && /^https?:\/\//.test(e.url) ? e.url : null, updatedAt: now, syncedAt: now };
    const old = await db.event.findUnique({ where: { calendarId_googleId: { calendarId, googleId: key } } });
    const row = old ? await db.event.update({ where: { id: old.id }, data: { ...data, deletedAt: null } }) : await db.event.create({ data: { ws, calendarId, creatorId, googleId: key, ...data, createdAt: now } });
    ids.set(e.uid, row.id);
    if (old) updated++;
    else created++;
  }
  // Changed occurrences of imported series.
  for (const e of items.filter((x) => x.recurrenceId)) {
    const series = ids.get(e.uid);
    if (!series) continue;
    const key = `ics:${e.uid}:${e.recurrenceId!.toISOString()}`.slice(0, 250);
    const data = { title: e.summary, description: e.description, location: e.location, start: e.start, end: e.end, allDay: e.allDay, tz: e.tz, recurringId: series, originalStart: e.recurrenceId, updatedAt: now, syncedAt: now };
    const old = await db.event.findUnique({ where: { calendarId_googleId: { calendarId, googleId: key } } });
    if (old) await db.event.update({ where: { id: old.id }, data });
    else await db.event.create({ data: { ws, calendarId, creatorId, googleId: key, ...data, createdAt: now } });
  }
  return { created, updated, total: masters.length };
}

/** Public holiday calendars (Google's public iCal feeds). */
export const HOLIDAYS: Record<string, string> = {
  India: "en.indian", "United States": "en.usa", "United Kingdom": "en.uk", Canada: "en.canadian", Australia: "en.australian", Singapore: "en.singapore",
  "United Arab Emirates": "en.ae", Germany: "en.german", France: "en.french", Japan: "en.japanese", Brazil: "en.brazilian", "South Africa": "en.sa",
};
export const holidayUrl = (country: string) => (HOLIDAYS[country] ? `https://calendar.google.com/calendar/ical/${encodeURIComponent(`${HOLIDAYS[country]}#holiday@group.v.calendar.google.com`)}/public/basic.ics` : null);

/** Fetch a public iCal URL safely: https (or webcal), public addresses only, 5 MB at most. */
async function fetchIcs(url: string) {
  const u = new URL(url.replace(/^webcal:/i, "https:"));
  if (u.protocol !== "https:" && !(process.env.ICS_ALLOW_LOCAL === "1" && u.protocol === "http:")) bad("Use an https:// or webcal:// address.");
  if (process.env.ICS_ALLOW_LOCAL !== "1") {
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) bad("That address can't be reached.");
    for (const a of addrs) if (isPrivate(a.address)) bad("That address isn't on the public internet.");
  }
  const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { accept: "text/calendar, */*" } }).catch((e: Error) => {
    throw new HttpError(400, `Couldn't read the calendar: ${e.message}`);
  });
  if (!r.ok) throw new HttpError(400, `The calendar answered ${r.status}.`);
  const text = await r.text();
  if (text.length > 5_000_000) bad("That calendar is too big (5 MB at most).");
  if (!/BEGIN:VCALENDAR/.test(text)) bad("That address isn't an iCal calendar.");
  return text;
}
function isPrivate(ip: string) {
  if (net.isIPv6(ip)) return /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Subscribe to a calendar by URL (or a country's holidays); it refreshes every few hours and is read-only. */
export async function subscribe(me: Me, b: { url?: string; country?: string; name?: string; color?: string }) {
  const url = b.country ? holidayUrl(b.country) : String(b.url ?? "").trim();
  if (!url) bad(b.country ? "We don't have holidays for that country yet." : "Paste the calendar's iCal address.");
  const text = await fetchIcs(url);
  const name = str(b.name, 80) || (b.country ? `Holidays in ${b.country}` : /X-WR-CALNAME:(.+)/.exec(text)?.[1]?.trim().slice(0, 80) || new URL(url.replace(/^webcal:/i, "https:")).hostname);
  const c = await db.calendar.create({ data: { ws: me.ws, kind: "subscribed", ownerId: me.userId, primary: false, name, color: b.color && COLOR.test(b.color) ? b.color : b.country ? "#16a34a" : "#64748b", icsUrl: url, createdBy: me.userId, wsAccess: "none" } });
  const r = await upsertIcs(me.ws, c.id, me.userId, text, me.tz);
  await db.calendar.update({ where: { id: c.id }, data: { icsFetchedAt: new Date(), icsError: null } });
  return { calendar: c, ...r };
}

/** Background: refresh subscribed calendars older than 6 hours (or one now). */
export async function refreshSubscriptions(onlyId?: string) {
  const due = await db.calendar.findMany({ where: { kind: "subscribed", icsUrl: { not: null }, ...(onlyId ? { id: onlyId } : { OR: [{ icsFetchedAt: null }, { icsFetchedAt: { lt: new Date(Date.now() - 6 * 3_600_000) } }] }) }, take: 20 });
  for (const c of due) {
    try {
      const owner = await db.user.findUnique({ where: { id: c.ownerId ?? "" } });
      const text = await fetchIcs(c.icsUrl!);
      const before = new Date();
      await upsertIcs(c.ws, c.id, c.ownerId ?? c.createdBy, text, owner?.tz ?? "UTC");
      // Anything the source no longer has goes away.
      await db.event.updateMany({ where: { calendarId: c.id, syncedAt: { lt: before }, deletedAt: null }, data: { deletedAt: new Date() } });
      await db.calendar.update({ where: { id: c.id }, data: { icsFetchedAt: new Date(), icsError: null } });
    } catch (e) {
      await db.calendar.update({ where: { id: c.id }, data: { icsFetchedAt: new Date(), icsError: e instanceof Error ? e.message.slice(0, 200) : "Couldn't refresh" } });
    }
  }
  return due.length;
}

// ── Replies from people without an account ─────────────────────────────────

export async function rsvpView(token: string) {
  if (!token || token.length < 16) return null;
  const a = await db.attendee.findFirst({ where: { token }, include: { event: { include: { attendees: true } } } });
  if (!a || a.event.deletedAt) return null;
  const e = a.event;
  const org = await db.user.findUnique({ where: { id: e.creatorId }, select: { name: true, email: true } });
  return {
    title: e.title, when: when(e.start, e.end, e.allDay, e.tz), start: e.start, end: e.end, allDay: e.allDay, tz: e.tz,
    location: e.location, conferenceUrl: e.conferenceUrl, description: e.description, repeats: !!e.rrule, booking: !!e.bookingId,
    organizer: org?.name ?? org?.email ?? "The organizer", me: { email: a.email, name: a.name, response: a.response, comment: a.comment },
    guests: e.guestsSeeList ? e.attendees.map((x) => ({ name: x.name || x.email, response: x.response })) : [],
  };
}

export async function rsvpAnswer(token: string, b: { response?: string; comment?: string; proposeStart?: string; proposeEnd?: string }) {
  if (!token || token.length < 16) throw new HttpError(404, "This invitation is no longer available.");
  const a = await db.attendee.findFirst({ where: { token }, include: { event: true } });
  if (!a || a.event.deletedAt) throw new HttpError(404, "This invitation is no longer available.");
  if (!["yes", "no", "maybe"].includes(String(b.response))) bad("Reply yes, no or maybe.");
  const ps = b.proposeStart ? new Date(b.proposeStart) : null;
  const pe = b.proposeEnd ? new Date(b.proposeEnd) : null;
  if (ps && (isNaN(ps.getTime()) || !pe || isNaN(pe.getTime()) || pe <= ps)) bad("Propose a start and an end after it.");
  await db.attendee.update({ where: { id: a.id }, data: { response: String(b.response), comment: String(b.comment ?? "").slice(0, 500), proposedStart: ps, proposedEnd: pe } });
  const word = b.response === "yes" ? "Yes" : b.response === "no" ? "No" : "Maybe";
  await notify({ ws: a.event.ws, userId: a.event.creatorId, kind: "rsvp", title: ps ? `${a.name || a.email} proposed a new time: ${a.event.title}` : `${a.name || a.email} replied ${word}: ${a.event.title}`, body: ps ? ps.toISOString() : String(b.comment ?? ""), link: `/calendar?event=${a.event.id}` });
  return { ok: true, response: b.response };
}

// ── Attachments ────────────────────────────────────────────────────────────

const FILES = path.join(process.cwd(), "storage", "event-files");
export async function addEventFile(me: Me, eventId: string, file: File) {
  const ev = await loadEvent(me, eventId);
  if (!canEditEvent(me, ev, ev.calendar, ev.attendees)) throw new HttpError(403, "You can't change this event.");
  if (!file.size) bad("Choose a file.");
  if (file.size > 25 * 1024 * 1024) bad("Files can be up to 25 MB.");
  if ((await db.eventAttachment.count({ where: { eventId } })) >= 20) bad("An event can have up to 20 files.");
  const safe = (file.name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const rel = path.join(ev.id, `${crypto.randomUUID()}-${safe}`);
  await fs.mkdir(path.join(FILES, ev.id), { recursive: true });
  await fs.writeFile(path.join(FILES, rel), Buffer.from(await file.arrayBuffer()));
  const { path: _p, ...row } = await db.eventAttachment.create({ data: { eventId: ev.id, name: safe, type: file.type || "application/octet-stream", size: file.size, path: rel, userId: me.userId } });
  return row;
}
export async function listEventFiles(me: Me, eventId: string) {
  const ev = await loadEvent(me, eventId);
  const masked = ev.visibility === "private" && ev.creatorId !== me.userId && !ev.attendees.some((a) => a.userId === me.userId) && !atLeast(accessTo(me, ev.calendar), "edit");
  // The stored path stays on the server.
  return masked ? [] : db.eventAttachment.findMany({ where: { eventId }, orderBy: { createdAt: "asc" }, omit: { path: true } });
}
export async function readEventFile(me: Me, id: string) {
  const a = await db.eventAttachment.findUnique({ where: { id } });
  if (!a) throw new HttpError(404, "File not found");
  if (!(await listEventFiles(me, a.eventId)).some((x) => x.id === id)) throw new HttpError(404, "File not found");
  return { a, data: await fs.readFile(path.join(FILES, a.path)) };
}
export async function deleteEventFile(me: Me, id: string) {
  const a = await db.eventAttachment.findUnique({ where: { id } });
  if (!a) throw new HttpError(404, "File not found");
  const ev = await loadEvent(me, a.eventId);
  if (!canEditEvent(me, ev, ev.calendar, ev.attendees)) throw new HttpError(403, "You can't change this event.");
  await db.eventAttachment.delete({ where: { id } });
  await fs.rm(path.join(FILES, a.path), { force: true });
  return { ok: true };
}

// ── Booking pages ──────────────────────────────────────────────────────────

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "meet";

function cleanBooking(b: Record<string, unknown>, me: Me) {
  const title = str(b.title, 100);
  if (!title) bad("Give the booking page a title, e.g. 30-minute intro call.");
  const minutes = Math.round(Number(b.minutes ?? 30));
  if (!(minutes >= 5 && minutes <= 480)) bad("A meeting is 5 minutes to 8 hours.");
  const hours: Record<string, Range[]> = {};
  for (const [d, list] of Object.entries((b.hours ?? WEEKDAYS_9_6) as Record<string, Range[]>)) {
    if (!/^[0-6]$/.test(d) || !Array.isArray(list)) continue;
    const ok = list.filter((r) => HM.test(r.start) && HM.test(r.end) && r.start < r.end).slice(0, 4);
    if (ok.length) hours[d] = ok;
  }
  if (!Object.keys(hours).length) bad("Pick at least one day with available hours.");
  const questions = (Array.isArray(b.questions) ? b.questions : []).slice(0, 5).map((q: Record<string, unknown>, i) => ({ id: `q${i}`, label: str(q.label, 120), required: !!q.required })).filter((q) => q.label);
  return {
    title, description: str(b.description, 2000), minutes, hours,
    tz: typeof b.tz === "string" && isZone(b.tz) ? b.tz : me.tz,
    bufferMin: Math.max(0, Math.min(120, Math.round(Number(b.bufferMin ?? 0)) || 0)),
    noticeHours: Math.max(0, Math.min(720, Math.round(Number(b.noticeHours ?? 4)) || 0)),
    maxDays: Math.max(1, Math.min(365, Math.round(Number(b.maxDays ?? 60)) || 60)),
    maxPerDay: b.maxPerDay ? Math.max(1, Math.min(50, Math.round(Number(b.maxPerDay)))) : null,
    locationKind: ["meet", "phone", "place", "none"].includes(String(b.locationKind)) ? String(b.locationKind) : "meet",
    location: str(b.location, 300),
    questions,
    color: typeof b.color === "string" && COLOR.test(b.color) ? b.color : "#4f46e5",
    enabled: b.enabled !== false,
  };
}

export async function listBookings(me: Me) {
  const rows = await db.bookingPage.findMany({ where: { ws: me.ws, ownerId: me.userId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ ...r, url: `${EMAIL_ORIGIN}${BASE}/book/${r.slug}` }));
}
export async function saveBooking(me: Me, b: Record<string, unknown>) {
  const data = cleanBooking(b, me);
  if (typeof b.id === "string") {
    const r = await db.bookingPage.findUnique({ where: { id: b.id } });
    if (!r || r.ownerId !== me.userId) throw new HttpError(404, "Booking page not found");
    return db.bookingPage.update({ where: { id: r.id }, data });
  }
  let slug = slugify(`${me.name.split(" ")[0]}-${data.title}`);
  for (let i = 2; await db.bookingPage.findUnique({ where: { slug } }); i++) slug = `${slugify(`${me.name.split(" ")[0]}-${data.title}`)}-${i}`;
  return db.bookingPage.create({ data: { ws: me.ws, ownerId: me.userId, slug, ...data } });
}
export async function deleteBooking(me: Me, id: string) {
  await db.bookingPage.deleteMany({ where: { id, ownerId: me.userId } });
  return { ok: true };
}

/** Free slots on a booking page over the next days, skipping the owner's busy time. */
export async function bookingSlots(slug: string, fromDay?: string, days = 14) {
  const p = await db.bookingPage.findUnique({ where: { slug } });
  if (!p || !p.enabled) return null;
  const owner = await db.user.findUnique({ where: { id: p.ownerId } });
  const now = Date.now();
  const earliest = now + p.noticeHours * 3_600_000;
  const latest = now + p.maxDays * 86_400_000;
  const start = fromDay && /^\d{4}-\d{2}-\d{2}$/.test(fromDay) ? new Date(`${fromDay}T00:00:00Z`) : new Date(now);
  const t0 = partsIn(start, p.tz);
  const from = zonedToUtc(t0.y, t0.m, t0.d, 0, 0, p.tz);
  const to = new Date(from.getTime() + days * 86_400_000);
  const me = { userId: p.ownerId, ws: p.ws, owner: false, perms: {}, name: owner?.name ?? "", email: owner?.email ?? "", tz: owner?.tz ?? p.tz, sid: "booking" } as unknown as Me;
  const taken = (await occurrences(me, from, to)).filter((o) => o.transparency !== "free" && (o.myResponse === "yes" || o.myResponse === "maybe" || o.myResponse === "needs" || o.creatorId === p.ownerId) && !o.allDay);
  const ooo = (await occurrences(me, from, to)).filter((o) => o.eventType === "outOfOffice");
  const hours = p.hours as Record<string, Range[]>;
  const out: { day: string; slots: string[] }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * 86_400_000 + 12 * 3_600_000);
    const pd = partsIn(d, p.tz);
    const wd = new Date(Date.UTC(pd.y, pd.m - 1, pd.d)).getUTCDay();
    const dayKey = `${pd.y}-${String(pd.m).padStart(2, "0")}-${String(pd.d).padStart(2, "0")}`;
    const booked = taken.filter((o) => o.id && o.start.startsWith(dayKey)).length;
    const slots: string[] = [];
    if (!p.maxPerDay || booked < p.maxPerDay)
      for (const r of hours[String(wd)] ?? []) {
        const [sh, sm] = r.start.split(":").map(Number);
        const [eh, em] = r.end.split(":").map(Number);
        for (let m = sh * 60 + sm; m + p.minutes <= eh * 60 + em; m += p.minutes <= 30 ? 15 : 30) {
          const s = zonedToUtc(pd.y, pd.m, pd.d, Math.floor(m / 60), m % 60, p.tz);
          const e = new Date(s.getTime() + p.minutes * 60_000);
          if (s.getTime() < earliest || s.getTime() > latest) continue;
          const pad = p.bufferMin * 60_000;
          const clash = [...taken, ...ooo].some((o) => new Date(o.start).getTime() < e.getTime() + pad && new Date(o.end).getTime() > s.getTime() - pad);
          if (!clash) slots.push(s.toISOString());
        }
      }
    out.push({ day: dayKey, slots });
  }
  return { page: { title: p.title, description: p.description, minutes: p.minutes, tz: p.tz, owner: owner?.name ?? owner?.email ?? "", locationKind: p.locationKind, location: p.locationKind === "place" ? p.location : "", questions: p.questions, color: p.color }, days: out };
}

/** Book a slot: an event on the owner's calendar with the guest invited, a confirmation email and a cancel link. */
export async function book(slug: string, b: { start?: string; name?: string; email?: string; note?: string; answers?: Record<string, string> }, origin: Request) {
  const p = await db.bookingPage.findUnique({ where: { slug } });
  if (!p || !p.enabled) throw new HttpError(404, "This booking page isn't available.");
  const name = str(b.name, 120);
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad("Enter your name and email.");
  const start = new Date(String(b.start ?? ""));
  if (isNaN(start.getTime())) bad("Pick a time.");
  for (const q of p.questions as { id: string; label: string; required: boolean }[]) if (q.required && !str(b.answers?.[q.id], 1000)) bad(`Please answer: ${q.label}`);
  const pd = partsIn(start, p.tz);
  const avail = await bookingSlots(slug, `${pd.y}-${String(pd.m).padStart(2, "0")}-${String(pd.d).padStart(2, "0")}`, 1);
  if (!avail?.days[0]?.slots.includes(start.toISOString())) throw new HttpError(409, "That time was just taken. Please pick another.");
  const owner = await db.user.findUniqueOrThrow({ where: { id: p.ownerId } });
  const cal = (p.calendarId ? await db.calendar.findUnique({ where: { id: p.calendarId } }) : null) ?? (await db.calendar.findFirst({ where: { ws: p.ws, kind: "personal", ownerId: p.ownerId, primary: true } }));
  if (!cal) throw new HttpError(500, "The owner's calendar is missing.");
  const end = new Date(start.getTime() + p.minutes * 60_000);
  const answers = (p.questions as { id: string; label: string }[]).map((q) => (b.answers?.[q.id] ? `${q.label}: ${str(b.answers[q.id], 1000)}` : "")).filter(Boolean);
  const description = [`Booked through "${p.title}" by ${name} <${email}>.`, ...answers, b.note ? `Note: ${str(b.note, 2000)}` : ""].filter(Boolean).join("\n");
  const token = crypto.randomBytes(18).toString("base64url");
  const now = new Date();
  const me = { userId: owner.id, ws: p.ws, owner: false, perms: { "meetings.create": true, "meetings.open": true, "meetings.guests": true }, name: owner.name ?? owner.email, email: owner.email, tz: owner.tz, sid: "booking" } as unknown as Me;
  let conferenceUrl: string | null = null;
  let meetingId: string | null = null;
  if (p.locationKind === "meet") {
    try {
      const { meetingForEvent } = await import("./meet/meetings");
      const m = await meetingForEvent(me, origin, { title: `${p.title} with ${name}` });
      conferenceUrl = m?.url ?? null;
      meetingId = m?.id ?? null;
    } catch {
      conferenceUrl = null;
    }
  }
  const ev = await db.event.create({
    data: {
      ws: p.ws, calendarId: cal.id, creatorId: owner.id, title: `${p.title} with ${name}`, description, location: p.locationKind === "place" ? p.location : p.locationKind === "phone" ? `Phone: ${p.location || "the organizer will call you"}` : "",
      start, end, tz: p.tz, conferenceUrl, bookingId: p.id, reminders: [10], color: p.color, guestsSeeList: true, createdAt: now, updatedAt: now,
      attendees: { create: [{ email, name, response: "yes", token }] },
    },
  });
  if (meetingId) await (await import("./meet/meetings")).linkEvent(meetingId, ev.id).catch(() => {});
  await notify({ ws: p.ws, userId: owner.id, kind: "invite", title: `${name} booked ${p.title}`, body: start.toISOString(), link: `/calendar?event=${ev.id}` });
  const built = await icsFor(ev.id, "REQUEST");
  const whenText = when(start, end, false, p.tz);
  const manage = `${EMAIL_ORIGIN}${BASE}/rsvp/${token}`;
  await sendMail({
    to: email,
    subject: `Confirmed: ${p.title} with ${owner.name ?? owner.email} @ ${whenText}`,
    text: [`You're booked.`, "", `${p.title} with ${owner.name ?? owner.email}`, `When: ${whenText}`, ...(conferenceUrl ? [`Join: ${conferenceUrl}`] : []), ...(ev.location ? [`Where: ${ev.location}`] : []), "", `Need to change it? ${manage}`].join("\n"),
    ics: built ? { method: "REQUEST", content: built.ics } : undefined,
    fromName: owner.name ?? undefined,
  });
  return { ok: true, start: start.toISOString(), end: end.toISOString(), conferenceUrl, manage };
}

/** A guest cancels a booked meeting from their link. */
export async function cancelBooking(token: string) {
  if (!token || token.length < 16) throw new HttpError(404, "This booking isn't available.");
  const a = await db.attendee.findFirst({ where: { token }, include: { event: true } });
  if (!a || a.event.deletedAt || !a.event.bookingId) throw new HttpError(404, "This booking isn't available.");
  await db.event.update({ where: { id: a.event.id }, data: { deletedAt: new Date(), updatedAt: new Date() } });
  await notify({ ws: a.event.ws, userId: a.event.creatorId, kind: "rsvp", title: `${a.name || a.email} cancelled: ${a.event.title}`, link: "/calendar" });
  return { ok: true };
}

// ── Email reminders ────────────────────────────────────────────────────────

/** Background: email reminders that came due since the last run (once each, for organizer and workspace guests). */
export async function emailReminderTick(now = Date.now(), from = now - 60_000) {
  const evs = await db.event.findMany({ where: { deletedAt: null, emailReminders: { isEmpty: false } }, include: { attendees: true } });
  let sent = 0;
  for (const ev of evs) {
    const maxBefore = Math.max(...ev.emailReminders) * 60_000;
    for (const s of expand(ev, new Date(from), new Date(now + maxBefore + 60_000), 20)) {
      for (const mins of ev.emailReminders) {
        const at = s.getTime() - mins * 60_000;
        if (at <= from || at > now) continue;
        const people = [ev.creatorId, ...ev.attendees.filter((a) => a.userId && a.response !== "no").map((a) => a.userId!)];
        for (const uid of [...new Set(people)]) {
          const key = `email-rem:${ev.id}:${s.toISOString()}:${mins}:${uid}`;
          const fresh = await notify({ ws: ev.ws, userId: uid, kind: "reminder", title: `Reminder: ${ev.title}`, body: s.toISOString(), link: `/calendar?event=${ev.id}`, key });
          if (!fresh) continue;
          const u = await db.user.findUnique({ where: { id: uid } });
          if (u?.email) {
            const ok = await sendMail({ to: u.email, subject: `Reminder: ${ev.title} @ ${when(s, new Date(s.getTime() + (ev.end.getTime() - ev.start.getTime())), ev.allDay, u.tz || ev.tz)}`, text: [ev.title, when(s, new Date(s.getTime() + (ev.end.getTime() - ev.start.getTime())), ev.allDay, u.tz || ev.tz), ev.location, ev.conferenceUrl ? `Join: ${ev.conferenceUrl}` : ""].filter(Boolean).join("\n") });
            if (ok) sent++;
          }
        }
      }
    }
  }
  return sent;
}
