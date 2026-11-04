/**
 * IOTx Workspace — SSO, Calendar CRUD, recurrence, invites and replies,
 * find-a-time, team calendars, reminders, workspace isolation, permissions.
 *   npx tsx scripts/test-calendar.mts <devToken> <test-users.json>
 */
import { check, envOf, lastSetCookie, nextMonday, OUTSIDER, OWNER, resetMember, setMemberPerm, setup, signIn, sleep, summary, suite, ws, WS } from "./lib.mts";

const KEY = envOf(new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")).IOTX_SERVICE_KEY;
const { wsId, MEMBER } = await setup();
const made: string[] = [];
let O = "", M = "", X = "";

try {
  // ── SSO
  check("no session: API answers 401", (await ws("/me")).status === 401);
  const page = await fetch(`${WS}/calendar`);
  const html = await page.text();
  check("no session: the Calendar page bounces to the suite's pass URL", page.status === 200 && html.includes("/api/iotx/pass?app=calendar") && html.includes("auth%2Fcallback"));
  const bad = await fetch(`${WS}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pass: "not-a-pass" }) });
  check("a forged pass is refused", bad.status === 401);
  const passNoOrigin = await suite(`/api/iotx/pass?app=calendar&redirect=${encodeURIComponent("https://evil.example/x")}`);
  check("the suite still refuses redirects to other origins", passNoOrigin.status === 400);
  O = await signIn(OWNER);
  const me = (await ws("/me", undefined, O)).json.me;
  check("signed in through the pass: Workspace knows the suite user and workspace", me?.email === "dev@localhost" && me?.ws === wsId && me?.perms?.["calendar.open"] === true, me);
  check("the session cookie is httpOnly and scoped to /workspace", /HttpOnly/i.test(lastSetCookie()) && /Path=\/workspace/i.test(lastSetCookie()), lastSetCookie().replace(/=[^;]+/, "=…"));
  check("a session request without a pass is refused", (await fetch(`${WS}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 400);
  M = await signIn(MEMBER);
  X = await signIn(OUTSIDER);
  const mm = (await ws("/me", undefined, M)).json.me;
  const xm = (await ws("/me", undefined, X)).json.me;
  check("member signs in to the same workspace; outsider to their own", mm?.ws === wsId && xm?.ws && xm.ws !== wsId);
  const ppl = (await ws("/people", undefined, O)).json.people as { id: string; email: string }[];
  check("people: the member is listed for invites; the outsider isn't", ppl.some((p) => p.email === "member@localhost") && !ppl.some((p) => p.email === "outsider@localhost"));
  const memberId = mm.id as string;

  // ── CRUD
  const base = nextMonday(2);
  const at = (d: number, h: number, m = 0) => new Date(base.getTime() + d * 86_400_000 + h * 3_600_000 + m * 60_000).toISOString();
  const c1 = await ws("/calendar/events", { title: "C-WS planning", start: at(1, 9), end: at(1, 10), tz: "UTC", location: "Room 4", reminders: [10] }, O);
  check("create an event", c1.status === 201 && c1.json.event?.id, c1.json);
  const e1 = c1.json.event.id as string;
  made.push(e1);
  const range = `from=${base.toISOString()}&to=${new Date(base.getTime() + 7 * 86_400_000).toISOString()}&sync=0`;
  let list = (await ws(`/calendar?${range}`, undefined, O)).json;
  check("it's listed in the week", list.events.some((e: any) => e.id === e1 && e.start === at(1, 9) && e.canEdit));
  check("My calendar exists for each person", list.calendars.some((c: any) => c.kind === "personal" && c.name === "My calendar"));
  const p1 = await ws(`/calendar/events/${e1}`, { title: "C-WS planning (moved)", start: at(2, 14), end: at(2, 15, 30) }, O, "PATCH");
  check("edit and move it (drag-to-move uses the same call)", p1.status === 200 && p1.json.event.title === "C-WS planning (moved)" && p1.json.event.start === at(2, 14));
  const ad = await ws("/calendar/events", { title: "C-WS offsite", allDay: true, start: at(3, 0).slice(0, 10), end: at(5, 0).slice(0, 10) }, O);
  made.push(ad.json.event.id);
  list = (await ws(`/calendar?${range}`, undefined, O)).json;
  const adEv = list.events.find((e: any) => e.id === ad.json.event.id);
  check("all-day event over two days (end exclusive, stored at UTC midnight)", adEv?.allDay && adEv.start === at(3, 0) && adEv.end === at(5, 0), adEv);
  const del = await ws(`/calendar/events/${ad.json.event.id}`, undefined, O, "DELETE");
  list = (await ws(`/calendar?${range}`, undefined, O)).json;
  check("delete an event", del.status === 200 && !list.events.some((e: any) => e.id === ad.json.event.id));

  // ── Recurrence
  const rw = await ws("/calendar/events", { title: "C-WS standup", start: at(0, 3, 30), end: at(0, 3, 45), tz: "Asia/Kolkata", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6" }, O);
  const rid = rw.json.event.id as string;
  made.push(rid);
  const r3 = `from=${base.toISOString()}&to=${new Date(base.getTime() + 21 * 86_400_000).toISOString()}&sync=0`;
  let occ = (await ws(`/calendar?${r3}`, undefined, O)).json.events.filter((e: any) => e.id === rid || e.seriesId === rid);
  check("weekly Mon/Wed/Fri ×6 expands to 6 occurrences at 9:00 India time", occ.length === 6 && occ.every((e: any) => e.start.endsWith("T03:30:00.000Z")), occ.map((e: any) => e.start));
  const third = occ[2];
  const ex = await ws(`/calendar/events/${rid}`, { title: "C-WS standup (moved)", start: new Date(new Date(third.start).getTime() + 3_600_000).toISOString(), end: new Date(new Date(third.end).getTime() + 3_600_000).toISOString(), scope: "this", occ: third.occ }, O, "PATCH");
  made.push(ex.json.event?.id);
  occ = (await ws(`/calendar?${r3}`, undefined, O)).json.events.filter((e: any) => e.id === rid || e.seriesId === rid);
  check("edit “this event”: one occurrence changes, the rest stay", occ.length === 6 && occ.filter((e: any) => e.title === "C-WS standup (moved)").length === 1 && occ.find((e: any) => e.title === "C-WS standup (moved)").start.endsWith("T04:30:00.000Z"));
  await ws(`/calendar/events/${rid}?scope=this&occ=${encodeURIComponent(occ[0].occ)}`, undefined, O, "DELETE");
  occ = (await ws(`/calendar?${r3}`, undefined, O)).json.events.filter((e: any) => e.id === rid || e.seriesId === rid);
  check("delete “this event” removes just that occurrence", occ.length === 5 && !occ.some((e: any) => e.start === at(0, 3, 30)));
  await ws(`/calendar/events/${rid}`, { title: "C-WS daily standup", scope: "all" }, O, "PATCH");
  occ = (await ws(`/calendar?${r3}`, undefined, O)).json.events.filter((e: any) => e.id === rid || e.seriesId === rid);
  check("edit “all events” renames the series (the changed one keeps its own title)", occ.filter((e: any) => e.title === "C-WS daily standup").length === 4 && occ.some((e: any) => e.title === "C-WS standup (moved)"));
  // Move the whole series by an hour from one occurrence (drag with "all").
  const any = occ.find((e: any) => e.id === rid);
  await ws(`/calendar/events/${rid}`, { start: new Date(new Date(any.start).getTime() + 3_600_000).toISOString(), end: new Date(new Date(any.end).getTime() + 3_600_000).toISOString(), scope: "all", occ: any.occ }, O, "PATCH");
  occ = (await ws(`/calendar?${r3}`, undefined, O)).json.events.filter((e: any) => e.id === rid);
  check("moving one occurrence with “all” shifts the whole series and keeps removed dates removed", occ.length === 4 && occ.every((e: any) => e.start.endsWith("T04:30:00.000Z")), occ.map((e: any) => e.start));
  // DST: 9:00 in New York stays 9:00 across the November change.
  const nyStart = "2026-10-26T13:00:00.000Z"; // Mon 9:00 EDT
  const dst = await ws("/calendar/events", { title: "C-WS NY weekly", start: nyStart, end: "2026-10-26T13:30:00.000Z", tz: "America/New_York", rrule: "FREQ=WEEKLY" }, O);
  made.push(dst.json.event.id);
  const dl = (await ws(`/calendar?from=2026-10-26T00:00:00.000Z&to=2026-11-10T00:00:00.000Z&sync=0`, undefined, O)).json.events.filter((e: any) => e.id === dst.json.event.id);
  check("time zones: a 9:00 New York weekly meeting moves from 13:00Z to 14:00Z after DST ends", dl.length === 3 && dl[0].start === nyStart && dl[1].start === "2026-11-02T14:00:00.000Z", dl.map((e: any) => e.start));
  const mo = await ws("/calendar/events", { title: "C-WS monthly", start: "2026-01-31T10:00:00.000Z", end: "2026-01-31T11:00:00.000Z", tz: "UTC", rrule: "FREQ=MONTHLY;COUNT=12" }, O);
  made.push(mo.json.event.id);
  const ml = (await ws(`/calendar?from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z&sync=0`, undefined, O)).json.events.filter((e: any) => e.id === mo.json.event.id);
  check("monthly on the 31st skips shorter months (RFC 5545)", ml.length === 7 && ml.every((e: any) => e.start.slice(8, 10) === "31"), ml.map((e: any) => e.start.slice(0, 10)));
  const yr = await ws("/calendar/events", { title: "C-WS anniversary", allDay: true, start: "2025-11-05", end: "2025-11-06", rrule: "FREQ=YEARLY" }, O);
  made.push(yr.json.event.id);
  const yl = (await ws(`/calendar?from=2026-11-01T00:00:00.000Z&to=2027-11-30T00:00:00.000Z&sync=0`, undefined, O)).json.events.filter((e: any) => e.id === yr.json.event.id);
  check("yearly all-day repeats each year", yl.length === 2 && yl[0].start === "2026-11-05T00:00:00.000Z" && yl[1].start === "2027-11-05T00:00:00.000Z");
  const dly = await ws("/calendar/events", { title: "C-WS daily", start: at(0, 8), end: at(0, 8, 15), tz: "UTC", rrule: "FREQ=DAILY;INTERVAL=2;COUNT=4" }, O);
  made.push(dly.json.event.id);
  const dlist = (await ws(`/calendar?${r3}`, undefined, O)).json.events.filter((e: any) => e.id === dly.json.event.id);
  check("daily every 2 days ×4", dlist.length === 4 && dlist[1].start === at(2, 8));
  check("an unsupported repeat rule is refused", (await ws("/calendar/events", { title: "x", start: at(0, 8), rrule: "FREQ=SECONDLY" }, O)).status === 400);

  // ── Invites and replies
  const inv = await ws("/calendar/events", { title: "C-WS review", start: at(1, 11), end: at(1, 12), tz: "UTC", attendees: [{ userId: memberId }, { email: "client@example.com", name: "Client" }], conferenceUrl: "https://meet.google.com/abc-defg-hij" }, O);
  const iid = inv.json.event.id as string;
  made.push(iid);
  let mlist = (await ws(`/calendar?${range}`, undefined, M)).json.events;
  const mine = mlist.find((e: any) => e.id === iid);
  check("an invited colleague sees the event, awaiting their reply", mine?.myResponse === "needs" && mine.canEdit === false);
  check("the external email is stored as a guest", mine?.attendees.some((a: any) => a.email === "client@example.com" && a.userId === null));
  check("the Join link is on the event", mine?.conferenceUrl === "https://meet.google.com/abc-defg-hij");
  const mnotes = (await ws("/notifications", undefined, M)).json;
  check("the invitee is notified", mnotes.items.some((n: any) => n.kind === "invite" && n.title.includes("C-WS review")) && mnotes.unread > 0);
  check("a reply must be yes, no or maybe", (await ws(`/calendar/events/${iid}/respond`, { response: "sure" }, M)).status === 400);
  check("the invitee replies Yes", (await ws(`/calendar/events/${iid}/respond`, { response: "yes" }, M)).status === 200);
  const olist = (await ws(`/calendar?${range}`, undefined, O)).json.events.find((e: any) => e.id === iid);
  check("the organiser sees the reply", olist?.attendees.find((a: any) => a.userId === memberId)?.response === "yes");
  check("the organiser is notified of the reply", (await ws("/notifications", undefined, O)).json.items.some((n: any) => n.kind === "rsvp" && n.title.includes("Yes")));
  await ws(`/calendar/events/${iid}/respond`, { response: "maybe" }, M);
  check("the invitee can change to Maybe", (await ws(`/calendar?${range}`, undefined, M)).json.events.find((e: any) => e.id === iid)?.myResponse === "maybe");
  check("the invitee can't edit the organiser's event", (await ws(`/calendar/events/${iid}`, { title: "hijack" }, M, "PATCH")).status === 403);
  check("mark notifications read", (await ws("/notifications", { action: "read" }, M)).status === 200 && (await ws("/notifications", undefined, M)).json.unread === 0);

  // ── Find a time
  const fb = await ws(`/calendar/busy?users=${memberId},${me.id}&from=${base.toISOString()}&to=${new Date(base.getTime() + 7 * 86_400_000).toISOString()}`, undefined, O);
  check("find a time: the colleague's accepted meeting shows as busy", fb.json.busy?.[memberId]?.some((b: any) => b.start === at(1, 11)));
  check("find a time: my own events are busy too (incl. repeating)", fb.json.busy?.[me.id]?.length >= 3);
  check("find a time: a range over 15 days is refused", (await ws(`/calendar/busy?users=${memberId}&from=${base.toISOString()}&to=${new Date(base.getTime() + 40 * 86_400_000).toISOString()}`, undefined, O)).status === 400);

  // ── Team calendars
  const tc = await ws("/calendar/calendars", { name: "C-WS Team", color: "#0891b2", kind: "team" }, O);
  check("an owner creates a team calendar", tc.status === 201);
  const tev = await ws("/calendar/events", { calendarId: tc.json.calendar.id, title: "C-WS team sync", start: at(4, 10), end: at(4, 11), tz: "UTC" }, O);
  made.push(tev.json.event.id);
  mlist = (await ws(`/calendar?${range}`, undefined, M)).json;
  check("colleagues see team calendars and their events", mlist.calendars.some((c: any) => c.id === tc.json.calendar.id) && mlist.events.some((e: any) => e.id === tev.json.event.id));
  check("but not someone else's My calendar", !mlist.events.some((e: any) => e.id === e1));

  // ── Reminders
  const soon = new Date(Date.now() + 10 * 60_000 + 20_000);
  soon.setSeconds(0, 0);
  const rem = await ws("/calendar/events", { title: "C-WS reminder test", start: soon.toISOString(), end: new Date(soon.getTime() + 1_800_000).toISOString(), tz: "UTC", reminders: [10] }, O);
  made.push(rem.json.event.id);
  const tickAt = new Date(soon.getTime() - 10 * 60_000 + 1000).toISOString();
  const tick = await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "content-type": "application/json", "x-iotx-key": KEY }, body: JSON.stringify({ job: "reminders", now: tickAt }) });
  const tj = await tick.json();
  check("reminders: the job sends an in-app reminder at the right minute", tick.status === 200 && tj.sent >= 1, tj);
  check("the reminder is in the bell", (await ws("/notifications", undefined, O)).json.items.some((n: any) => n.kind === "reminder" && n.title.startsWith("C-WS reminder test")));
  const tick2 = await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "content-type": "application/json", "x-iotx-key": KEY }, body: JSON.stringify({ job: "reminders", now: new Date(new Date(tickAt).getTime() + 30_000).toISOString() }) });
  check("…and only once", (await tick2.json()).sent === 0);
  check("the job endpoint needs the service key", (await fetch(`${WS}/api/internal/tick`, { method: "POST", body: "{}" })).status === 403);

  // ── Isolation
  const xl = (await ws(`/calendar?${range}`, undefined, X)).json;
  check("an outsider sees none of this workspace's events or calendars", !xl.events.some((e: any) => made.includes(e.id)) && !xl.calendars.some((c: any) => c.id === tc.json.calendar.id));
  check("an outsider can't open an event by id", (await ws(`/calendar/events/${e1}`, undefined, X)).status === 404);
  check("an outsider can't edit or delete it", (await ws(`/calendar/events/${e1}`, { title: "x" }, X, "PATCH")).status === 404 && (await ws(`/calendar/events/${e1}`, undefined, X, "DELETE")).status === 404);
  check("an outsider can't reply to an invite", (await ws(`/calendar/events/${iid}/respond`, { response: "yes" }, X)).status === 404);
  check("an outsider can't add events to this workspace's team calendar", (await ws("/calendar/events", { calendarId: tc.json.calendar.id, title: "x", start: at(1, 1) }, X)).status === 404);
  const xb = (await ws(`/calendar/busy?users=${me.id}&from=${base.toISOString()}&to=${new Date(base.getTime() + 7 * 86_400_000).toISOString()}`, undefined, X)).json;
  check("an outsider can't see this workspace's busy times", !xb.busy?.[me.id]);
  check("inviting an outsider by id from another workspace is ignored", await (async () => {
    const r = await ws("/calendar/events", { title: "C-WS x", start: at(1, 16), end: at(1, 17), tz: "UTC", attendees: [{ userId: xm.id }] }, O);
    made.push(r.json.event.id);
    const g = await ws(`/calendar/events/${r.json.event.id}`, undefined, O);
    return g.json.event.attendees.length === 0;
  })());

  // ── Permissions (a member without the switch is refused)
  await setMemberPerm({ "calendar.create": false });
  await sleep(300);
  const M2 = await signIn(MEMBER);
  check("member without “Create events” is refused", (await ws("/calendar/events", { title: "C-WS nope", start: at(1, 1) }, M2)).status === 403);
  check("…but can still open Calendar", (await ws(`/calendar?${range}`, undefined, M2)).status === 200);
  await setMemberPerm({ "calendar.team": false });
  const M3 = await signIn(MEMBER);
  check("member without “Create team calendars” is refused", (await ws("/calendar/calendars", { name: "x", kind: "team" }, M3)).status === 403);
  await setMemberPerm({ "calendar.open": false });
  check("member without Calendar can't get a pass for it", await (async () => {
    try {
      await signIn(MEMBER, "calendar");
      return false;
    } catch {
      return true;
    }
  })());
  check("…and the API refuses them once decisions refresh", (await ws(`/calendar?${range}`, undefined, await signIn(MEMBER, "tasks"))).status === 403);
  await resetMember();
  const M4 = await signIn(MEMBER);
  check("turned back on, the member can create events again", await (async () => {
    const r = await ws("/calendar/events", { title: "C-WS member", start: at(1, 1), end: at(1, 2), tz: "UTC" }, M4);
    if (r.json.event?.id) made.push(r.json.event.id);
    return r.status === 201;
  })());
  check("sign out ends the Workspace session", (await ws("/auth/session", undefined, M4, "DELETE")).status === 200 && (await ws("/me", undefined, M4)).status === 401);
  // Clean the team calendar.
  await ws(`/calendar/calendars?id=${tc.json.calendar.id}`, undefined, O, "DELETE");
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  await resetMember().catch(() => {});
  for (const id of made.filter(Boolean)) await ws(`/calendar/events/${id}`, undefined, O, "DELETE").catch(() => {});
}
process.exit(summary("Calendar") ? 1 : 0);
