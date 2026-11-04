import crypto from "node:crypto";
import { db } from "./db";
import type { Me } from "./auth";
import { bad } from "./http";
import { expand } from "./rrule";
import type { Occurrence } from "./calendar";

/**
 * Calendar, round 2: the Birthdays calendar (people in the workspace who
 * share their birthday, plus Google contacts' birthdays) and public calendars
 * (a read-only page and iframe at /workspace/embed/<token>, free/busy only or
 * full details, never signed in).
 */

// ── Birthdays ──────────────────────────────────────────────────────────────

export const BIRTHDAYS_ID = "birthdays";
export const BIRTHDAY_COLOR = "#0b8043";

/** "1990-07-14", "--07-14" or "07-14" -> stored form ("YYYY-MM-DD" or "--MM-DD"); "" / null clears it. */
export function cleanBirthday(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const m = /^(?:(\d{4})-|--)?(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) bad("Enter a birthday as month and day (the year is optional).");
  const y = m[1] ? Number(m[1]) : null;
  const mo = Number(m[2]), d = Number(m[3]);
  const max = new Date(Date.UTC(2000, mo, 0)).getUTCDate(); // 2000 is a leap year: Feb 29 is fine
  if (mo < 1 || mo > 12 || d < 1 || d > max) bad("That date doesn't exist.");
  if (y !== null && (y < 1900 || y > new Date().getUTCFullYear())) bad("Check the year.");
  return y ? `${y}-${m[2]}-${m[3]}` : `--${m[2]}-${m[3]}`;
}

function parts(b: string) {
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(b);
  return m ? { year: m[1] ? Number(m[1]) : null, month: Number(m[2]), day: Number(m[3]) } : null;
}

/** The yearly dates of a birthday that fall in [from, to) (Feb 29 shows on Feb 28 in other years). */
function yearly(month: number, day: number, from: Date, to: Date) {
  const out: Date[] = [];
  for (let y = from.getUTCFullYear() - 1; y <= to.getUTCFullYear(); y++) {
    const leap = new Date(Date.UTC(y, 1, 29)).getUTCMonth() === 1;
    const at = new Date(Date.UTC(y, month - 1, month === 2 && day === 29 && !leap ? 28 : day));
    if (at < to && at.getTime() + 86_400_000 > from.getTime()) out.push(at);
  }
  return out;
}

/** The Birthdays calendar as it appears in the list (a calendar of its own, shown or hidden like any other). */
export async function birthdaysCalendar(me: Me) {
  const sub = await db.calendarSub.findUnique({ where: { userId_calendarId: { userId: me.userId, calendarId: BIRTHDAYS_ID } } });
  const st = await db.googleSync.findUnique({ where: { userId: me.userId }, select: { birthdaysAt: true, birthdaysError: true } });
  return {
    id: BIRTHDAYS_ID, kind: "birthdays", name: "Birthdays", description: "Birthdays people in the workspace share, and your Google contacts' birthdays.",
    color: sub?.color ?? BIRTHDAY_COLOR, primary: false, ownerId: me.userId, ownerName: null, access: "read", mine: false, other: false, hidden: !!sub?.hidden,
    icsUrl: null, icsError: st?.birthdaysError ?? null, icsFetchedAt: st?.birthdaysAt ?? null, feed: null,
  };
}

/** Yearly all-day entries: workspace people who share their birthday (and my own), and my Google contacts. */
export async function birthdayOccurrences(me: Me, from: Date, to: Date): Promise<Occurrence[]> {
  const sub = await db.calendarSub.findUnique({ where: { userId_calendarId: { userId: me.userId, calendarId: BIRTHDAYS_ID } } });
  const color = sub?.color ?? BIRTHDAY_COLOR;
  const members = await db.member.findMany({ where: { ws: me.ws }, select: { userId: true } });
  const users = await db.user.findMany({
    where: { id: { in: members.map((m) => m.userId) }, birthday: { not: null }, OR: [{ birthdayShare: "workspace" }, { id: me.userId }] },
    select: { id: true, name: true, email: true, birthday: true },
  });
  const contacts = await db.googleBirthday.findMany({ where: { userId: me.userId } });
  const entries: { key: string; title: string; month: number; day: number; year: number | null }[] = [];
  for (const u of users) {
    const p = parts(u.birthday!);
    if (!p) continue;
    const self = u.id === me.userId;
    // Others never see the year: only the day is shared.
    entries.push({ key: `u:${u.id}`, title: self ? "Your birthday" : `${u.name ?? u.email}'s birthday`, month: p.month, day: p.day, year: self ? p.year : null });
  }
  for (const c of contacts) entries.push({ key: `g:${c.resourceName}`, title: `${c.name}'s birthday`, month: c.month, day: c.day, year: c.year });
  const out: Occurrence[] = [];
  for (const e of entries)
    for (const at of yearly(e.month, e.day, from, to)) {
      const age = e.year ? at.getUTCFullYear() - e.year : null;
      out.push({
        id: `bday:${e.key}`, occ: at.toISOString(), seriesId: null, title: e.title, description: age && age > 0 ? `Turns ${age}` : "", location: "",
        start: at.toISOString(), end: new Date(at.getTime() + 86_400_000).toISOString(), allDay: true, tz: "UTC", rrule: "FREQ=YEARLY",
        calendarId: BIRTHDAYS_ID, color, reminders: [], emailReminders: [], conferenceUrl: null, creatorId: "", attendees: [], myResponse: null,
        canEdit: false, google: e.key.startsWith("g:"), visibility: "default", transparency: "free", eventType: "birthday", autoDecline: false, declineMessage: "",
        guestsCanModify: false, guestsCanInvite: false, guestsSeeList: false, masked: false, googleOrganizer: null,
      });
    }
  return out;
}

// ── Public calendars (embed) ──────────────────────────────────────────────

export type PublicMode = "none" | "busy" | "full";
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
export const newPublicToken = () => crypto.randomBytes(24).toString("base64url");

export type PublicEvent = { id: string; title: string; description: string; location: string; start: string; end: string; allDay: boolean; busy: boolean };

/** A public calendar's events in [from, to): free/busy only, or details (private events still "Busy"). Null when the link isn't public. */
export async function publicCalendar(token: string, from: Date, to: Date) {
  // An unguessable key with a length guard; no session, no cookies.
  if (!TOKEN.test(token)) return null;
  const c = await db.calendar.findFirst({ where: { publicToken: token } });
  if (!c || (c.publicMode !== "busy" && c.publicMode !== "full")) return null;
  const owner = c.ownerId ? await db.user.findUnique({ where: { id: c.ownerId }, select: { tz: true } }) : null;
  const evs = await db.event.findMany({
    where: { calendarId: c.id, deletedAt: null, eventType: { not: "workingLocation" }, OR: [{ rrule: { not: null } }, { AND: [{ start: { lt: to } }, { end: { gt: from } }] }] },
    select: { id: true, title: true, description: true, location: true, start: true, end: true, allDay: true, tz: true, rrule: true, exdates: true, recurringId: true, originalStart: true, visibility: true, transparency: true },
  });
  const changed = new Map<string, Set<number>>();
  for (const e of evs) if (e.recurringId && e.originalStart) changed.set(e.recurringId, (changed.get(e.recurringId) ?? new Set()).add(e.originalStart.getTime()));
  const out: PublicEvent[] = [];
  for (const e of evs) {
    // Free/busy pages don't show time marked as free.
    if (c.publicMode === "busy" && e.transparency === "free") continue;
    const busy = c.publicMode === "busy" || e.visibility === "private";
    const dur = e.end.getTime() - e.start.getTime();
    const starts = e.rrule ? expand(e, from, to).filter((s) => !changed.get(e.id)?.has(s.getTime())) : e.start < to && e.end > from ? [e.start] : [];
    for (const s of starts)
      out.push({
        id: `${e.id}:${s.getTime()}`,
        title: busy ? "Busy" : e.title,
        description: busy ? "" : e.description,
        location: busy ? "" : e.location,
        start: s.toISOString(),
        end: new Date(s.getTime() + dur).toISOString(),
        allDay: e.allDay,
        busy,
      });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return { calendar: { name: c.name, description: c.publicMode === "full" ? c.description : "", color: c.color, mode: c.publicMode as PublicMode, tz: owner?.tz ?? "UTC" }, events: out };
}
