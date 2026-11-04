import type { Attendee } from "@prisma/client";
import { db } from "./db";
import type { Me } from "./auth";
import { BASE, EMAIL_ORIGIN } from "./env";
import { suiteCall } from "./suite";
import { buildIcs, type IcsOut } from "./ics";
import { expand } from "./rrule";

/**
 * Email for guests outside the workspace (people in it get the bell):
 * invitations, updates and cancellations as real calendar invites (.ics),
 * with Yes / No / Maybe links that work without an account.
 */

export const rsvpUrl = (token: string, r?: string) => `${EMAIL_ORIGIN}${BASE}/rsvp/${token}${r ? `?r=${r}` : ""}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function when(start: Date, end: Date, allDay: boolean, tz: string) {
  if (allDay) {
    const last = new Date(end.getTime() - 86_400_000);
    const f = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    return last.getTime() > start.getTime() ? `${f(start)} – ${f(last)} (all day)` : `${f(start)} (all day)`;
  }
  const d = start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: tz });
  const t = (x: Date) => x.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", timeZone: tz });
  return `${d}, ${t(start)} – ${t(end)} (${tz})`;
}

/** The event as an iCalendar invite for these guests. */
export async function icsFor(eventId: string, method: "REQUEST" | "CANCEL" | "PUBLISH", extraAttendees: Attendee[] = []) {
  const ev = await db.event.findUnique({ where: { id: eventId }, include: { attendees: true } });
  if (!ev) return null;
  const org = await db.user.findUnique({ where: { id: ev.creatorId } });
  const out: IcsOut = {
    uid: `${ev.recurringId ?? ev.id}@iotx`,
    title: ev.title,
    description: [ev.description, ev.conferenceUrl ? `Join: ${ev.conferenceUrl}` : ""].filter(Boolean).join("\n\n"),
    location: ev.location || ev.conferenceUrl || "",
    url: ev.conferenceUrl,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    rrule: ev.rrule,
    exdates: ev.exdates,
    recurrenceId: ev.recurringId ? ev.originalStart : null,
    organizer: org ? { email: org.email, name: org.name ?? org.email } : null,
    attendees: [...ev.attendees, ...extraAttendees].map((a) => ({ email: a.email, name: a.name, response: a.response })),
    sequence: Math.max(0, Math.floor((ev.updatedAt.getTime() - Date.UTC(2026, 0, 1)) / 1000)),
    status: method === "CANCEL" ? "CANCELLED" : "CONFIRMED",
    transparent: ev.transparency === "free",
    updated: ev.updatedAt,
  };
  return { ev, org, ics: buildIcs([out], { method }) };
}

/**
 * kind: invite (new guests), update (everyone outside), cancel.
 * only: just these addresses; skip: not these (e.g. just invited); removed: guests already taken off the list.
 */
export async function mailGuests(me: Me, eventId: string, kind: "invite" | "update" | "cancel", only?: string[], skip: string[] = [], removed: Attendee[] = []) {
  try {
    const built = await icsFor(eventId, kind === "cancel" ? "CANCEL" : "REQUEST", removed);
    if (!built) return 0;
    const { ev, ics } = built;
    const pool = [...ev.attendees, ...removed].filter((a) => !a.userId && a.email);
    const targets = pool.filter((a) => (!only || only.map((x) => x.toLowerCase()).includes(a.email.toLowerCase())) && !skip.map((x) => x.toLowerCase()).includes(a.email.toLowerCase()));
    let sent = 0;
    const whenText = when(ev.start, ev.end, ev.allDay, ev.tz);
    const series = ev.rrule ? " (repeats)" : "";
    for (const a of targets) {
      const subject = kind === "invite" ? `Invitation: ${ev.title} @ ${whenText}` : kind === "update" ? `Updated invitation: ${ev.title} @ ${whenText}` : `Cancelled: ${ev.title} @ ${whenText}`;
      const links = a.token && kind !== "cancel" ? { yes: rsvpUrl(a.token, "yes"), no: rsvpUrl(a.token, "no"), maybe: rsvpUrl(a.token, "maybe"), more: rsvpUrl(a.token) } : null;
      const lines = [
        kind === "cancel" ? `${me.name} cancelled this event.` : kind === "update" ? `${me.name} updated this event.` : `${me.name} invited you.`,
        "",
        ev.title,
        `When: ${whenText}${series}`,
        ...(ev.location ? [`Where: ${ev.location}`] : []),
        ...(ev.conferenceUrl ? [`Join: ${ev.conferenceUrl}`] : []),
        ...(ev.description ? ["", ev.description] : []),
        ...(links ? ["", `Going? Yes: ${links.yes}`, `No: ${links.no}`, `Maybe: ${links.maybe}`] : []),
      ];
      const btn = (href: string, label: string) => `<a href="${esc(href)}" style="display:inline-block;padding:8px 16px;margin-right:6px;border-radius:8px;border:1px solid #d4d4e0;color:#14152b;text-decoration:none;font-weight:600">${label}</a>`;
      const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:14px;color:#14152b;max-width:560px">
<p style="color:#6a6e8a;margin:0 0 10px">${esc(lines[0])}</p>
<h2 style="margin:0 0 8px;font-size:20px${kind === "cancel" ? ";text-decoration:line-through" : ""}">${esc(ev.title)}</h2>
<p style="margin:0 0 4px"><b>When</b> ${esc(whenText)}${series}</p>
${ev.location ? `<p style="margin:0 0 4px"><b>Where</b> ${esc(ev.location)}</p>` : ""}
${ev.conferenceUrl && kind !== "cancel" ? `<p style="margin:0 0 4px"><b>Join</b> <a href="${esc(ev.conferenceUrl)}">${esc(ev.conferenceUrl)}</a></p>` : ""}
${ev.description ? `<p style="white-space:pre-wrap;margin:12px 0">${esc(ev.description)}</p>` : ""}
${links ? `<p style="margin:16px 0 6px"><b>Going?</b></p><p>${btn(links.yes, "Yes")}${btn(links.no, "No")}${btn(links.maybe, "Maybe")}</p><p style="font-size:12px;color:#6a6e8a"><a href="${esc(links.more)}">More options</a>: add a note or propose a new time.</p>` : ""}
</div>`;
      const r = await suiteCall("/api/iotx/mail", { body: { to: a.email, subject, text: lines.join("\n"), html, ics: { method: kind === "cancel" ? "CANCEL" : "REQUEST", content: ics }, fromName: me.name } }).catch(() => null);
      if (r?.status === 200) sent++;
    }
    return sent;
  } catch (e) {
    console.error("calendar mail", e);
    return 0;
  }
}

/** Plain email to anyone (booking confirmations, reminders). */
export async function sendMail(m: { to: string; subject: string; text: string; html?: string; ics?: { method: string; content: string }; fromName?: string }) {
  const r = await suiteCall("/api/iotx/mail", { body: m }).catch(() => null);
  return r?.status === 200;
}

/** The next occurrence start of an event at or after `from` (for reminders on series). */
export function nextStart(ev: { start: Date; end: Date; allDay: boolean; tz: string; rrule: string | null; exdates: string[] }, from: Date, to: Date) {
  return expand(ev, from, to, 50)[0] ?? null;
}
