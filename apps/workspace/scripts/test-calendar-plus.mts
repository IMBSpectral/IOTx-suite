/**
 * Calendar, round 2: multi-day / all-day bars (lane layout, continuation,
 * move and resize by day), the Birthdays calendar (workspace people by their
 * sharing choice, Google contacts via the People API), public calendars and
 * the embed page (no cookies, unguessable token, free/busy or details,
 * private events stay "Busy"), the working-location strip, the offline
 * service worker, and Google sync of more calendars plus RSVP both ways.
 * Google runs against a mock on 127.0.0.1:4800: start Workspace with
 * GOOGLE_API_BASE=http://127.0.0.1:4800.
 *   npx tsx scripts/test-calendar-plus.mts <devToken> <test-users.json>
 */
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { check, envOf, OWNER, setup, signIn, summary, WS, ws } from "./lib.mts";
import { covers, shifted, stack } from "../src/components/calendar/bars.ts";

const here = (p: string) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const WEB_DB = envOf(here("../../../web/.env")).DATABASE_URL;
const WS_DB = envOf(here("../.env")).DATABASE_URL;
const TOKEN = "mock-cal-token";
const ORIGIN = new URL(WS).origin;

// ── Mock Google: Calendar (several calendars, calendarList) and People ─────
type GE = Record<string, any> & { id: string; _v: number };
const stores = new Map<string, Map<string, GE>>();
const cal = (id: string) => stores.get(id) ?? stores.set(id, new Map()).get(id)!;
let ver = 0, lastTs = 0;
const stampNow = () => new Date((lastTs = Math.max(Date.now(), lastTs + 5))).toISOString();
const put = (c: string, e: Record<string, any>) => {
  const g = { status: "confirmed", ...e, updated: stampNow(), _v: ++ver } as unknown as GE;
  cal(c).set(g.id, g);
  return g;
};
const strip = ({ _v, ...rest }: GE) => rest;
const calls: { method: string; path: string; body?: any }[] = [];
const calList = [
  { id: "dev@gmail.example", summary: "Dev", primary: true, backgroundColor: "#4285f4", accessRole: "owner" },
  { id: "team@group.calendar.google.com", summary: "G Team plans", backgroundColor: "#16a765", accessRole: "writer" },
  { id: "fun@group.calendar.google.com", summary: "G Holidays feed", backgroundColor: "#cd74e6", accessRole: "reader" },
];
let contacts: any[] = [];
let peopleForbidden = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let raw = "";
  for await (const ch of req) raw += ch;
  const body = raw ? JSON.parse(raw) : undefined;
  calls.push({ method: req.method ?? "", path: decodeURIComponent(url.pathname), body });
  const send = (s: number, d?: unknown) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(d === undefined ? "" : JSON.stringify(d));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { message: "bad token" } });
  if (url.pathname === "/calendar/v3/users/me/calendarList") return send(200, { items: calList });
  if (url.pathname === "/v1/people/me/connections") {
    if (peopleForbidden) return send(403, { error: { message: "Request had insufficient authentication scopes." } });
    return send(200, { connections: contacts, totalPeople: contacts.length });
  }
  const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
  if (!m) return send(404, { error: { message: "not found" } });
  const c = decodeURIComponent(m[1]);
  const id = m[2] ? decodeURIComponent(m[2]) : null;
  const store = cal(c);
  if (!id && req.method === "GET") {
    const st = url.searchParams.get("syncToken");
    const since = st ? Number(st.slice(1)) : -1;
    const all = [...store.values()].filter((e) => (st ? e._v > since : e.status !== "cancelled")).sort((a, b) => a._v - b._v);
    return send(200, { items: all.map(strip), nextSyncToken: `s${ver}` });
  }
  if (!id && req.method === "POST") return send(200, strip(put(c, { ...body, id: crypto.randomBytes(8).toString("hex") })));
  if (id && req.method === "PATCH") {
    const cur = store.get(id);
    if (!cur) return send(404, { error: { message: "Not Found" } });
    return send(200, strip(put(c, { ...cur, ...body, id })));
  }
  if (id && req.method === "DELETE") {
    const cur = store.get(id);
    if (!cur || cur.status === "cancelled") return send(410, {});
    put(c, { ...cur, status: "cancelled" });
    res.writeHead(204);
    return res.end();
  }
  send(405, {});
});
await new Promise<void>((r) => server.listen(4800, "127.0.0.1", r));

const day = (n: number, h = 10, mi = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(h, mi, 0, 0);
  return d.toISOString();
};
const dkey = (n: number) => day(n, 0).slice(0, 10);
const stamp = Date.now().toString(36);

const web = new pg.Client({ connectionString: WEB_DB });
await web.connect();
const wsdb = new pg.Client({ connectionString: WS_DB });
await wsdb.connect();
const { wsId, MEMBER } = await setup();
const O = await signIn(OWNER);
const M = await signIn(MEMBER);
const oid = (await ws("/me", undefined, O)).json.me.id as string;
const mid = (await ws("/me", undefined, M)).json.me.id as string;
const range = async (who: string, from = day(-3, 0), to = day(45, 0)) => (await ws(`/calendar?from=${from}&to=${to}&sync=0`, undefined, who)).json;
const made: string[] = [];
const madeCals: string[] = [];
const ev = async (b: Record<string, unknown>, who = O) => {
  const r = await ws("/calendar/events", b, who);
  if (r.json.event?.id) made.push(r.json.event.id);
  return r;
};

// Keep the people's own settings to put back afterwards.
const before = (await wsdb.query(`select id, birthday, "birthdayShare", "calSettings" from users where id = any($1)`, [[oid, mid]])).rows;
const backup = (await web.query(`select * from google_connections where "userId" = $1`, [oid])).rows[0] ?? null;
const myCal = (await wsdb.query(`select id from calendars where ws = $1 and kind = 'personal' and "ownerId" = $2 and "primary"`, [wsId, oid])).rows[0].id as string;

try {
  // ── 1. Bars across days ────────────────────────────────────────────────
  const row = Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 2 + i)); // Mon 2 – Sun 8 Nov 2026
  const occ = (s: string, e: string, allDay = true) => ({ id: s + e, occ: null, start: s, end: e, allDay, canEdit: true }) as any;
  const a = occ("2026-10-31T00:00:00.000Z", "2026-11-04T00:00:00.000Z"); // Sat 31 – Tue 3
  const b = occ("2026-11-03T00:00:00.000Z", "2026-11-06T00:00:00.000Z"); // Tue 3 – Thu 5
  const c = occ("2026-11-07T00:00:00.000Z", "2026-11-11T00:00:00.000Z"); // Sat 7 – Tue 10
  const L = stack(row, [a, b, c].map((o) => ({ key: o.id, data: o, covers: (d: Date) => covers(o, d) })));
  const pa = L.placed.find((p) => p.key === a.id)!, pb = L.placed.find((p) => p.key === b.id)!, pc = L.placed.find((p) => p.key === c.id)!;
  check("a multi-day all-day event is one bar spanning its days in the week", pa.col === 0 && pa.span === 2 && pb.col === 1 && pb.span === 3, L.placed);
  check("overlapping bars stack in separate lanes; free lanes are reused", pa.lane === 0 && pb.lane === 1 && pc.lane === 0 && L.lanes === 2, L.placed);
  check("bars show where they continue across the week boundary", pa.contL && !pa.contR && pc.contR && !pc.contL && !pb.contL && !pb.contR);
  const t = occ("2026-11-04T15:00:00.000Z", "2026-11-06T09:00:00.000Z", false);
  const Lt = stack(row, [{ key: "t", data: t, covers: (d: Date) => covers(t, d) }]);
  check("a timed event over several days is a bar too", Lt.placed[0]?.span >= 2, Lt.placed);
  const mv = shifted(a, "move", 2), rr = shifted(a, "r", 1), rl = shifted(a, "l", 9);
  check("dragging a bar moves it by whole days", mv.s.getDate() === 2 && mv.e.getDate() === 6);
  check("pulling an end changes its length, never below one day", rr.e.getDate() === 5 && rl.s.getDate() === 3 && rl.e.getDate() === 4, { rr, rl });

  const span = await ev({ title: `Offsite ${stamp}`, start: dkey(10), end: dkey(13), allDay: true });
  const long = await ev({ title: `Hackathon ${stamp}`, start: day(15, 14), end: day(17, 10) });
  let list = (await range(O)).events as any[];
  check("an all-day event over 3 days comes back as one entry (one bar)", list.filter((e) => e.title === `Offsite ${stamp}`).length === 1 && list.find((e) => e.title === `Offsite ${stamp}`).end.startsWith(dkey(13)));
  check("a 44-hour timed event comes back once", list.filter((e) => e.title === `Hackathon ${stamp}`).length === 1);
  await ws(`/calendar/events/${span.json.event.id}`, { start: dkey(11), end: dkey(14), allDay: true }, O, "PATCH");
  await ws(`/calendar/events/${long.json.event.id}`, { start: day(16, 14), end: day(18, 10) }, O, "PATCH");
  list = (await range(O)).events as any[];
  check("moving an all-day bar by a day keeps its length", list.find((e) => e.title === `Offsite ${stamp}`)?.start.startsWith(dkey(11)) && list.find((e) => e.title === `Offsite ${stamp}`)?.end.startsWith(dkey(14)));
  check("moving a timed multi-day bar keeps its times", list.find((e) => e.title === `Hackathon ${stamp}`)?.start === day(16, 14));
  await ws(`/calendar/events/${span.json.event.id}`, { start: dkey(11), end: dkey(16), allDay: true }, O, "PATCH");
  list = (await range(O)).events as any[];
  check("resizing an all-day bar changes its last day", list.find((e) => e.title === `Offsite ${stamp}`)?.end.startsWith(dkey(16)));

  // ── 2. Birthdays ──────────────────────────────────────────────────────
  const bd = new Date(day(5, 0));
  const mmdd = `${String(bd.getUTCMonth() + 1).padStart(2, "0")}-${String(bd.getUTCDate()).padStart(2, "0")}`;
  check("an impossible birthday is refused", (await ws("/calendar/settings", { birthday: "1990-02-30" }, O, "PUT")).status === 400);
  const sb = await ws("/calendar/settings", { birthday: `1990-${mmdd}`, birthdayShare: "private" }, O, "PUT");
  check("save a birthday (with year) in settings", sb.json.settings?.birthday === `1990-${mmdd}` && sb.json.settings.birthdayShare === "private", sb.json);
  let mine = await range(O);
  const myB = (mine.events as any[]).find((e) => e.id === `bday:u:${oid}`);
  check("the Birthdays calendar is in the list", (mine.calendars as any[]).some((c) => c.id === "birthdays" && c.kind === "birthdays" && c.name === "Birthdays"));
  check("my birthday shows as a yearly all-day entry, with the age", myB?.allDay && myB.start.startsWith(day(5, 0).slice(0, 10)) && myB.calendarId === "birthdays" && myB.title === "Your birthday" && /^Turns \d+$/.test(myB.description) && myB.canEdit === false, myB);
  check("a private birthday stays hidden from others", !((await range(M)).events as any[]).some((e) => e.id === `bday:u:${oid}`));
  await ws("/calendar/settings", { birthdayShare: "workspace" }, O, "PUT");
  const seen = ((await range(M)).events as any[]).find((e) => e.id === `bday:u:${oid}`);
  check("shared with the workspace: colleagues see it, without the year", !!seen && /birthday$/.test(seen.title) && seen.description === "", seen);
  const yr = await range(O, day(-3, 0), day(380, 0));
  check("it repeats every year", (yr.events as any[]).filter((e) => e.id === `bday:u:${oid}`).length === 2);
  await ws("/calendar/settings", { birthday: `--${mmdd}` }, O, "PUT");
  check("a birthday without a year has no age", ((await range(O)).events as any[]).find((e) => e.id === `bday:u:${oid}`)?.description === "");
  await ws("/calendar/others", { calendarId: "birthdays", color: "#db2777" }, O, "PATCH");
  check("the Birthdays calendar takes my colour", ((await range(O)).calendars as any[]).find((c) => c.id === "birthdays")?.color === "#db2777");

  // ── 3. Public link / embed ────────────────────────────────────────────
  const pubCal = await ws("/calendar/calendars", { name: `Public ${stamp}`, color: "#0891b2" }, O);
  const pid = pubCal.json.calendar.id as string;
  madeCals.push(pid);
  await ev({ title: `Open talk ${stamp}`, description: "All welcome", location: "Hall A", start: day(2, 9), end: day(2, 10), calendarId: pid, attendees: [{ email: "guest@example.com" }], conferenceUrl: "https://meet.google.com/abc-defg-hij" });
  await ev({ title: `Doctor ${stamp}`, description: "secret note", start: day(2, 11), end: day(2, 12), calendarId: pid, visibility: "private" });
  await ev({ title: `Maybe lunch ${stamp}`, start: day(2, 13), end: day(2, 14), calendarId: pid, transparency: "free" });
  check("someone who can't manage the calendar can't make it public", (await ws("/calendar/calendars", { id: pid, publicMode: "full" }, M, "PATCH")).status >= 403);
  const busyR = await ws("/calendar/calendars", { id: pid, publicMode: "busy" }, O, "PATCH");
  const pubUrl = busyR.json.calendar?.publicUrl as string;
  const token = pubUrl?.split("/embed/")[1] ?? "";
  check("make available to public (free/busy) gives an unguessable public address", busyR.json.calendar?.publicMode === "busy" && /\/workspace\/embed\/[A-Za-z0-9_-]{32,}$/.test(pubUrl ?? ""), busyR.json);
  const pub = async (tk: string, init: RequestInit = {}) => {
    const r = await fetch(`${WS}/api/calendar/embed/${tk}?from=${day(0, 0)}&to=${day(7, 0)}`, init);
    return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers };
  };
  let p = await pub(token);
  check("the public feed answers without signing in", p.status === 200 && p.json.calendar.name === `Public ${stamp}`);
  check("free/busy only: every event is just “Busy”, with no details", p.json.events.length === 2 && p.json.events.every((e: any) => e.title === "Busy" && !e.description && !e.location && e.busy));
  check("free/busy only: time marked as free isn't shown", !p.json.events.some((e: any) => e.start === day(2, 13)));
  check("no cookie is read or set by the public feed", !p.headers.get("set-cookie"));
  const withCookie = await pub(token, { headers: { cookie: M } });
  check("a signed-in viewer gets exactly the same public view", JSON.stringify(withCookie.json.events) === JSON.stringify(p.json.events));
  await ws("/calendar/calendars", { id: pid, publicMode: "full" }, O, "PATCH");
  p = await pub(token);
  const talk = p.json.events.find((e: any) => e.title === `Open talk ${stamp}`);
  check("full details: titles, places and descriptions show", talk?.location === "Hall A" && talk.description === "All welcome", p.json.events);
  check("full details: a private event still shows only as “Busy”", p.json.events.some((e: any) => e.start === day(2, 11) && e.title === "Busy" && !e.description) && !JSON.stringify(p.json).includes("secret note"));
  check("guests and video links never reach the public view", !JSON.stringify(p.json).includes("guest@example.com") && !JSON.stringify(p.json).includes("meet.google.com"));
  check("a wrong token is not found", (await pub(token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa"))).status === 404);
  check("a short or odd token is refused without a lookup", (await pub("abc")).status === 404 && (await pub("x".repeat(80))).status === 404);
  check("a range of more than 100 days is refused", (await fetch(`${WS}/api/calendar/embed/${token}?from=${day(0, 0)}&to=${day(200, 0)}`)).status === 400);
  const page = await fetch(`${WS}/embed/${token}?view=week&tz=Asia/Kolkata&color=0891b2&title=Talks`, { redirect: "manual" });
  check("the public page /workspace/embed/<token> opens without signing in", page.status === 200 && (await page.text()).includes("<html") && !page.headers.get("set-cookie"));
  check("…and isn't blocked from iframes", !/deny|sameorigin/i.test(page.headers.get("x-frame-options") ?? "") && !/frame-ancestors\s+'none'/.test(page.headers.get("content-security-policy") ?? ""));
  const reset = await ws("/calendar/calendars", { id: pid, publicReset: true }, O, "PATCH");
  check("a new public address stops the old one", reset.json.calendar.publicUrl !== pubUrl && (await pub(token)).status === 404);
  const tk2 = reset.json.calendar.publicUrl.split("/embed/")[1];
  await ws("/calendar/calendars", { id: pid, publicMode: "none" }, O, "PATCH");
  check("turning public access off stops the link", (await pub(tk2)).status === 404);

  // ── 4. Working location ───────────────────────────────────────────────
  const wd = String(new Date(day(3, 12)).getUTCDay());
  const wl = await ws("/calendar/settings", { location: { [wd]: "Office" } }, O, "PUT");
  check("a weekly working location is saved per weekday", wl.json.settings.location[wd] === "Office");
  const mark = await ev({ title: "Client site", start: dkey(3), end: dkey(4), allDay: true, eventType: "workingLocation", transparency: "free", reminders: [] });
  const ml = ((await range(O)).events as any[]).find((e) => e.id === mark.json.event.id);
  check("a one-day working location is kept for that date (overrides the weekly one)", ml?.eventType === "workingLocation" && ml.title === "Client site" && ml.allDay && ml.transparency === "free");
  await ws(`/calendar/events/${mark.json.event.id}`, { title: "Home" }, O, "PATCH");
  check("click-to-change: the day's location can be changed", ((await range(O)).events as any[]).find((e) => e.id === mark.json.event.id)?.title === "Home");
  check("a working location doesn't count as busy", !((await ws(`/calendar/busy?users=${oid}&from=${day(3, 0)}&to=${day(4, 0)}`, undefined, M)).json.busy?.[oid] ?? []).some((x: any) => x.start === `${dkey(3)}T00:00:00.000Z`));

  // ── 5. Offline service worker ─────────────────────────────────────────
  const sw = await fetch(`${WS}/calendar-sw.js`);
  const swText = await sw.text();
  check("the calendar service worker is served", sw.status === 200 && /javascript/.test(sw.headers.get("content-type") ?? ""));
  check("it keeps the app shell and saved event ranges, marking saved answers", swText.includes("/workspace/_next/static/") && swText.includes('"/workspace/api/calendar"') && swText.includes("x-cal-saved"));
  check("it only handles GETs (nothing is queued offline)", /if \(req\.method !== "GET"\) return;/.test(swText) && !/addEventListener\("sync"|backgroundfetch|indexedDB/i.test(swText));
  check("it only takes over the Calendar page (scope /workspace/calendar)", swText.includes('const PAGE = "/workspace/calendar"') && !/\/workspace\/(chat|meet|tasks)/.test(swText));
  for (const app of ["chat", "tasks", "meet"]) {
    const r = await fetch(`${WS}/${app}`, { headers: { cookie: O }, redirect: "manual" });
    check(`/workspace/${app} still routes normally`, r.status === 200 || r.status === 307 || r.status === 302, r.status);
  }
  const shell = await fetch(`${WS}/calendar`, { headers: { cookie: O } });
  check("the Calendar page still loads", shell.status === 200);

  // ── 6. Google: more calendars and RSVP both ways ──────────────────────
  const SCOPES = "openid email https://www.googleapis.com/auth/calendar";
  await web.query(
    `insert into google_connections (id, "userId", email, refresh, "accessToken", "expiresAt", scopes, "createdAt", "updatedAt")
     values ($1, $2, 'dev@gmail.example', '{}'::jsonb, $3, now() + interval '1 day', $4, now(), now())
     on conflict ("userId") do update set "accessToken" = $3, "expiresAt" = now() + interval '1 day', scopes = $4`,
    ["c-ws-google-test", oid, TOKEN, SCOPES],
  );
  await wsdb.query(`delete from google_sync where "userId" = $1`, [oid]);
  await wsdb.query(`delete from google_cal_links where "userId" = $1`, [oid]);
  await wsdb.query(`update events set "deletedAt" = coalesce("deletedAt", now()), "googleId" = null, "syncedAt" = now() where "calendarId" = $1`, [myCal]);
  const sync = async () => (await ws("/calendar/google", { action: "sync" }, O)).json;
  put("team@group.calendar.google.com", { id: "t1", summary: `G-Team sprint ${stamp}`, start: { dateTime: day(4, 9) }, end: { dateTime: day(4, 10) } });
  put("fun@group.calendar.google.com", { id: "f1", summary: `G-Fun day ${stamp}`, start: { date: dkey(6) }, end: { date: dkey(7) } });
  const gl = (await ws("/calendar/google?calendars=1", undefined, O)).json;
  check("list my Google calendars (primary marked)", gl.calendars?.length === 3 && gl.calendars.find((x: any) => x.primary)?.id === "dev@gmail.example", gl);
  check("the primary can't be linked again", (await ws("/calendar/google", { action: "link", googleCalId: "dev@gmail.example", calendarId: "new" }, O)).status === 400);
  const lk = await ws("/calendar/google", { action: "link", googleCalId: "team@group.calendar.google.com", calendarId: "new" }, O);
  const teamCal = lk.json.calendarId as string;
  if (teamCal) madeCals.push(teamCal);
  check("pick another Google calendar: it syncs into a new calendar here", lk.status === 200 && !!teamCal && lk.json.readOnly === false && lk.json.sync?.ok, lk.json);
  list = (await range(O)).events as any[];
  check("its events arrive in that calendar", list.some((e) => e.title === `G-Team sprint ${stamp}` && e.calendarId === teamCal && e.google));
  check("the new calendar carries the Google calendar's name", ((await range(O)).calendars as any[]).some((x) => x.id === teamCal && x.name === "G Team plans"));
  const n0 = calls.length;
  const te = await ev({ title: `W-Team retro ${stamp}`, start: day(5, 9), end: day(5, 10), calendarId: teamCal });
  check("an event made here in that calendar is written to that Google calendar (not the primary)", calls.slice(n0).some((x) => x.method === "POST" && x.path.includes("/calendars/team@group.calendar.google.com/events")) && !calls.slice(n0).some((x) => x.method === "POST" && x.path.includes("/calendars/primary/")) && [...cal("team@group.calendar.google.com").values()].some((g) => g.summary === `W-Team retro ${stamp}`));
  put("team@group.calendar.google.com", { ...cal("team@group.calendar.google.com").get("t1")!, summary: `G-Team sprint v2 ${stamp}` });
  await sync();
  check("a change in that Google calendar arrives", ((await range(O)).events as any[]).some((e) => e.title === `G-Team sprint v2 ${stamp}` && e.calendarId === teamCal));
  await ws(`/calendar/events/${te.json.event.id}`, undefined, O, "DELETE");
  check("deleting here deletes it in that Google calendar", [...cal("team@group.calendar.google.com").values()].find((g) => g.summary === `W-Team retro ${stamp}`)?.status === "cancelled");
  const lf = await ws("/calendar/google", { action: "link", googleCalId: "fun@group.calendar.google.com", calendarId: "new" }, O);
  if (lf.json.calendarId) madeCals.push(lf.json.calendarId);
  check("a view-only Google calendar syncs one way", lf.json.readOnly === true && ((await range(O)).events as any[]).some((e) => e.title === `G-Fun day ${stamp}` && e.calendarId === lf.json.calendarId));
  const n1 = calls.length;
  await ev({ title: `W-Local only ${stamp}`, start: day(6, 9), end: day(6, 10), calendarId: lf.json.calendarId });
  await sync();
  check("…nothing is written back to it", !calls.slice(n1).some((x) => x.method !== "GET" && x.path.includes("fun@group")));
  check("an unlinked side calendar isn't pushed to the primary", !calls.slice(n1).some((x) => x.method === "POST" && x.body?.summary === `W-Local only ${stamp}`));
  const n2 = calls.length;
  await ev({ title: `WL ${stamp}`, start: dkey(8), end: dkey(9), allDay: true, eventType: "workingLocation", transparency: "free" });
  check("a working-location marker isn't sent to Google", !calls.slice(n2).some((x) => x.method === "POST" && x.body?.summary === `WL ${stamp}`));
  await ws("/calendar/google", { action: "unlink", googleCalId: "team@group.calendar.google.com" }, O);
  const gl2 = (await ws("/calendar/google?calendars=1", undefined, O)).json;
  check("stop syncing a Google calendar (its calendar here stays)", !gl2.calendars.find((x: any) => x.id === "team@group.calendar.google.com").link && ((await range(O)).calendars as any[]).some((x) => x.id === teamCal));

  // RSVP: invited in Google by someone else.
  put("primary", {
    id: "inv1", summary: `G-Board review ${stamp}`, start: { dateTime: day(3, 15) }, end: { dateTime: day(3, 16) },
    organizer: { email: "boss@example.com", displayName: "The Boss" },
    attendees: [{ email: "boss@example.com", organizer: true, responseStatus: "accepted" }, { email: "dev@gmail.example", self: true, responseStatus: "needsAction" }],
  });
  await sync();
  let inv = ((await range(O)).events as any[]).find((e) => e.title === `G-Board review ${stamp}`);
  check("a Google invitation shows my reply as awaiting, organized by them", inv?.myResponse === "needs" && inv.googleOrganizer === "The Boss" && inv.canEdit === false, inv);
  const rr2 = await ws(`/calendar/events/${inv.id}/respond`, { response: "yes" }, O);
  const g1 = cal("primary").get("inv1")!;
  check("replying Yes here is sent to Google (my response status)", rr2.status === 200 && g1.attendees.find((x: any) => x.email === "dev@gmail.example")?.responseStatus === "accepted" && g1.summary === `G-Board review ${stamp}`, g1.attendees);
  check("…only the guest list is written (the organizer's details aren't touched)", Object.keys(calls.filter((x) => x.method === "PATCH" && x.path.endsWith("/inv1")).slice(-1)[0]?.body ?? {}).join() === "attendees");
  await sync();
  check("…and it doesn't echo back", ((await range(O)).events as any[]).find((e) => e.title === `G-Board review ${stamp}`)?.myResponse === "yes");
  put("primary", { ...g1, attendees: g1.attendees.map((x: any) => (x.email === "dev@gmail.example" ? { ...x, responseStatus: "tentative" } : x)) });
  await sync();
  inv = ((await range(O)).events as any[]).find((e) => e.title === `G-Board review ${stamp}`);
  check("a reply changed in Google arrives here (Maybe)", inv?.myResponse === "maybe", inv);
  // My own synced event: a colleague's reply reaches my Google copy.
  const own = await ev({ title: `W-Planning ${stamp}`, start: day(4, 12), end: day(4, 13), attendees: [{ userId: mid }] });
  await ws(`/calendar/events/${own.json.event.id}/respond`, { response: "no" }, M);
  const gOwn = [...cal("primary").values()].find((g) => g.summary === `W-Planning ${stamp}`);
  check("a colleague's reply to my synced event reaches Google", gOwn?.attendees?.find((x: any) => x.email === "member@localhost")?.responseStatus === "declined", gOwn?.attendees);

  // Contacts' birthdays (People API).
  contacts = [
    { resourceName: "people/c1", names: [{ displayName: `Asha ${stamp}` }], birthdays: [{ date: { year: 1988, month: bd.getUTCMonth() + 1, day: bd.getUTCDate() } }] },
    { resourceName: "people/c2", names: [{ displayName: `Ravi ${stamp}` }], birthdays: [{ date: { month: bd.getUTCMonth() + 1, day: bd.getUTCDate() } }] },
    { resourceName: "people/c3", names: [{ displayName: "No date" }] },
  ];
  const br = (await ws("/calendar/google", { action: "birthdays" }, O)).json;
  check("Google contacts' birthdays are read (People API)", br.ok && br.count === 2, br);
  check("the People call asks for names and birthdays", calls.some((x) => x.path === "/v1/people/me/connections"));
  const bl = ((await range(O)).events as any[]).filter((e) => e.calendarId === "birthdays" && e.google);
  check("they show on the Birthdays calendar, with the age when the year is known", bl.some((e) => e.title === `Asha ${stamp}'s birthday` && /^Turns \d+$/.test(e.description)) && bl.some((e) => e.title === `Ravi ${stamp}'s birthday` && e.description === ""), bl);
  check("my contacts' birthdays stay mine", !((await range(M)).events as any[]).some((e) => e.title === `Asha ${stamp}'s birthday`));
  peopleForbidden = true;
  const bf = (await ws("/calendar/google", { action: "birthdays" }, O)).json;
  check("without the contacts permission it says to reconnect (nothing breaks)", bf.ok === false && /contacts/.test(bf.error) && (await ws("/calendar/google", undefined, O)).json.birthdaysError?.includes("contacts"));
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  for (const id of made) await wsdb.query(`update events set "deletedAt" = coalesce("deletedAt", now()) where id = $1`, [id]);
  for (const id of madeCals) await wsdb.query(`delete from calendars where id = $1`, [id]);
  await wsdb.query(`update events set "deletedAt" = coalesce("deletedAt", now()), "googleId" = null, "syncedAt" = now() where "calendarId" = $1 and "googleId" is not null`, [myCal]);
  await wsdb.query(`delete from google_sync where "userId" = $1`, [oid]);
  await wsdb.query(`delete from google_cal_links where "userId" = $1`, [oid]);
  await wsdb.query(`delete from google_birthdays where "userId" = $1`, [oid]);
  await wsdb.query(`delete from calendar_subs where "userId" = $1 and "calendarId" = 'birthdays'`, [oid]);
  for (const u of before) await wsdb.query(`update users set birthday = $2, "birthdayShare" = $3, "calSettings" = $4 where id = $1`, [u.id, u.birthday, u.birthdayShare, u.calSettings]);
  if (backup) await web.query(`update google_connections set "accessToken" = $2, "expiresAt" = $3, scopes = $4 where "userId" = $1`, [oid, backup.accessToken, backup.expiresAt, backup.scopes]);
  else await web.query(`delete from google_connections where "userId" = $1`, [oid]);
  await web.end();
  await wsdb.end();
  server.close();
}
void ORIGIN;
process.exit(summary("Calendar round 2") ? 1 : 0);
