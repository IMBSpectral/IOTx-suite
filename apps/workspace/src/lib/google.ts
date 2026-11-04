import type { Event } from "@prisma/client";
import { db } from "./db";
import { GOOGLE_API_BASE, SUITE_URL } from "./env";
import { dateOnly, partsIn, pad } from "./time";
import { findConference } from "./calendar";

/**
 * Two-way Google Calendar sync for one person's primary calendar.
 *
 * Tokens come from the suite (POST /api/iotx/google-token with the shared
 * service key): the suite already holds the Google connection, so there's no
 * second OAuth flow. Pull: a full import (3 months back, 12 ahead) that ends
 * with a syncToken, then incremental pulls with it (410 -> full again). Push:
 * every local change on their "My calendar" (insert, patch, delete) is written
 * to Google and the Google id kept on the row, so nothing duplicates. Latest
 * change wins: Google's `updated` against our `updatedAt`; our own writes are
 * recognised by `googleUpdated` and skipped when they echo back.
 */

class NoAccess extends Error {}

const tokens = new Map<string, { token: string; at: number }>();

async function token(userId: string, fresh = false): Promise<string | null> {
  const c = tokens.get(userId);
  if (!fresh && c && Date.now() - c.at < 5 * 60_000) return c.token;
  const r = await fetch(`${SUITE_URL}/api/iotx/google-token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-iotx-key": process.env.IOTX_SERVICE_KEY ?? "" },
    body: JSON.stringify({ userId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    tokens.delete(userId);
    return null;
  }
  const d = (await r.json()) as { accessToken?: string };
  if (!d.accessToken) return null;
  tokens.set(userId, { token: d.accessToken, at: Date.now() });
  return d.accessToken;
}

export async function hasCalendarAccess(userId: string) {
  try {
    return !!(await token(userId));
  } catch {
    return false;
  }
}

const EVENTS = (cal = "primary") => `${GOOGLE_API_BASE}/calendar/v3/calendars/${encodeURIComponent(cal)}/events`;
/** The People API (contacts' birthdays) lives on its own host; a test base (GOOGLE_API_BASE) serves both. */
const PEOPLE_BASE = (process.env.GOOGLE_PEOPLE_API_BASE ?? (process.env.GOOGLE_API_BASE ? GOOGLE_API_BASE : "https://people.googleapis.com")).replace(/\/$/, "");

async function gfetch(userId: string, url: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<{ status: number; data: any }> {
  const t = await token(userId);
  if (!t) throw new NoAccess("Google Calendar isn't connected.");
  const r = await fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${t}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 401 && retry) {
    await token(userId, true);
    return gfetch(userId, url, init, false);
  }
  const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { status: r.status, data };
}

type GTime = { dateTime?: string; date?: string; timeZone?: string };
type GEvent = {
  id: string;
  status?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GTime;
  end?: GTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GTime;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; self?: boolean; organizer?: boolean }[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
};

const RESP: Record<string, string> = { accepted: "yes", declined: "no", tentative: "maybe", needsAction: "needs" };
const RESP_BACK: Record<string, string> = { yes: "accepted", no: "declined", maybe: "tentative", needs: "needsAction" };

function gtime(t: GTime | undefined): { at: Date; allDay: boolean; tz?: string } | null {
  if (!t) return null;
  if (t.date) return { at: dateOnly(t.date), allDay: true };
  if (t.dateTime) return { at: new Date(t.dateTime), allDay: false, tz: t.timeZone };
  return null;
}

/** "EXDATE;TZID=Asia/Kolkata:20261027T090000,20261103T090000" -> UTC ISO list. */
function parseExdates(lines: string[], tz: string) {
  const out: string[] = [];
  for (const l of lines) {
    if (!/^EXDATE/i.test(l)) continue;
    const [head, vals] = l.split(":");
    const z = /TZID=([^;:]+)/i.exec(head)?.[1] ?? tz;
    for (const v of (vals ?? "").split(",")) {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
      if (!m) continue;
      if (!m[4]) out.push(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString());
      else if (m[7]) out.push(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString());
      else {
        // Wall clock in a zone.
        const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        const p = partsIn(guess, z);
        const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - guess;
        out.push(new Date(guess - off).toISOString());
      }
    }
  }
  return out;
}

function stamp(d: Date, allDay: boolean) {
  const p = (n: number) => pad(n);
  return allDay
    ? `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    : `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function toGoogle(ev: Event & { attendees: { email: string; name: string; response: string }[] }) {
  const date = (d: Date) => d.toISOString().slice(0, 10);
  const recurrence: string[] = [];
  if (ev.rrule) {
    recurrence.push(`RRULE:${ev.rrule}`);
    if (ev.exdates.length)
      recurrence.push(
        ev.allDay
          ? `EXDATE;VALUE=DATE:${ev.exdates.map((x) => stamp(new Date(x), true)).join(",")}`
          : `EXDATE:${ev.exdates.map((x) => stamp(new Date(x), false)).join(",")}`,
      );
  }
  return {
    summary: ev.title,
    description: ev.description || undefined,
    location: ev.location || undefined,
    start: ev.allDay ? { date: date(ev.start) } : { dateTime: ev.start.toISOString(), timeZone: ev.tz },
    end: ev.allDay ? { date: date(ev.end) } : { dateTime: ev.end.toISOString(), timeZone: ev.tz },
    ...(recurrence.length ? { recurrence } : {}),
    ...(ev.attendees.length ? { attendees: ev.attendees.map((a) => ({ email: a.email, displayName: a.name || undefined, responseStatus: RESP_BACK[a.response] ?? "needsAction" })) } : {}),
  };
}

async function personalCalendar(ws: string, userId: string) {
  return db.calendar.findFirst({ where: { ws, kind: "personal", ownerId: userId, primary: true } });
}

/** Which Google calendar a workspace calendar writes to: "primary" for their main one, a picked Google calendar for a linked one, else none. */
async function googleCalFor(calendarId: string): Promise<string | null> {
  const cal = await db.calendar.findUnique({ where: { id: calendarId } });
  if (cal?.kind === "personal" && cal.primary && cal.ownerId) return "primary";
  const link = await db.googleCalLink.findFirst({ where: { calendarId } });
  return link && !link.readOnly ? link.googleCalId : null;
}

/** Write one local event to Google (insert, patch or delete). */
export async function pushEvent(userId: string, eventId: string) {
  const ev = await db.event.findUnique({ where: { id: eventId }, include: { attendees: true } });
  if (!ev) return;
  const now = new Date();
  const gcal = await googleCalFor(ev.calendarId);
  // Not synced with Google, or a working-location marker (it stays in the strip here): nothing to write.
  if (!gcal || (ev.eventType === "workingLocation" && !ev.googleId)) {
    if (!ev.syncedAt || ev.updatedAt > ev.syncedAt) await db.event.update({ where: { id: ev.id }, data: { syncedAt: now } });
    return;
  }
  if (ev.deletedAt) {
    if (ev.googleId) {
      const r = await gfetch(userId, `${EVENTS(gcal)}/${encodeURIComponent(ev.googleId)}`, { method: "DELETE" });
      if (r.status >= 300 && r.status !== 404 && r.status !== 410) throw new Error(`Google delete answered ${r.status}`);
    }
    await db.event.update({ where: { id: ev.id }, data: { googleId: null, syncedAt: now } });
    return;
  }
  // Someone else organizes it: only my reply goes back (Google keeps the rest theirs).
  if (ev.googleOrganizer) {
    if (!ev.googleId || !ev.googleSelfEmail || !ev.rsvpSelf) {
      await db.event.update({ where: { id: ev.id }, data: { syncedAt: now } });
      return;
    }
    const attendees = [
      ...ev.attendees.map((a) => ({ email: a.email, displayName: a.name || undefined, responseStatus: RESP_BACK[a.response] ?? "needsAction" })),
      { email: ev.googleSelfEmail, self: true, responseStatus: RESP_BACK[ev.rsvpSelf] ?? "needsAction" },
    ];
    const r = await gfetch(userId, `${EVENTS(gcal)}/${encodeURIComponent(ev.googleId)}`, { method: "PATCH", body: { attendees } });
    if (r.status >= 300) throw new Error(`Google answered ${r.status}: ${r.data?.error?.message ?? ""}`);
    const g = r.data as GEvent;
    await db.event.update({ where: { id: ev.id }, data: { googleUpdated: g.updated ? new Date(g.updated) : now, syncedAt: new Date() } });
    return;
  }
  let gid = ev.googleId;
  if (!gid && ev.recurringId && ev.originalStart) {
    const s = await db.event.findUnique({ where: { id: ev.recurringId } });
    if (!s?.googleId) return; // the series goes first
    gid = `${s.googleId}_${stamp(ev.originalStart, s.allDay)}`;
  }
  const body = toGoogle(ev);
  let r = gid ? await gfetch(userId, `${EVENTS(gcal)}/${encodeURIComponent(gid)}`, { method: "PATCH", body }) : null;
  if (!r || r.status === 404 || r.status === 410) {
    if (ev.recurringId) return;
    r = await gfetch(userId, EVENTS(gcal), { method: "POST", body });
  }
  if (r.status >= 300) throw new Error(`Google answered ${r.status}: ${r.data?.error?.message ?? ""}`);
  const g = r.data as GEvent;
  await db.event.update({
    where: { id: ev.id },
    data: { googleId: g.id, googleUpdated: g.updated ? new Date(g.updated) : now, syncedAt: new Date(), ...(g.hangoutLink && !ev.conferenceUrl ? { conferenceUrl: g.hangoutLink } : {}) },
  });
}

/** Local changes on their calendar that haven't reached Google yet. */
async function pushPending(userId: string, calendarId: string) {
  const rows = await db.event.findMany({
    where: { calendarId, OR: [{ deletedAt: { not: null }, googleId: { not: null } }, { deletedAt: null, syncedAt: null }, { deletedAt: null }] },
    orderBy: [{ recurringId: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true, updatedAt: true, syncedAt: true, deletedAt: true, googleId: true },
  });
  let pushed = 0;
  for (const e of rows) {
    const pending = e.deletedAt ? !!e.googleId : !e.syncedAt || e.updatedAt > e.syncedAt;
    if (!pending) continue;
    await pushEvent(userId, e.id);
    pushed++;
  }
  return pushed;
}

async function applyItem(ws: string, calendarId: string, tz: string, item: GEvent) {
  const now = new Date();
  const updated = item.updated ? new Date(item.updated) : now;
  if (item.status === "cancelled") {
    if (item.recurringEventId) {
      const series = await db.event.findFirst({ where: { calendarId, googleId: item.recurringEventId } });
      const o = gtime(item.originalStartTime);
      if (series && o) {
        const iso = o.at.toISOString();
        if (!series.exdates.includes(iso)) await db.event.update({ where: { id: series.id }, data: { exdates: [...series.exdates, iso], updatedAt: now, syncedAt: now } });
      }
      await db.event.updateMany({ where: { calendarId, googleId: item.id, deletedAt: null }, data: { deletedAt: now, googleId: null, updatedAt: now, syncedAt: now } });
      return "deleted";
    }
    const local = await db.event.findFirst({ where: { calendarId, googleId: item.id } });
    if (!local) return "skip";
    await db.event.updateMany({ where: { OR: [{ id: local.id }, { recurringId: local.id }], deletedAt: null }, data: { deletedAt: now, updatedAt: now, syncedAt: now } });
    await db.event.update({ where: { id: local.id }, data: { googleId: null } });
    return "deleted";
  }
  const local = await db.event.findFirst({ where: { calendarId, googleId: item.id } });
  if (local) {
    if (local.googleUpdated && updated <= local.googleUpdated) return "skip"; // our own write echoing back
    const pendingLocal = !local.syncedAt || local.updatedAt > local.syncedAt;
    if (pendingLocal && local.updatedAt > updated) return "skip"; // local change is newer: it will be pushed
  }
  const s = gtime(item.start);
  const e = gtime(item.end);
  if (!s) return "skip";
  const allDay = s.allDay;
  const evTz = s.tz ?? tz;
  const rec = item.recurrence ?? [];
  const rrule = rec.find((l) => /^RRULE:/i.test(l))?.replace(/^RRULE:/i, "") ?? null;
  const conf = item.hangoutLink ?? item.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? findConference(item.location, item.description);
  let recurringId: string | null = null;
  let originalStart: Date | null = null;
  if (item.recurringEventId) {
    const series = await db.event.findFirst({ where: { calendarId, googleId: item.recurringEventId } });
    recurringId = series?.id ?? null;
    originalStart = gtime(item.originalStartTime)?.at ?? null;
    if (!recurringId) return "skip"; // outside the window; the series wasn't imported
  }
  const cal = await db.calendar.findUnique({ where: { id: calendarId } });
  // Invited by someone else in Google: remember who organizes it and my reply there.
  const self = item.attendees?.find((a) => a.self);
  const guest = !!item.organizer && !item.organizer.self;
  const data = {
    googleOrganizer: guest ? (item.organizer!.displayName || item.organizer!.email || "Someone").slice(0, 200) : null,
    rsvpSelf: guest ? (RESP[self?.responseStatus ?? ""] ?? "needs") : null,
    googleSelfEmail: self?.email?.toLowerCase() ?? null,
    title: item.summary?.slice(0, 300) || "(No title)",
    description: (item.description ?? "").slice(0, 8000),
    location: (item.location ?? "").slice(0, 500),
    start: s.at,
    end: e?.at ?? new Date(s.at.getTime() + (allDay ? 86_400_000 : 3_600_000)),
    allDay,
    tz: evTz,
    rrule: rrule && /^FREQ=/i.test(rrule) ? rrule.toUpperCase() : null,
    exdates: parseExdates(rec, evTz),
    recurringId,
    originalStart,
    conferenceUrl: conf ?? null,
    googleId: item.id,
    googleUpdated: updated,
    deletedAt: null,
    updatedAt: now,
    syncedAt: now,
  };
  let row: Event;
  if (local) row = await db.event.update({ where: { id: local.id }, data });
  else row = await db.event.create({ data: { ws, calendarId, creatorId: cal?.ownerId ?? "", ...data, createdAt: now } });
  // Guests: emails, mapped to workspace people where they match.
  if (item.attendees) {
    const owner = cal?.ownerId ? await db.user.findUnique({ where: { id: cal.ownerId } }) : null;
    const list = item.attendees.filter((a) => a.email && !a.self && a.email.toLowerCase() !== owner?.email.toLowerCase());
    await db.attendee.deleteMany({ where: { eventId: row.id, email: { notIn: list.map((a) => a.email!.toLowerCase()) } } });
    for (const a of list) {
      const email = a.email!.toLowerCase();
      const u = await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
      const isMember = u ? await db.member.findUnique({ where: { ws_userId: { ws, userId: u.id } } }) : null;
      await db.attendee.upsert({
        where: { eventId_email: { eventId: row.id, email } },
        create: { eventId: row.id, email, name: a.displayName ?? "", userId: isMember ? u!.id : null, response: RESP[a.responseStatus ?? ""] ?? "needs" },
        update: { response: RESP[a.responseStatus ?? ""] ?? "needs" },
      });
    }
  }
  return local ? "updated" : "created";
}

const running = new Map<string, Promise<unknown>>();

/** Pull then push for one person. Serialised per person. */
export function syncUser(userId: string, ws: string) {
  const key = `${ws}:${userId}`;
  const prev = running.get(key);
  if (prev) return prev as ReturnType<typeof doSync>;
  const p = doSync(userId, ws).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

type Stats = { created: number; updated: number; deleted: number; pushed: number };

/** Pull one Google calendar into one workspace calendar: a full import (3 months back, 12 ahead) or the changes since syncToken. */
async function pullCalendar(userId: string, ws: string, tz: string, calendarId: string, gcal: string, token: string | null, stats: Stats) {
  let syncToken = token;
  let pageToken: string | undefined;
  let next: string | undefined;
  for (let page = 0; page < 50; page++) {
    const p = new URLSearchParams({ maxResults: "250" });
    if (syncToken) p.set("syncToken", syncToken);
    else {
      p.set("timeMin", new Date(Date.now() - 92 * 86_400_000).toISOString());
      p.set("timeMax", new Date(Date.now() + 366 * 86_400_000).toISOString());
      p.set("singleEvents", "false");
    }
    if (pageToken) p.set("pageToken", pageToken);
    const r = await gfetch(userId, `${EVENTS(gcal)}?${p}`);
    if (r.status === 410 && syncToken) {
      syncToken = null;
      pageToken = undefined;
      continue;
    }
    if (r.status >= 300) throw new Error(r.data?.error?.message ?? `Google answered ${r.status}`);
    const d = r.data as { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string };
    // Series before their changed occurrences.
    const items = [...(d.items ?? [])].sort((a, b) => Number(!!a.recurringEventId) - Number(!!b.recurringEventId));
    for (const it of items) {
      const res = await applyItem(ws, calendarId, tz, it);
      if (res !== "skip") stats[res]++;
    }
    if (d.nextPageToken) pageToken = d.nextPageToken;
    else {
      next = d.nextSyncToken;
      break;
    }
  }
  return next ?? syncToken;
}

async function doSync(userId: string, ws: string) {
  const cal = await personalCalendar(ws, userId);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!cal || !user) return { ok: false, error: "No calendar" };
  const state = await db.googleSync.upsert({ where: { userId }, create: { userId, ws, calendarId: cal.id }, update: {} });
  const stats: Stats = { created: 0, updated: 0, deleted: 0, pushed: 0 };
  try {
    const next = await pullCalendar(userId, ws, user.tz, cal.id, "primary", state.calendarId === cal.id ? state.syncToken : null, stats);
    stats.pushed = await pushPending(userId, cal.id);
    await db.googleSync.update({ where: { userId }, data: { syncToken: next, calendarId: cal.id, lastSyncAt: new Date(), error: null } });
  } catch (e) {
    const msg = e instanceof NoAccess ? "reconnect" : (e as Error).message;
    await db.googleSync.update({ where: { userId }, data: { error: msg.slice(0, 500) } });
    return { ok: false, error: msg, ...stats };
  }
  // The other Google calendars they picked, each into its own workspace calendar.
  for (const l of await db.googleCalLink.findMany({ where: { userId, ws } })) {
    if (!(await db.calendar.findUnique({ where: { id: l.calendarId } }))) {
      await db.googleCalLink.delete({ where: { id: l.id } });
      continue;
    }
    try {
      const t = await pullCalendar(userId, ws, user.tz, l.calendarId, l.googleCalId, l.syncToken, stats);
      if (!l.readOnly) stats.pushed += await pushPending(userId, l.calendarId);
      await db.googleCalLink.update({ where: { id: l.id }, data: { syncToken: t, lastSyncAt: new Date(), error: null } });
    } catch (e) {
      await db.googleCalLink.update({ where: { id: l.id }, data: { error: (e as Error).message.slice(0, 500) } });
    }
  }
  // Contacts' birthdays: once a day.
  if (!state.birthdaysAt || Date.now() - state.birthdaysAt.getTime() > 86_400_000) await syncBirthdays(userId).catch(() => {});
  return { ok: true, ...stats };
}

// ── More Google calendars ─────────────────────────────────────────────────

type GCal = { id: string; summary?: string; summaryOverride?: string; primary?: boolean; backgroundColor?: string; accessRole?: string };

/** Their Google calendars, with the workspace calendar each one syncs into (if any). */
export async function googleCalendars(userId: string, ws: string) {
  const r = await gfetch(userId, `${GOOGLE_API_BASE}/calendar/v3/users/me/calendarList?maxResults=250`);
  if (r.status >= 300) throw new Error(r.data?.error?.message ?? `Google answered ${r.status}`);
  const links = await db.googleCalLink.findMany({ where: { userId, ws } });
  return ((r.data?.items ?? []) as GCal[]).map((c) => {
    const l = links.find((x) => x.googleCalId === c.id);
    return {
      id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, color: c.backgroundColor ?? null, accessRole: c.accessRole ?? "reader",
      link: l ? { calendarId: l.calendarId, readOnly: l.readOnly, lastSyncAt: l.lastSyncAt, error: l.error } : null,
    };
  });
}

/** Sync one more Google calendar into a new calendar ("new") or one of their own (not the main one). */
export async function linkGoogleCalendar(userId: string, ws: string, googleCalId: string, target: string) {
  const list = await googleCalendars(userId, ws);
  const g = list.find((c) => c.id === googleCalId);
  if (!g) throw new Error("That Google calendar isn't in your list.");
  if (g.primary) throw new Error("Your main Google calendar already syncs with My calendar.");
  let calendarId = target;
  if (target === "new") {
    if ((await db.calendar.count({ where: { ownerId: userId, kind: "personal" } })) >= 25) throw new Error("You can have up to 25 calendars.");
    const c = await db.calendar.create({ data: { ws, kind: "personal", ownerId: userId, primary: false, name: g.name.slice(0, 80), color: g.color && /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : "#0d9488", createdBy: userId } });
    calendarId = c.id;
  } else {
    const c = await db.calendar.findUnique({ where: { id: target } });
    if (!c || c.ws !== ws || c.kind !== "personal" || c.ownerId !== userId || c.primary) throw new Error("Pick one of your own calendars (not My calendar).");
    if (await db.googleCalLink.findFirst({ where: { calendarId: c.id, NOT: { googleCalId } } })) throw new Error("That calendar already syncs with another Google calendar.");
  }
  const readOnly = !["owner", "writer"].includes(g.accessRole);
  await db.googleCalLink.upsert({
    where: { userId_googleCalId: { userId, googleCalId } },
    create: { userId, ws, googleCalId, calendarId, name: g.name.slice(0, 200), readOnly },
    update: { calendarId, readOnly, name: g.name.slice(0, 200), syncToken: null, error: null },
  });
  await db.googleSync.upsert({ where: { userId }, create: { userId, ws, calendarId: (await personalCalendar(ws, userId))?.id ?? calendarId }, update: {} });
  return { calendarId, readOnly };
}

/** Stop syncing a Google calendar (the workspace calendar and its events stay). */
export async function unlinkGoogleCalendar(userId: string, googleCalId: string) {
  await db.googleCalLink.deleteMany({ where: { userId, googleCalId } });
  return { ok: true };
}

// ── Contacts' birthdays (People API) ──────────────────────────────────────

type GPerson = { resourceName?: string; names?: { displayName?: string }[]; birthdays?: { date?: { year?: number; month?: number; day?: number } }[] };

/** Read their Google contacts' birthdays into the Birthdays calendar (needs the contacts permission on the Google connection). */
export async function syncBirthdays(userId: string) {
  const people: { resourceName: string; name: string; month: number; day: number; year: number | null }[] = [];
  let pageToken = "";
  for (let page = 0; page < 20; page++) {
    const p = new URLSearchParams({ personFields: "names,birthdays", pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const r = await gfetch(userId, `${PEOPLE_BASE}/v1/people/me/connections?${p}`);
    if (r.status === 403 || r.status === 401) {
      const msg = "Contacts' birthdays need the Google contacts permission: reconnect Google and allow contacts.";
      await db.googleSync.updateMany({ where: { userId }, data: { birthdaysAt: new Date(), birthdaysError: msg } });
      return { ok: false, error: msg };
    }
    if (r.status >= 300) throw new Error(r.data?.error?.message ?? `Google answered ${r.status}`);
    for (const c of (r.data?.connections ?? []) as GPerson[]) {
      const d = c.birthdays?.find((b) => b.date?.month && b.date?.day)?.date;
      if (!c.resourceName || !d?.month || !d.day || d.month > 12 || d.day > 31) continue;
      people.push({ resourceName: c.resourceName.slice(0, 200), name: (c.names?.[0]?.displayName || "A contact").slice(0, 200), month: d.month, day: d.day, year: d.year && d.year > 1900 ? d.year : null });
    }
    pageToken = r.data?.nextPageToken ?? "";
    if (!pageToken) break;
  }
  await db.googleBirthday.deleteMany({ where: { userId } });
  if (people.length) await db.googleBirthday.createMany({ data: people.map((p) => ({ userId, ...p })), skipDuplicates: true });
  await db.googleSync.updateMany({ where: { userId }, data: { birthdaysAt: new Date(), birthdaysError: null } });
  return { ok: true, count: people.length };
}

/** After a local change: push it now if this person syncs with Google (best effort). */
export async function afterLocalChange(userId: string, ws: string, eventId: string, canGoogle: boolean) {
  if (!canGoogle) return;
  const ev = await db.event.findUnique({ where: { id: eventId }, include: { calendar: true } });
  if (!ev || ev.calendar.kind !== "personal" || !ev.calendar.ownerId) return;
  const owner = ev.calendar.ownerId;
  const st = await db.googleSync.findUnique({ where: { userId: owner } });
  if (!st) return; // never synced: the first sync pushes everything
  try {
    await pushEvent(owner, ev.id);
    if (ev.recurringId) await pushEvent(owner, ev.recurringId);
  } catch (e) {
    await db.googleSync.update({ where: { userId: owner }, data: { error: (e as Error).message.slice(0, 500) } }).catch(() => {});
  }
}
