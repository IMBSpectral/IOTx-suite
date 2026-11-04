/**
 * IOTx Workspace — Meet: meetings, member and guest join (waiting room,
 * admit, deny), host controls against the local LiveKit server, token grants,
 * recording and AI-notes permissions, Egress recording with a real WebRTC
 * participant, AI notes (OpenAI transcription + Claude), notes to tasks and
 * chat, the calendar's "Add video meeting" and chat's "Start a call".
 *   npx tsx scripts/test-meet.mts <devToken> <test-users.json>
 * Needs: LiveKit (iotx-livekit) on :7880, Egress (iotx-meet-egress) and its
 * Redis (iotx-meet-redis). SKIP_LIVE_AI=1 skips the OpenAI/Claude calls.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { check, envOf, OUTSIDER, OWNER, setup, signIn, sleep, summary, ws, WS } from "./lib.mts";

const env = envOf(path.join(import.meta.dirname, "..", ".env"));
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();

/** Guest calls: no Workspace cookie at all. */
async function anon(p: string, body?: unknown, headers: Record<string, string> = {}, method?: string) {
  const r = await fetch(`${WS}/api${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any, headers: r.headers };
}
const jwt = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));

/** The LiveKit room, read straight from the room service with an admin token. */
async function listRoom(name: string) {
  const { AccessToken } = await import("livekit-server-sdk");
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { ttl: 60 });
  at.addGrant({ roomList: true, roomAdmin: true, room: name });
  const res = await fetch("http://localhost:7880/twirp/livekit.RoomService/ListRooms", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await at.toJwt()}` },
    body: JSON.stringify({ names: [name] }),
  });
  const d = (await res.json().catch(() => ({}))) as { rooms?: { metadata?: string }[] };
  return d.rooms?.[0] ?? null;
}

const { MEMBER } = await setup();
const O = await signIn(OWNER, "meetings");
const M = await signIn(MEMBER, "meetings");
const X = await signIn(OUTSIDER, "meetings").catch(() => "");
const owner = (await ws("/me", undefined, O)).json.me;
const member = (await ws("/me", undefined, M)).json.me;
check("owner has the Meet switches (suite manifest live)", owner.perms["meetings.open"] && owner.perms["meetings.create"] && owner.perms["meetings.record"] && owner.perms["meetings.ai_notes"], owner.perms);
check("member defaults: create on, record and AI notes off", member.perms["meetings.create"] === true && !member.perms["meetings.record"] && !member.perms["meetings.ai_notes"], member.perms);

// ── Create and get by code ──────────────────────────────────────────────
let r = await ws("/meet", { title: "Weekly sync (test)" }, O);
check("create meeting -> 201", r.status === 201, r);
const code = r.json.meeting?.code as string;
check("code looks like abc-defg-hij", /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code ?? ""), code);
check("meeting url points at /workspace/meet/<code>", String(r.json.meeting?.url).endsWith(`/workspace/meet/${code}`), r.json.meeting?.url);
check("waiting room and guests on by default", r.json.meeting?.waitingRoom === true && r.json.meeting?.allowGuests === true, r.json.meeting);
const mtg = (await db.query("select * from meetings where code=$1", [code])).rows[0];
r = await anon(`/meet/${code}`);
check("get by code works without an account", r.status === 200 && r.json.meeting.title === "Weekly sync (test)" && r.json.meeting.you === null, r);
check("anonymous view doesn't include host-only fields", r.json.meeting.recordings === undefined && r.json.meeting.waiting === undefined, r.json.meeting);
r = await ws(`/meet/${code}`, undefined, O);
check("host view: settings, permissions, waiting count", r.json.meeting?.you?.host === true && r.json.meeting.can?.record === true && r.json.meeting.waiting === 0, r.json);
r = await ws(`/meet/${code.toUpperCase()}`, undefined, M);
check("code lookup is case-insensitive; member is not host", r.status === 200 && r.json.meeting.you?.host === false, r);
check("unknown code -> 404", (await anon("/meet/zzz-zzzz-zzz")).status === 404 && (await anon("/meet/not-a-code")).status === 404);
const page = await fetch(`${WS}/meet/${code}`);
check("meeting page renders for anyone (no sign-in bounce)", page.status === 200 && (await page.text()).includes("Weekly sync (test)"));

// ── Member join token ───────────────────────────────────────────────────
r = await ws(`/meet/${code}/join`, {}, O);
check("host joins -> token with role host", r.status === 200 && r.json.status === "admitted" && r.json.role === "host" && !!r.json.token, r);
const hostTok = jwt(r.json.token);
check("host token: right room, identity, no admin/record grants", hostTok.video?.room === `meet_${mtg.id}` && hostTok.sub === `u_${owner.id}` && !hostTok.video?.roomAdmin && !hostTok.video?.roomRecord, hostTok);
check("join reply carries the LiveKit URL for browsers", /^wss?:\/\//.test(r.json.url), r.json.url);
r = await ws(`/meet/${code}/join`, {}, M);
check("member joins straight in (no waiting room for members)", r.status === 200 && r.json.status === "admitted" && r.json.role === "member", r);
const memTok = jwt(r.json.token);
check("member token: roomJoin, publish, subscribe, data; can't change own metadata", memTok.video?.roomJoin && memTok.video?.canPublish && memTok.video?.canSubscribe && memTok.video?.canPublishData && memTok.video?.canUpdateOwnMetadata === false && JSON.parse(memTok.metadata).role === "member", memTok);
check("tokens expire (short TTL)", memTok.exp - memTok.nbf <= 15 * 60 + 5 || memTok.exp - memTok.iat <= 15 * 60 + 5, memTok);

// ── Guest join, waiting room, admit ─────────────────────────────────────
r = await anon(`/meet/${code}/join`, {});
check("guest without a name -> 400", r.status === 400, r);
r = await anon(`/meet/${code}/join`, { name: "  Guest   One " });
check("guest asks to join -> waiting + key", r.status === 200 && r.json.status === "waiting" && typeof r.json.key === "string" && !r.json.token, r);
const g1 = r.json.key as string;
r = await anon(`/meet/${code}/join`, { key: g1 });
check("guest checks back -> still waiting, no token", r.json.status === "waiting" && !r.json.token, r);
r = await anon(`/meet/${code}/join`, {}, { "x-meet-guest": g1 });
check("guest key also works in the x-meet-guest header", r.json.status === "waiting", r);
check("guest key stored only as a hash", !(await db.query('select 1 from meet_participants where "keyHash"=$1', [g1])).rowCount);
r = await anon(`/meet/${code}/join`, { key: "not-a-real-key" });
check("unknown guest key -> 404", r.status === 404, r);
r = await ws(`/meet/${code}/lobby`, undefined, O);
const w1 = r.json.waiting?.find((w: any) => w.name === "Guest One");
check("host sees the guest in the waiting room (name cleaned)", r.status === 200 && !!w1, r.json);
check("member can't see the waiting room", (await ws(`/meet/${code}/lobby`, undefined, M)).status === 403);
check("guest can't see the waiting room", (await anon(`/meet/${code}/lobby`, undefined, { "x-meet-guest": g1 })).status === 403);
check("member can't admit", (await ws(`/meet/${code}/lobby`, { participantId: w1?.id, action: "admit" }, M)).status === 403);
check("guest can't admit themselves", (await anon(`/meet/${code}/lobby`, { participantId: w1?.id, action: "admit" }, { "x-meet-guest": g1 })).status === 403);
r = await ws(`/meet/${code}/lobby`, { participantId: w1?.id, action: "admit" }, O);
check("host admits the guest", r.status === 200 && r.json.count === 1, r);
r = await anon(`/meet/${code}/join`, { key: g1 });
check("admitted guest gets a token", r.status === 200 && r.json.status === "admitted" && r.json.role === "guest" && !!r.json.token, r);
const gTok = jwt(r.json.token);
check("guest token: guest role, g_ identity, no host grants", JSON.parse(gTok.metadata).role === "guest" && gTok.sub.startsWith("g_") && !gTok.video.roomAdmin && !gTok.video.roomRecord && !gTok.video.roomCreate && gTok.video.canUpdateOwnMetadata === false && gTok.name === "Guest One", gTok);
r = await anon(`/meet/${code}/join`, { key: g1, asGuest: true, role: "host" });
check("a guest can't ask for host role", JSON.parse(jwt(r.json.token).metadata).role === "guest", r.json);

// ── Deny ────────────────────────────────────────────────────────────────
r = await anon(`/meet/${code}/join`, { name: "Gate Crasher" });
const g2 = r.json.key as string;
const w2 = (await ws(`/meet/${code}/lobby`, undefined, O)).json.waiting.find((w: any) => w.name === "Gate Crasher");
r = await ws(`/meet/${code}/lobby`, { participantId: w2.id, action: "deny" }, O);
check("host denies", r.status === 200, r);
r = await anon(`/meet/${code}/join`, { key: g2 });
check("denied guest -> 403 denied, no token", r.status === 403 && r.json.status === "denied" && !r.json.token, r);
check("deciding twice -> 404", (await ws(`/meet/${code}/lobby`, { participantId: w2.id, action: "admit" }, O)).status === 404);

// ── Host-only controls ──────────────────────────────────────────────────
for (const action of ["mute_all", "lock", "end", "remove"]) {
  const a = await ws(`/meet/${code}/control`, { action, identity: `u_${owner.id}` }, M);
  const b = await anon(`/meet/${code}/control`, { action }, { "x-meet-guest": g1 });
  check(`"${action}" refused for a member (403) and a guest (403)`, a.status === 403 && b.status === 403, { a, b });
}
check("member can't change settings", (await ws(`/meet/${code}`, { waitingRoom: false }, M, "PATCH")).status === 403);
check("guest can't change settings", (await anon(`/meet/${code}`, { locked: true }, { "x-meet-guest": g1 }, "PATCH")).status === 403);
r = await ws(`/meet/${code}/control`, { action: "mute_all" }, O);
check("host: mute all (LiveKit room service)", r.status === 200 && r.json.ok === true, r);
r = await ws(`/meet/${code}/control`, { action: "lock" }, O);
check("host: lock", r.status === 200 && r.json.locked === true, r);
r = await anon(`/meet/${code}/join`, { name: "Late Guest" });
check("locked: new guests can't even wait (423)", r.status === 423 && r.json.status === "locked", r);
r = await ws(`/meet/${code}/join`, {}, M);
check("locked: someone already admitted can rejoin", r.status === 200, r);
const lkRoom = await listRoom(`meet_${mtg.id}`);
const meta = JSON.parse(lkRoom?.metadata || "{}");
check("LiveKit room exists and its metadata says locked", !!lkRoom && meta.locked === true, lkRoom);
r = await ws(`/meet/${code}/control`, { action: "unlock" }, O);
check("host: unlock", r.json.locked === false, r);
r = await ws(`/meet/${code}/control`, { action: "remove", identity: `u_${member.id}` }, O);
check("host: remove a participant", r.status === 200, r);
r = await ws(`/meet/${code}/join`, {}, M);
check("removed member can't rejoin", r.status === 403 && r.json.status === "removed", r);
check("host can't remove themselves", (await ws(`/meet/${code}/control`, { action: "remove", identity: `u_${owner.id}` }, O)).status === 400);
r = await anon(`/meet/${code}/hand`, { up: true }, { "x-meet-guest": g1 });
check("admitted guest can raise a hand", r.status === 200 && r.json.up === true, r);
check("denied guest can't raise a hand", (await anon(`/meet/${code}/hand`, { up: true }, { "x-meet-guest": g2 })).status === 403);
r = await ws(`/meet/${code}`, { waitingRoom: false }, O, "PATCH");
check("host turns the waiting room off", r.status === 200 && r.json.settings.waitingRoom === false, r);
r = await anon(`/meet/${code}/join`, { name: "Auto Guest" });
check("no waiting room: guest gets a token at once", r.json.status === "admitted" && !!r.json.token && !!r.json.key, r);
r = await ws(`/meet/${code}`, { allowGuests: false, waitingRoom: true }, O, "PATCH");
r = await anon(`/meet/${code}/join`, { name: "Blocked" });
check("members-only meeting refuses guests", r.status === 403 && r.json.status === "members_only", r);
if (X) {
  r = await ws(`/meet/${code}/join`, {}, X);
  check("someone from another organization is a guest, not a member", r.status === 403 && r.json.status === "members_only", r);
}
await ws(`/meet/${code}`, { allowGuests: true }, O, "PATCH");

// ── Recording and AI notes permissions ──────────────────────────────────
r = await ws("/meet", { title: "Member's meeting (test)" }, M);
check("member can start a meeting", r.status === 201, r);
const mcode = r.json.meeting.code as string;
await ws(`/meet/${mcode}/join`, {}, M);
r = await ws(`/meet/${mcode}/record`, { kind: "video", action: "start" }, M);
check("member host without meetings.record can't record", r.status === 403 && r.json.key === "meetings.record", r);
r = await ws(`/meet/${mcode}/record`, { kind: "audio", action: "start" }, M);
check("member host without meetings.ai_notes can't take AI notes", r.status === 403 && r.json.key === "meetings.ai_notes", r);
r = await ws(`/meet/${mcode}/notes`, { action: "regenerate" }, M);
check("…or regenerate notes", r.status === 403, r);
r = await ws(`/meet/${code}/record`, { kind: "video", action: "start" }, M);
check("non-host can't record someone else's meeting", r.status === 403, r);
r = await anon(`/meet/${code}/record`, { kind: "audio", action: "start" }, { "x-meet-guest": g1 });
check("guest can't record", r.status === 403, r);
check("only people in the meeting can read its notes", (await anon(`/meet/${code}/notes`)).status === 404 && (await ws(`/meet/${code}/notes`, undefined, O)).status === 200);

// ── Recording + AI notes, end to end ────────────────────────────────────
// A headless participant (@livekit/rtc-node) joins as a guest and speaks a
// short meeting (OpenAI text-to-speech); Egress records the video and the
// notes audio; stopping AI notes transcribes (OpenAI) and summarizes (Claude).
const RECS = path.join(import.meta.dirname, "..", "storage", "meet-recordings");
r = await ws("/meet", { title: "Pune launch sync (test)" }, O);
const rcode = r.json.meeting.code as string;
const live = !process.env.SKIP_LIVE_AI && !!env.OPENAI_API_KEY;
let pcm: Int16Array | null = null;
if (live) {
  let buf = Buffer.alloc(0);
  let status = 0;
  for (let attempt = 0; attempt < 3 && !buf.length; attempt++) {
    try {
      const speech = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          response_format: "pcm",
          input:
            "Okay everyone, quick sync on the Pune warehouse launch. We decided to move the launch to the fifteenth of November. Ravi will send the revised vendor quotation by Friday. Priya will update the GST invoice template before the launch. That's all, thanks.",
        }),
      });
      status = speech.status;
      if (speech.ok) buf = Buffer.from(await speech.arrayBuffer());
    } catch (e) {
      console.log("TTS retry:", (e as Error).message);
    }
  }
  check("test speech generated (OpenAI text-to-speech)", buf.length > 10_000, status);
  pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length - (buf.length % 2))));
}
const { Room, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource } = await import("@livekit/rtc-node");
const bot = new Room();
const botJoin = (await anon(`/meet/${rcode}/join`, { name: "Speaker Bot" })).json;
await ws(`/meet/${rcode}/lobby`, { all: true, action: "admit" }, O);
const botTok = (await anon(`/meet/${rcode}/join`, { key: botJoin.key })).json;
await ws(`/meet/${rcode}/join`, {}, O);
let connected = false;
try {
  await bot.connect(botTok.url, botTok.token, { autoSubscribe: false, dynacast: false });
  connected = true;
} catch (e) {
  console.log("bot connect failed", (e as Error).message);
}
check("a guest connects to LiveKit with the issued token (WebRTC)", connected);
const SR = 24000;
const F = SR / 100;
const source = new AudioSource(SR, 1);
const track = LocalAudioTrack.createAudioTrack("mic", source);
if (connected) await bot.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
// A camera too: a moving colour band, 15 fps (room-composite recording starts on video).
const { VideoSource, VideoFrame, LocalVideoTrack, VideoBufferType } = await import("@livekit/rtc-node");
const VW = 320, VH = 180;
const vsrc = new VideoSource(VW, VH);
const vtrack = LocalVideoTrack.createVideoTrack("cam", vsrc);
if (connected) await bot.localParticipant!.publishTrack(vtrack, new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
let tick = 0;
const cam = setInterval(() => {
  const px = new Uint8Array(VW * VH * 4);
  for (let y = 0; y < VH; y++)
    for (let x = 0; x < VW; x++) {
      const o = (y * VW + x) * 4;
      const band = (x + tick * 4) % VW < 60;
      px[o] = band ? 139 : 20; px[o + 1] = band ? 133 : 22; px[o + 2] = band ? 255 : 40; px[o + 3] = 255;
    }
  tick++;
  vsrc.captureFrame(new VideoFrame(px, VW, VH, VideoBufferType.RGBA));
}, 66);
// Quiet audio keeps the track flowing until the speech plays.
let idle = true;
const pump = (async () => {
  const silence = new Int16Array(F);
  while (idle) await source.captureFrame(new AudioFrame(silence, SR, 1, F));
})();

r = await ws(`/meet/${rcode}/record`, { kind: "video", action: "start" }, O);
check("host starts recording (Egress room composite)", r.status === 200 && !!r.json.recording?.id, r);
const vidId = r.json.recording?.id;
r = await ws(`/meet/${rcode}/record`, { kind: "audio", action: "start" }, O);
check("host starts AI notes (audio-only Egress)", r.status === 200 && r.json.recording?.kind === "audio", r);
const rmName = `meet_${(await db.query("select id from meetings where code=$1", [rcode])).rows[0].id}`;
let roomMeta: any = {};
for (let i = 0; i < 10; i++) {
  roomMeta = JSON.parse((await listRoom(rmName))?.metadata || "{}");
  if (roomMeta.recording && roomMeta.notes) break;
  await sleep(500);
}
check("everyone's room metadata shows Recording and AI notes", roomMeta.recording === true && roomMeta.notes === true, roomMeta);
let active = false;
for (let i = 0; i < 45 && !active; i++) {
  await sleep(1000);
  const recs = (await ws(`/meet/${rcode}/record`, undefined, O)).json.recordings ?? [];
  active = recs.length >= 2 && recs.every((x: any) => x.status === "active");
  if (recs.some((x: any) => x.status === "failed")) break;
}
check("both recordings are live", active, (await ws(`/meet/${rcode}/record`, undefined, O)).json.recordings);
idle = false;
await pump;
if (pcm) for (let i = 0; i + F <= pcm.length; i += F) await source.captureFrame(new AudioFrame(pcm.slice(i, i + F), SR, 1, F));
else for (let i = 0; i < 500; i++) await source.captureFrame(new AudioFrame(new Int16Array(F), SR, 1, F));
await source.waitForPlayout();
await sleep(1500);
r = await ws(`/meet/${rcode}/record`, { kind: "video", action: "stop" }, O);
check("host stops recording", r.status === 200 && r.json.stopped === 1, r);
r = await ws(`/meet/${rcode}/record`, { kind: "audio", action: "stop" }, O);
check("host stops AI notes", r.status === 200, r);
clearInterval(cam);
await bot.disconnect().catch(() => {});
let recs: any[] = [];
for (let i = 0; i < 40; i++) {
  recs = (await ws(`/meet/${rcode}/record`, undefined, O)).json.recordings ?? [];
  if (recs.length && recs.every((x) => ["complete", "failed"].includes(x.status))) break;
  await sleep(1500);
}
const vid = recs.find((x) => x.id === vidId);
const aud = recs.find((x) => x.kind === "audio");
check("video recording finished as an MP4 in storage", vid?.status === "complete" && vid.file.endsWith(".mp4") && fs.existsSync(path.join(RECS, vid.file)) && fs.statSync(path.join(RECS, vid.file)).size > 10_000, vid);
check("notes audio finished as an OGG in storage", aud?.status === "complete" && fs.existsSync(path.join(RECS, aud.file)), aud);
if (vid?.status === "complete") {
  const dl = await fetch(`${WS}/api/meet/${rcode}/recordings/${vidId}`, { headers: { cookie: O } });
  check("host downloads the recording", dl.status === 200 && dl.headers.get("content-type") === "video/mp4", dl.status);
  check("guests can't download recordings", (await fetch(`${WS}/api/meet/${rcode}/recordings/${vidId}`, { headers: { "x-meet-guest": botJoin.key } })).status === 404);
}

if (live) {
  let notes: any = null;
  for (let i = 0; i < 90; i++) {
    notes = (await ws(`/meet/${rcode}/notes`, undefined, O)).json;
    if (["ready", "failed"].includes(notes.status)) break;
    await sleep(2000);
  }
  check("notes written automatically after AI notes stop", notes?.status === "ready" && !!notes.notes?.summary, notes);
  check("transcript came from the recorded meeting audio", /warehouse|Pune|November/i.test(notes?.transcript ?? ""), notes?.transcript);
  check("decisions and action items extracted", (notes?.notes?.decisions?.length ?? 0) >= 1 && (notes?.notes?.actionItems?.length ?? 0) >= 2, notes?.notes);
  check("host is told the notes are ready", (await db.query('select 1 from notifications where "userId"=$1 and kind=\'meet.notes\' and link=$2', [owner.id, `/meet/${rcode}/notes`])).rowCount! > 0);
  r = await ws(`/meet/${rcode}/notes`, { action: "tasks" }, O);
  check("one click: action items -> tasks", r.status === 200 && r.json.taskIds?.length === notes?.notes?.actionItems?.length, r);
  const t = await db.query("select title, labels from tasks where id = any($1)", [r.json.taskIds ?? []]);
  check("tasks carry the action items, labelled 'meeting'", t.rowCount === notes?.notes?.actionItems?.length && t.rows.every((x) => x.labels.includes("meeting")), t.rows);
  check("member host without AI notes can't make tasks from notes", (await ws(`/meet/${mcode}/notes`, { action: "tasks" }, M)).status === 403);
  const general = (await ws("/chat/channels", undefined, O)).json.channels.find((c: any) => c.name === "general");
  r = await ws(`/meet/${rcode}/notes`, { action: "post" }, O);
  check("posting needs a channel when the meeting has no chat thread", r.status === 400, r);
  r = await ws(`/meet/${rcode}/notes`, { action: "post", channelId: general.id }, O);
  check("notes posted to chat", r.status === 200 && !!r.json.messageId, r);
  const posted = await db.query("select body from messages where id=$1", [r.json.messageId]);
  check("chat message has summary and action items", /Notes from/.test(posted.rows[0]?.body) && /Action items/.test(posted.rows[0]?.body), posted.rows[0]);
  check("people outside the meeting can't read its notes", (await anon(`/meet/${rcode}/notes`)).status === 404);
} else console.log("SKIP live AI notes (SKIP_LIVE_AI or no OPENAI_API_KEY)");

// ── Calendar: "Add video meeting" ───────────────────────────────────────
const start = new Date(Date.now() + 2 * 3600_000);
r = await ws("/calendar/events", { title: "Client review (meet test)", start: start.toISOString(), end: new Date(start.getTime() + 3600_000).toISOString(), videoMeeting: true, attendees: [{ userId: member.id }] }, O);
check("event with a video meeting -> 201", r.status === 201, r);
const ev = r.json.event;
const evCode = /\/workspace\/meet\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/.exec(ev?.conferenceUrl ?? "")?.[1];
check("event's conference link is <origin>/workspace/meet/<code>", !!evCode && /^https?:\/\//.test(ev.conferenceUrl), ev?.conferenceUrl);
const evMtg = (await db.query("select * from meetings where code=$1", [evCode])).rows[0];
check("the meeting is linked to the event and invites its attendees", evMtg?.eventId === ev?.id && evMtg?.invitees.includes(member.id) && evMtg?.title === "Client review (meet test)", evMtg);
r = await ws("/meet", undefined, M);
check("Meet landing lists it under upcoming (invitee)", r.json.upcoming?.some((u: any) => u.code === evCode), r.json.upcoming);
r = await ws(`/calendar/events/${ev.id}`, { title: "Client review (meet test)", videoMeeting: true, conferenceUrl: ev.conferenceUrl }, O, "PATCH");
check("saving again keeps the same meeting", r.json.event?.conferenceUrl === ev.conferenceUrl, r.json.event?.conferenceUrl);
await ws(`/meet/${evCode}/join`, {}, O);
const n1 = await db.query('select * from notifications where "userId"=$1 and kind=\'meet.started\' and link=$2', [member.id, `/meet/${evCode}`]);
check("invitee is notified when the meeting starts", n1.rowCount === 1 && /has started/.test(n1.rows[0].title), n1.rows);

// ── Chat: "Start a call" ────────────────────────────────────────────────
const dm = (await ws("/chat/dm", { userId: member.id }, O)).json.channel;
r = await ws("/meet/call", { channelId: dm.id }, O);
check("start a call from a DM -> 201", r.status === 201 && !!r.json.meeting?.code, r);
const callMsg = await db.query("select body from messages where id=$1", [r.json.messageId]);
check("a join message is posted in the chat", callMsg.rows[0]?.body.includes(`/workspace/meet/${r.json.meeting.code}`) && /started a call/.test(callMsg.rows[0]?.body), callMsg.rows[0]);
const callMtg = (await db.query("select * from meetings where code=$1", [r.json.meeting.code])).rows[0];
check("call meeting: linked to the chat, members only, both invited", callMtg.channelId === dm.id && callMtg.messageId === r.json.messageId && callMtg.allowGuests === false && callMtg.invitees.includes(member.id), callMtg);
check("someone outside the channel can't start a call in it", X ? (await ws("/meet/call", { channelId: dm.id }, X)).status >= 403 : true);

// ── End for all ─────────────────────────────────────────────────────────
r = await ws(`/meet/${evCode}/control`, { action: "end" }, O);
check("host ends the meeting for all", r.status === 200 && r.json.ended === true, r);
r = await ws(`/meet/${evCode}/join`, {}, M);
check("after the end, members can't join until the host returns", r.status === 409 && r.json.status === "ended", r);
r = await ws(`/meet/${evCode}/join`, {}, O);
check("host reopens it by rejoining", r.status === 200, r);
check("member can join again", (await ws(`/meet/${evCode}/join`, {}, M)).status === 200);
check("webhook rejects unsigned calls", (await anon("/meet/webhook", { event: "egress_ended" })).status === 401);

// Clean up the test rows (meetings cascade to participants and recordings).
await db.query('update events set "deletedAt"=now() where id=$1', [ev?.id]);
await db.query("delete from meetings where code = any($1)", [[code, mcode, rcode, evCode, callMtg?.code].filter(Boolean)]);
await db.end();
process.exit(summary("Meet") ? 1 : 0);
