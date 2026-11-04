/**
 * IOTx Workspace — two-way Google Calendar sync against a local mock of the
 * Calendar API (http://127.0.0.1:4800; start Workspace with
 * GOOGLE_API_BASE=http://127.0.0.1:4800). The dev user's Google connection in
 * the suite DB is pointed at a mock token for the run and restored after.
 *   npx tsx scripts/test-google.mts <devToken> <test-users.json>
 */
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { check, envOf, MEMBER, OWNER, setup, signIn, summary, suite, ws, SUITE } from "./lib.mts";

const here = (p: string) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const WEB_DB = envOf(here("../../../web/.env")).DATABASE_URL;
const WS_DB = envOf(here("../.env")).DATABASE_URL;
const KEY = envOf(here("../.env")).IOTX_SERVICE_KEY;
const TOKEN = "mock-cal-token";

// ── Mock Google Calendar API ────────────────────────────────────────────
type GE = Record<string, any> & { id: string; _v: number };
const store = new Map<string, GE>();
let ver = 0;
let lastTs = 0;
let expireTokens = false;
const calls: { method: string; path: string; q: string; body?: any }[] = [];
const stampNow = () => new Date((lastTs = Math.max(Date.now(), lastTs + 5))).toISOString();
function put(e: Record<string, any>) {
  const g = { status: "confirmed", ...e, updated: stampNow(), _v: ++ver } as unknown as GE;
  store.set(g.id, g);
  return g;
}
const strip = ({ _v, ...rest }: GE) => rest;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let raw = "";
  for await (const ch of req) raw += ch;
  const body = raw ? JSON.parse(raw) : undefined;
  calls.push({ method: req.method ?? "", path: url.pathname, q: url.search, body });
  const send = (s: number, d?: unknown) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(d === undefined ? "" : JSON.stringify(d));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { message: "bad token" } });
  // Contacts' birthdays (read once a day with a sync): none here; test-calendar-plus covers them.
  if (url.pathname === "/v1/people/me/connections") return send(200, { connections: [] });
  const m = /^\/calendar\/v3\/calendars\/primary\/events(?:\/([^/]+))?$/.exec(url.pathname);
  if (!m) return send(404, { error: { message: "not found" } });
  const id = m[1] ? decodeURIComponent(m[1]) : null;
  if (!id && req.method === "GET") {
    const st = url.searchParams.get("syncToken");
    if (st && expireTokens) {
      expireTokens = false;
      return send(410, { error: { message: "Sync token is no longer valid" } });
    }
    const since = st ? Number(st.slice(1)) : -1;
    // Like Google: a full listing (showDeleted=false, singleEvents=false) omits
    // cancelled events but still includes cancelled instances of a series.
    const all = [...store.values()].filter((e) => (st ? e._v > since : e.status !== "cancelled" || !!e.recurringEventId)).sort((a, b) => a._v - b._v);
    const off = Number(url.searchParams.get("pageToken") ?? 0);
    const size = 2; // small pages, so paging is exercised
    const page = all.slice(off, off + size);
    const more = off + size < all.length;
    return send(200, { items: page.map(strip), ...(more ? { nextPageToken: String(off + size) } : { nextSyncToken: `s${ver}` }) });
  }
  if (!id && req.method === "POST") return send(200, strip(put({ ...body, id: crypto.randomBytes(8).toString("hex") })));
  if (id && req.method === "PATCH") {
    const cur = store.get(id);
    if (!cur) {
      const mm = /^(.+)_(\d{8}(?:T\d{6}Z)?)$/.exec(id);
      if (!mm || !store.has(mm[1])) return send(404, { error: { message: "Not Found" } });
      const s = mm[2];
      const orig = s.length === 8 ? { date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` } : { dateTime: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` };
      return send(200, strip(put({ ...body, id, recurringEventId: mm[1], originalStartTime: orig })));
    }
    return send(200, strip(put({ ...cur, ...body, id })));
  }
  if (id && req.method === "DELETE") {
    const cur = store.get(id);
    if (!cur || cur.status === "cancelled") return send(410, { error: { message: "Gone" } });
    put({ ...cur, status: "cancelled" });
    res.writeHead(204);
    return res.end();
  }
  if (id && req.method === "GET") return store.has(id) ? send(200, strip(store.get(id)!)) : send(404, {});
  send(405, {});
});
await new Promise<void>((r) => server.listen(4800, "127.0.0.1", r));

// "Someone edits in Google" helpers.
const remote = {
  create: (e: Record<string, any>) => put({ id: crypto.randomBytes(8).toString("hex"), ...e }),
  edit: (id: string, patch: Record<string, any>) => put({ ...store.get(id)!, ...patch }),
  cancel: (id: string) => put({ ...store.get(id)!, status: "cancelled" }),
};
const byTitle = (t: string) => [...store.values()].filter((e) => e.summary === t);

// ── Point the dev user's suite Google connection at the mock token ─────
const web = new pg.Client({ connectionString: WEB_DB });
await web.connect();
const wsdb = new pg.Client({ connectionString: WS_DB });
await wsdb.connect();
const { wsId } = await setup();
const O = await signIn(OWNER);
const me = (await ws("/me", undefined, O)).json.me as { id: string };
const backup = (await web.query(`select * from google_connections where "userId" = $1`, [me.id])).rows[0] ?? null;
const SCOPES = "openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar";
await web.query(
  `insert into google_connections (id, "userId", email, refresh, "accessToken", "expiresAt", scopes, "createdAt", "updatedAt")
   values ($1, $2, 'dev@gmail.example', '{}'::jsonb, $3, now() + interval '1 day', $4, now(), now())
   on conflict ("userId") do update set "accessToken" = $3, "expiresAt" = now() + interval '1 day', scopes = $4`,
  ["c-ws-google-test", me.id, TOKEN, SCOPES],
);
// Start from a clean sync state for the dev user.
const cal = (await wsdb.query(`select id from calendars where ws = $1 and kind = 'personal' and "ownerId" = $2`, [wsId, me.id])).rows[0];
await wsdb.query(`delete from google_sync where "userId" = $1`, [me.id]);
await wsdb.query(`update events set "deletedAt" = coalesce("deletedAt", now()), "googleId" = null, "syncedAt" = now() where "calendarId" = $1`, [cal.id]);

const day = (n: number, h: number, m = 0) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n, h, m)).toISOString();
};
const range = `from=${day(-1, 0)}&to=${day(30, 0)}&sync=0`;
const localList = async () => (await ws(`/calendar?${range}`, undefined, O)).json.events as any[];
const sync = async () => (await ws("/calendar/google", { action: "sync" }, O)).json;

try {
  // ── The suite's token endpoint
  const noKey = await fetch(`${SUITE}/api/iotx/google-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: me.id }) });
  check("suite /api/iotx/google-token refuses calls without the service key", noKey.status === 403);
  const wrongKey = await fetch(`${SUITE}/api/iotx/google-token`, { method: "POST", headers: { "content-type": "application/json", "x-iotx-key": "nope" }, body: JSON.stringify({ userId: me.id }) });
  check("…and with a wrong key", wrongKey.status === 403);
  const okKey = await fetch(`${SUITE}/api/iotx/google-token`, { method: "POST", headers: { "content-type": "application/json", "x-iotx-key": KEY }, body: JSON.stringify({ userId: me.id }) });
  check("with the key: a fresh token for a person whose connection includes Calendar", okKey.status === 200 && (await okKey.json()).accessToken === TOKEN);
  const M = await signIn(MEMBER);
  const mid = (await ws("/me", undefined, M)).json.me.id;
  const mHad = (await web.query(`select 1 from google_connections where "userId" = $1`, [mid])).rowCount;
  const noCal = await fetch(`${SUITE}/api/iotx/google-token`, { method: "POST", headers: { "content-type": "application/json", "x-iotx-key": KEY }, body: JSON.stringify({ userId: mid }) });
  check("someone without a Calendar connection gets 409 { reconnect: true }", noCal.status === 409 && (await noCal.json()).reconnect === true, mHad);
  const mg = (await ws("/calendar/google", undefined, M)).json;
  check("Workspace shows “Connect Google Calendar” for them, linking to the suite's connect flow", mg.connected === false && /\/api\/google\/connect\?back=%2Fworkspace%2Fcalendar$/.test(mg.connectUrl), mg);
  const st = (await ws("/calendar/google", undefined, O)).json;
  check("the dev user shows as connected", st.allowed && st.connected, st);

  // ── Import
  const g1 = remote.create({ summary: "G-Design review", start: { dateTime: day(2, 10), timeZone: "Europe/London" }, end: { dateTime: day(2, 11), timeZone: "Europe/London" }, hangoutLink: "https://meet.google.com/xyz-abcd-efg", attendees: [{ email: "dev@gmail.example", self: true, responseStatus: "accepted" }, { email: "member@localhost", responseStatus: "tentative" }, { email: "vendor@example.com", responseStatus: "needsAction" }] });
  const g2 = remote.create({ summary: "G-Holiday", start: { date: day(3, 0).slice(0, 10) }, end: { date: day(4, 0).slice(0, 10) } });
  const g3 = remote.create({ summary: "G-Weekly 1:1", start: { dateTime: day(1, 15), timeZone: "UTC" }, end: { dateTime: day(1, 15, 30), timeZone: "UTC" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"] });
  remote.create({ id: `${g3.id}_${day(8, 15).replace(/[-:]/g, "").replace(".000", "")}`, summary: "G-Weekly 1:1 (moved)", recurringEventId: g3.id, originalStartTime: { dateTime: day(8, 15) }, start: { dateTime: day(9, 16) }, end: { dateTime: day(9, 16, 30) } });
  remote.create({ id: `${g3.id}_${day(15, 15).replace(/[-:]/g, "").replace(".000", "")}`, status: "cancelled", recurringEventId: g3.id, originalStartTime: { dateTime: day(15, 15) } });
  const g4 = remote.create({ summary: "G-Zoom call", location: "https://us02web.zoom.us/j/123456789?pwd=abc", start: { dateTime: day(5, 9) }, end: { dateTime: day(5, 10) } });
  const r1 = await sync();
  check("first sync imports the primary calendar (paged)", r1.ok && r1.created >= 5, r1);
  const firstList = calls.find((c) => c.method === "GET" && c.path.endsWith("/events"));
  const fq = new URLSearchParams(firstList?.q ?? "");
  const back = (Date.now() - new Date(fq.get("timeMin") ?? 0).getTime()) / 86_400_000, ahead = (new Date(fq.get("timeMax") ?? 0).getTime() - Date.now()) / 86_400_000;
  check("the first import asks for 3 months back to 12 ahead", back > 88 && back < 95 && ahead > 360 && ahead < 370 && fq.get("singleEvents") === "false", firstList?.q);
  let L = await localList();
  const d1 = L.find((e) => e.title === "G-Design review");
  check("a timed event arrives with the right time", d1?.start === day(2, 10) && d1.google === true);
  check("Google Meet link shows as Join", d1?.conferenceUrl === "https://meet.google.com/xyz-abcd-efg");
  check("guests come through, workspace people matched by email", d1?.attendees.some((a: any) => a.email === "member@localhost" && a.userId === mid && a.response === "maybe") && d1.attendees.some((a: any) => a.email === "vendor@example.com" && a.userId === null));
  check("an all-day event arrives as all-day", L.some((e) => e.title === "G-Holiday" && e.allDay && e.start === day(3, 0)));
  const wk = L.filter((e) => e.title.startsWith("G-Weekly 1:1"));
  check("a repeating series expands; its changed occurrence replaces the original; its cancelled one is gone", wk.length === 3 && wk.some((e) => e.title === "G-Weekly 1:1 (moved)" && e.start === day(9, 16)) && !wk.some((e) => e.start === day(15, 15)) && !wk.some((e) => e.start === day(8, 15)), wk.map((e) => `${e.title}@${e.start}`));
  check("a Zoom link in the location shows as Join", L.find((e) => e.title === "G-Zoom call")?.conferenceUrl?.startsWith("https://us02web.zoom.us/j/123456789"));
  const count1 = L.length;
  const r2 = await sync();
  L = await localList();
  check("syncing again (incremental, syncToken) duplicates nothing", r2.ok && r2.created === 0 && L.length === count1, r2);
  check("the incremental pull used the syncToken", calls.filter((c) => c.method === "GET" && c.path.endsWith("/events")).slice(-1)[0]?.q.includes("syncToken=s"));

  // ── Google → IOTx: change and delete
  remote.edit(g1.id, { summary: "G-Design review v2", start: { dateTime: day(2, 13) }, end: { dateTime: day(2, 14) } });
  remote.cancel(g2.id);
  const r3 = await sync();
  L = await localList();
  check("a change made in Google arrives", L.some((e) => e.title === "G-Design review v2" && e.start === day(2, 13)) && !L.some((e) => e.title === "G-Design review"), r3);
  check("a deletion in Google removes it here", !L.some((e) => e.title === "G-Holiday"));

  // ── IOTx → Google: create, edit, delete
  const before = calls.length;
  const c = await ws("/calendar/events", { title: "W-Created here", start: day(4, 9), end: day(4, 10), tz: "UTC", location: "HQ" }, O);
  const local = (await ws(`/calendar/events/${c.json.event.id}`, undefined, O)).json.event;
  const gl = byTitle("W-Created here");
  check("an event created in IOTx is written to Google", calls.slice(before).some((x) => x.method === "POST") && gl.length === 1 && gl[0].location === "HQ");
  check("…and keeps the Google event id", local.googleId === gl[0]?.id);
  await sync();
  L = await localList();
  check("…and doesn't come back as a duplicate", L.filter((e) => e.title === "W-Created here").length === 1 && byTitle("W-Created here").length === 1);
  await ws(`/calendar/events/${c.json.event.id}`, { title: "W-Edited here", start: day(4, 11), end: day(4, 12) }, O, "PATCH");
  check("an edit in IOTx is written to Google", store.get(gl[0].id)?.summary === "W-Edited here" && store.get(gl[0].id)?.start?.dateTime === day(4, 11));
  await sync();
  L = await localList();
  check("…without echoing back as a change", L.filter((e) => e.title === "W-Edited here").length === 1);
  await ws(`/calendar/events/${c.json.event.id}`, undefined, O, "DELETE");
  check("a deletion in IOTx deletes it in Google", store.get(gl[0].id)?.status === "cancelled");
  await sync();
  L = await localList();
  check("…and it stays deleted after the next pull", !L.some((e) => e.title === "W-Edited here"));

  // Repeating event made here, one occurrence changed and one removed.
  const rs = await ws("/calendar/events", { title: "W-Series", start: day(1, 7), end: day(1, 7, 30), tz: "UTC", rrule: "FREQ=DAILY;COUNT=5" }, O);
  const gs = byTitle("W-Series")[0];
  check("a repeating event is written with its RRULE", gs?.recurrence?.[0] === "RRULE:FREQ=DAILY;COUNT=5");
  await ws(`/calendar/events/${rs.json.event.id}`, { title: "W-Series (one)", scope: "this", occ: day(2, 7) }, O, "PATCH");
  check("“this event” edits write the Google instance", [...store.values()].some((e) => e.recurringEventId === gs.id && e.summary === "W-Series (one)"));
  await ws(`/calendar/events/${rs.json.event.id}?scope=this&occ=${encodeURIComponent(day(3, 7))}`, undefined, O, "DELETE");
  check("“this event” deletions reach Google as an EXDATE", (store.get(gs.id)?.recurrence ?? []).some((l: string) => l.startsWith("EXDATE") && l.includes(day(3, 7).slice(0, 10).replace(/-/g, ""))));
  await sync();
  L = await localList();
  const ser = L.filter((e) => e.title.startsWith("W-Series"));
  check("after the round trip the series is intact: 4 occurrences, one changed, no duplicates", ser.length === 4 && ser.filter((e) => e.title === "W-Series (one)").length === 1, ser.map((e) => `${e.title}@${e.start}`));

  // ── Latest change wins
  const lw = await ws("/calendar/events", { title: "W-Conflict", start: day(6, 9), end: day(6, 10), tz: "UTC" }, O);
  const gid = byTitle("W-Conflict")[0].id;
  await new Promise((r) => setTimeout(r, 50));
  remote.edit(gid, { summary: "W-Conflict (Google, newer)" });
  await sync();
  check("a newer change in Google wins over an older local one", (await localList()).some((e) => e.title === "W-Conflict (Google, newer)"));
  await ws(`/calendar/events/${lw.json.event.id}`, { title: "W-Conflict (IOTx, newest)" }, O, "PATCH");
  await sync();
  check("a newer local change wins and is written to Google", store.get(gid)?.summary === "W-Conflict (IOTx, newest)" && (await localList()).some((e) => e.title === "W-Conflict (IOTx, newest)"));

  // ── Expired sync token: full re-import without duplicates
  expireTokens = true;
  const r4 = await sync();
  const L4 = await localList();
  check("an expired syncToken (410) triggers a full re-import with no duplicates", r4.ok && L4.length === (await localList()).length && L4.filter((e) => e.title === "G-Zoom call").length === 1 && L4.filter((e) => e.title === "W-Conflict (IOTx, newest)").length === 1, r4);

  // ── Opening Calendar triggers a sync; nothing leaks across workspaces
  remote.create({ summary: "G-Page load", start: { dateTime: day(7, 9) }, end: { dateTime: day(7, 10) } });
  await wsdb.query(`update google_sync set "lastSyncAt" = now() - interval '1 minute' where "userId" = $1`, [me.id]);
  await ws(`/calendar?from=${day(-1, 0)}&to=${day(30, 0)}`, undefined, O);
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 250));
    seen = (await localList()).some((e) => e.title === "G-Page load");
  }
  check("opening Calendar starts a sync (page load)", seen);
  const X = await signIn((await import("./lib.mts")).OUTSIDER);
  const xl = (await ws(`/calendar?${range}`, undefined, X)).json.events as any[];
  check("imported Google events stay in their owner's workspace", !xl.some((e) => e.title.startsWith("G-")));
  check("a member can't trigger someone else's sync (only their own)", (await ws("/calendar/google", { action: "sync" }, M)).status === 409);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  // Remove what the run made and restore the suite connection.
  await wsdb.query(`update events set "deletedAt" = coalesce("deletedAt", now()), "googleId" = null, "syncedAt" = now() where "calendarId" = $1`, [cal.id]);
  await wsdb.query(`delete from google_sync where "userId" = $1`, [me.id]);
  if (backup) await web.query(`update google_connections set "accessToken" = $2, "expiresAt" = $3, scopes = $4 where "userId" = $1`, [me.id, backup.accessToken, backup.expiresAt, backup.scopes]);
  else await web.query(`delete from google_connections where "userId" = $1`, [me.id]);
  await web.end();
  await wsdb.end();
  server.close();
}
process.exit(summary("Google sync") ? 1 : 0);
