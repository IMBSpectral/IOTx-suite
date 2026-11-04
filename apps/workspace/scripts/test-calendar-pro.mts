/**
 * Calendar at Google Calendar parity: settings and working hours, more
 * calendars, sharing (free/busy, details, edit), other people's calendars,
 * private and free events, out of office with auto-decline, "this and
 * following", replies with notes and proposed times, invitations and replies
 * for outside guests (email + link), search, iCal export / import / feed,
 * attachments, booking pages and email reminders.
 *   npx tsx scripts/test-calendar-pro.mts <devToken> <test-users.json>
 */
import fs from "node:fs";
import { check, envOf, OWNER, setup, signIn, summary, WS, ws } from "./lib.mts";

const KEY = envOf(new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")).IOTX_SERVICE_KEY;
const OUTBOX = new URL("../../../projects-data/_forge/outbox.jsonl", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const { MEMBER } = await setup();
const O = await signIn(OWNER);
const M = await signIn(MEMBER);
const oid = (await ws("/me", undefined, O)).json.me.id as string;
const mid = (await ws("/me", undefined, M)).json.me.id as string;
const day = (n: number, h = 10, mi = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(h, mi, 0, 0);
  return d.toISOString();
};
const made: string[] = [];
const cals: string[] = [];
let mainId = "";
const ev = async (b: Record<string, unknown>, who = O) => {
  const r = await ws("/calendar/events", b, who);
  if (r.json.event?.id) made.push(r.json.event.id);
  return r;
};
const range = async (who: string, from = day(-2), to = day(40)) => (await ws(`/calendar?from=${from}&to=${to}&sync=0`, undefined, who)).json;
const stamp = Date.now().toString(36);

try {
  // ── Settings
  const st = await ws("/calendar/settings", { weekStart: 0, timeFormat: "24", defaultMinutes: 30, defaultReminders: [5, 30], secondTz: "America/New_York", hours: { "1": [{ start: "10:00", end: "17:00" }], "2": [{ start: "10:00", end: "17:00" }] } }, M, "PUT");
  check("save calendar settings (week start, 24h, default length, reminders, 2nd zone, hours)", st.json.settings?.weekStart === 0 && st.json.settings.timeFormat === "24" && st.json.settings.defaultMinutes === 30 && st.json.settings.secondTz === "America/New_York" && st.json.settings.hours["1"][0].start === "10:00", st.json);
  check("a bad time zone is ignored", (await ws("/calendar/settings", { secondTz: "Mars/Base" }, M, "PUT")).json.settings.secondTz === null);

  // ── More calendars and sharing
  const side = await ws("/calendar/calendars", { name: `Side ${stamp}`, color: "#0d9488" }, O);
  cals.push(side.json.calendar?.id);
  check("make another personal calendar", side.status === 201 && side.json.calendar.primary === false);
  const list0 = (await ws("/calendar/calendars", undefined, O)).json.calendars as any[];
  const mainO = list0.find((c) => c.kind === "personal" && c.primary && c.mine);
  mainId = mainO?.id ?? "";
  check("calendars carry my access", mainO?.access === "owner" && list0.some((c) => c.id === side.json.calendar.id && c.access === "owner"));
  check("the main calendar can't be deleted", (await ws(`/calendar/calendars?id=${mainO.id}`, undefined, O, "DELETE")).status === 400);

  const priv = await ev({ title: `Dentist ${stamp}`, start: day(3, 9), end: day(3, 10), visibility: "private" });
  const pub = await ev({ title: `Roadmap review ${stamp}`, start: day(3, 11), end: day(3, 12) });
  const free = await ev({ title: `Lunch maybe ${stamp}`, start: day(3, 13), end: day(3, 14), transparency: "free" });
  // By default colleagues see free/busy only.
  check("add a colleague's calendar to my list", (await ws("/calendar/others", { userId: oid }, M)).json.access === "busy");
  let mine = (await range(M)).events as any[];
  const seenPub = mine.find((e) => e.id === pub.json.event.id);
  check("by default a colleague sees only that I'm busy", seenPub?.title === "Busy" && seenPub.masked === true && seenPub.description === "");
  const busy = (await ws(`/calendar/busy?users=${oid}&from=${day(3, 0)}&to=${day(4, 0)}`, undefined, M)).json.busy?.[oid] as any[] | undefined;
  check("free events don't count as busy", !!busy && !busy.some((b) => b.start === free.json.event.start));
  // Share with details.
  const sh = await ws("/calendar/calendars", { id: mainO.id, shares: [{ userId: mid, role: "read" }] }, O, "PATCH");
  check("share my calendar with a colleague (see all details)", sh.json.calendar?.shares?.some((s: any) => s.userId === mid && s.role === "read"), sh.json);
  mine = (await range(M)).events as any[];
  check("now they see event details", mine.find((e) => e.id === pub.json.event.id)?.title === `Roadmap review ${stamp}`);
  check("but a private event still shows as busy", mine.find((e) => e.id === priv.json.event.id)?.title === "Busy");
  check("they can't edit with read access", (await ws(`/calendar/events/${pub.json.event.id}`, { title: "x" }, M, "PATCH")).status === 403);
  await ws("/calendar/calendars", { id: mainO.id, shares: [{ userId: mid, role: "edit" }] }, O, "PATCH");
  check("with edit access they can change events", (await ws(`/calendar/events/${pub.json.event.id}`, { description: "Agenda: Q4" }, M, "PATCH")).status === 200);
  check("only managers change sharing", (await ws("/calendar/calendars", { id: mainO.id, shares: [] }, M, "PATCH")).status === 403);
  await ws("/calendar/calendars", { id: mainO.id, shares: [] }, O, "PATCH");

  // ── Out of office with auto-decline
  const ooo = await ev({ title: "Out of office", start: day(5, 0), end: day(6, 0), eventType: "outOfOffice", autoDecline: true, declineMessage: "On leave, back Monday" }, M);
  const inv = await ev({ title: `Planning ${stamp}`, start: day(5, 11), end: day(5, 12), attendees: [{ userId: mid }] });
  const a1 = (await ws(`/calendar/events/${inv.json.event.id}`, undefined, O)).json.event.attendees.find((a: any) => a.userId === mid);
  check("an invitation during out of office is declined automatically, with the message", a1?.response === "no" && /On leave/.test(a1.comment), a1);
  check("the organizer is warned the guest is away", (inv.json.warnings as string[]).some((w) => /out of office/i.test(w)), inv.json.warnings);
  const late = await ev({ title: `Late call ${stamp}`, start: day(8, 20), end: day(8, 21), attendees: [{ userId: mid }] });
  check("the organizer is warned when it's outside the guest's working hours", (late.json.warnings as string[]).some((w) => /working hours/.test(w)), late.json.warnings);
  check("existing invitations are declined when out of office is added", await (async () => {
    const pre = await ev({ title: `Pre-booked ${stamp}`, start: day(12, 11), end: day(12, 12), attendees: [{ userId: mid }] });
    await ev({ title: "OOO 2", start: day(12, 0), end: day(13, 0), eventType: "outOfOffice", autoDecline: true }, M);
    return (await ws(`/calendar/events/${pre.json.event.id}`, undefined, O)).json.event.attendees.find((a: any) => a.userId === mid)?.response === "no";
  })());
  void ooo;

  // ── This and following
  const ser = await ev({ title: `Standup ${stamp}`, start: day(1, 9), end: day(1, 9, 15), rrule: "FREQ=DAILY;COUNT=10" });
  const occs = ((await range(O)).events as any[]).filter((e) => e.id === ser.json.event.id);
  const fifth = occs[4];
  const split = await ws(`/calendar/events/${ser.json.event.id}`, { scope: "following", occ: fifth.occ, title: `Standup v2 ${stamp}` }, O, "PATCH");
  if (split.json.event?.id) made.push(split.json.event.id);
  const after = (await range(O)).events as any[];
  check("this and following: earlier ones keep the old title, later ones get the new one", after.filter((e) => e.title === `Standup ${stamp}`).length === 4 && after.filter((e) => e.title === `Standup v2 ${stamp}`).length >= 5, after.filter((e) => /Standup/.test(e.title)).map((e) => e.title));
  const v2 = after.filter((e) => e.title === `Standup v2 ${stamp}`);
  await ws(`/calendar/events/${v2[2].id}?scope=following&occ=${encodeURIComponent(v2[2].occ)}`, undefined, O, "DELETE");
  check("delete this and following", ((await range(O)).events as any[]).filter((e) => e.title === `Standup v2 ${stamp}`).length === 2);

  // ── Replies with a note and a proposed time
  const mtg = await ev({ title: `Design sync ${stamp}`, start: day(9, 11), end: day(9, 12), attendees: [{ userId: mid }] });
  const rp = await ws(`/calendar/events/${mtg.json.event.id}/respond`, { response: "maybe", comment: "Might be late", proposeStart: day(9, 14), proposeEnd: day(9, 15) }, M);
  const ma = (await ws(`/calendar/events/${mtg.json.event.id}`, undefined, O)).json.event.attendees.find((a: any) => a.userId === mid);
  check("reply Maybe with a note and propose a new time", rp.status === 200 && ma.response === "maybe" && ma.comment === "Might be late" && !!ma.proposedStart);
  const acc = await ws(`/calendar/events/${mtg.json.event.id}/proposal`, { email: ma.email }, O);
  check("the organizer accepts the proposed time", acc.status === 200 && acc.json.event.start === day(9, 14));

  // ── Outside guests: invitation email, reply link
  const before = outbox().length;
  const ext = await ev({ title: `Client call ${stamp}`, start: day(10, 11), end: day(10, 12), location: "Zoom", attendees: [{ email: `client.${stamp}@example.org`, name: "Rhea Client" }] });
  const mails = outbox().slice(before);
  const inviteMail = mails.find((m) => m.to === `client.${stamp}@example.org`);
  check("an outside guest gets an invitation email with Yes / No / Maybe links", !!inviteMail && /Invitation: Client call/.test(inviteMail.subject) && /\/workspace\/rsvp\/[\w-]+\?r=yes/.test(inviteMail.text), inviteMail);
  const token = /\/rsvp\/([\w-]+)\?r=yes/.exec(inviteMail?.text ?? "")?.[1] ?? "";
  const view = await fetch(`${WS}/api/calendar/rsvp/${token}`);
  const vj = await view.json();
  check("the reply page works without signing in", view.status === 200 && vj.title === `Client call ${stamp}` && vj.me.response === "needs");
  const yes = await fetch(`${WS}/api/calendar/rsvp/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: "yes", comment: "See you" }) });
  check("the guest replies Yes from the link and the organizer sees it", yes.status === 200 && (await ws(`/calendar/events/${ext.json.event.id}`, undefined, O)).json.event.attendees[0].response === "yes");
  check("a made-up reply link is refused", (await fetch(`${WS}/api/calendar/rsvp/nope-${stamp}`)).status === 404);
  const b2 = outbox().length;
  await ws(`/calendar/events/${ext.json.event.id}`, { start: day(10, 15), end: day(10, 16) }, O, "PATCH");
  check("changing the time emails an update", outbox().slice(b2).some((m) => /Updated invitation: Client call/.test(m.subject)));
  const b3 = outbox().length;
  await ws(`/calendar/events/${ext.json.event.id}`, undefined, O, "DELETE");
  check("cancelling emails a cancellation", outbox().slice(b3).some((m) => /Cancelled: Client call/.test(m.subject)));

  // ── Search
  const sr = (await ws(`/calendar/search?q=${encodeURIComponent("design sync " + stamp)}`, undefined, O)).json.results as any[];
  check("search finds events by title", sr.some((r) => r.id === mtg.json.event.id));
  check("search finds events by guest", ((await ws(`/calendar/search?q=${encodeURIComponent("Rhea")}`, undefined, O)).json.results as any[]).length >= 0);

  // ── iCal export, feed, import
  const exp = await fetch(`${WS}/api/calendar/ics?calendarId=${mainO.id}`, { headers: { cookie: O } });
  const icsText = await exp.text();
  check("export a calendar as .ics", exp.status === 200 && /BEGIN:VCALENDAR/.test(icsText) && icsText.includes(`Roadmap review ${stamp}`) && icsText.includes("RRULE:FREQ=DAILY"));
  const fd = await ws("/calendar/calendars", { id: side.json.calendar.id, feed: true }, O, "PATCH");
  const feedUrl = fd.json.calendar?.feed as string;
  const feedPath = feedUrl ? new URL(feedUrl).pathname.replace(/^\/workspace/, "") : "";
  check("turn on a secret iCal link", !!feedUrl && /\/api\/calendar\/feed\/[\w-]+\.ics$/.test(feedUrl));
  check("the iCal link works without signing in", (await fetch(`${WS}${feedPath}`)).status === 200);
  await ws("/calendar/calendars", { id: side.json.calendar.id, feed: false }, O, "PATCH");
  check("and stops working when turned off", (await fetch(`${WS}${feedPath}`)).status === 404);
  const file = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `UID:imp-${stamp}@example`, "DTSTART;TZID=Asia/Kolkata:20301105T100000", "DTEND;TZID=Asia/Kolkata:20301105T113000", `SUMMARY:Imported board meeting ${stamp}`, "DESCRIPTION:Line one\\nLine two", "RRULE:FREQ=MONTHLY;COUNT=3", "END:VEVENT", "BEGIN:VEVENT", `UID:imp2-${stamp}@example`, "DTSTART;VALUE=DATE:20301225", "DTEND;VALUE=DATE:20301226", "SUMMARY:Holiday", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const form = new FormData();
  form.append("file", new Blob([file], { type: "text/calendar" }), "import.ics");
  form.append("calendarId", side.json.calendar.id);
  const imp = await fetch(`${WS}/api/calendar/ics`, { method: "POST", headers: { cookie: O }, body: form });
  const ij = await imp.json();
  check("import an .ics file (zone, repeat, all-day)", imp.status === 200 && ij.created === 2, ij);
  const form2 = new FormData();
  form2.append("file", new Blob([file], { type: "text/calendar" }), "import.ics");
  form2.append("calendarId", side.json.calendar.id);
  check("importing again updates instead of doubling", (await (await fetch(`${WS}/api/calendar/ics`, { method: "POST", headers: { cookie: O }, body: form2 })).json()).updated === 2);
  const nov = (await ws(`/calendar?from=2030-11-01T00:00:00Z&to=2031-01-01T00:00:00Z&sync=0`, undefined, O)).json.events as any[];
  const im = nov.find((e) => e.title === `Imported board meeting ${stamp}`);
  check("the imported time keeps its zone (10:00 in Kolkata = 04:30 UTC)", im?.start === "2030-11-05T04:30:00.000Z" && im.description === "Line one\nLine two", im);
  check("subscriptions refuse private network addresses", (await ws("/calendar/ics", { url: "https://127.0.0.1/x.ics" }, O)).status === 400);
  check("holiday calendars are offered by country", ((await ws("/calendar/ics?holidays=1", undefined, O)).json.countries as string[]).includes("India"));

  // ── Attachments
  const fm = new FormData();
  fm.append("file", new Blob(["agenda"], { type: "text/plain" }), "agenda.txt");
  const up = await fetch(`${WS}/api/calendar/events/${pub.json.event.id}/files`, { method: "POST", headers: { cookie: O }, body: fm });
  const fj = await up.json();
  check("attach a file to an event", up.status === 201 && fj.file?.name === "agenda.txt");
  check("guests and readers can open it (sandboxed)", (await (await fetch(`${WS}/api/calendar/files/${fj.file.id}`, { headers: { cookie: O } })).text()) === "agenda");

  // ── Booking pages
  const bp = await ws("/calendar/bookings", { title: `Intro call ${stamp}`, minutes: 30, tz: "UTC", hours: { "0": [{ start: "09:00", end: "17:00" }], "1": [{ start: "09:00", end: "17:00" }], "2": [{ start: "09:00", end: "17:00" }], "3": [{ start: "09:00", end: "17:00" }], "4": [{ start: "09:00", end: "17:00" }], "5": [{ start: "09:00", end: "17:00" }], "6": [{ start: "09:00", end: "17:00" }] }, noticeHours: 1, locationKind: "none", questions: [{ label: "Company", required: true }] }, O);
  const slug = bp.json.page?.slug as string;
  check("create a booking page", bp.status === 201 && !!slug);
  const slots = await (await fetch(`${WS}/api/calendar/book/${slug}?days=14`)).json();
  const busyAt = new Date(pub.json.event.start).toISOString();
  check("the public page lists free slots and hides busy time", slots.days?.some((d: any) => d.slots.length > 0) && !slots.days.some((d: any) => d.slots.includes(busyAt)), slots.days?.slice(0, 2));
  const pick = (slots.days as any[]).find((d) => d.slots.length)?.slots[0];
  check("a required question must be answered", (await fetch(`${WS}/api/calendar/book/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: pick, name: "Asha", email: `asha.${stamp}@example.org` }) })).status === 400);
  const b4 = outbox().length;
  const bk = await fetch(`${WS}/api/calendar/book/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: pick, name: "Asha", email: `asha.${stamp}@example.org`, answers: { q0: "Acme" } }) });
  const bj = await bk.json();
  check("a visitor books a slot; it lands on my calendar", bk.status === 201 && ((await range(O, day(-1), day(30))).events as any[]).some((e) => e.title === `Intro call ${stamp} with Asha` && /Company: Acme/.test(e.description)), bj);
  check("the visitor gets a confirmation email with the invite", outbox().slice(b4).some((m) => m.to === `asha.${stamp}@example.org` && /Confirmed: Intro call/.test(m.subject)));
  check("the same slot can't be booked twice", (await fetch(`${WS}/api/calendar/book/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: pick, name: "Bo", email: `bo.${stamp}@example.org`, answers: { q0: "B" } }) })).status === 409);
  const btoken = /\/rsvp\/([\w-]+)$/.exec(bj.manage ?? "")?.[1];
  check("the visitor can cancel from their link", (await fetch(`${WS}/api/calendar/rsvp/${btoken}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cancel: true }) })).status === 200);
  await ws(`/calendar/bookings?id=${bp.json.page.id}`, undefined, O, "DELETE");
  check("a deleted booking page is gone", (await fetch(`${WS}/api/calendar/book/${slug}`)).status === 404);

  // ── Email reminders
  const soon = new Date(Date.now() + 10 * 60_000);
  soon.setSeconds(0, 0);
  const rem = await ev({ title: `Reminder test ${stamp}`, start: soon.toISOString(), end: new Date(soon.getTime() + 30 * 60_000).toISOString(), emailReminders: [10] });
  const b5 = outbox().length;
  const tick = await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "x-iotx-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ job: "email-reminders", now: new Date(soon.getTime() - 10 * 60_000 + 1000).toISOString(), from: new Date(soon.getTime() - 11 * 60_000).toISOString() }) });
  check("email reminders go out at the chosen time", (await tick.json()).sent >= 1 && outbox().slice(b5).some((m) => /Reminder: Reminder test/.test(m.subject)));
  void rem;
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of made) await ws(`/calendar/events/${id}`, undefined, OWNER === "" ? "" : O, "DELETE").catch(() => null);
  for (const id of cals) if (id) await ws(`/calendar/calendars?id=${id}`, undefined, O, "DELETE").catch(() => null);
  await ws("/calendar/settings", { weekStart: 1, timeFormat: "12", defaultMinutes: 60, defaultReminders: [10], secondTz: null, hours: { "1": [{ start: "09:00", end: "18:00" }], "2": [{ start: "09:00", end: "18:00" }], "3": [{ start: "09:00", end: "18:00" }], "4": [{ start: "09:00", end: "18:00" }], "5": [{ start: "09:00", end: "18:00" }] } }, M, "PUT").catch(() => null);
  await ws("/calendar/others", { calendarId: mainId, remove: true }, M, "PATCH").catch(() => null);
  process.exit(summary("Calendar (parity)") ? 1 : 0);
}
