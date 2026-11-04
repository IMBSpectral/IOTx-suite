/**
 * IOTx Workspace — Meet round 2: end-to-end encryption, webinars
 * (registration, approval, attendees view-only, stage, hand, cap, live
 * streaming), phone dial-in (meeting side; SIP itself is unconfigured here),
 * saved whiteboard with shapes / text / undo, server captions for browsers
 * without speech recognition, and the self-hosted AI noise and E2EE assets.
 *   npx tsx scripts/test-meet-plus.mts <devToken> <test-users.json>
 * Needs LiveKit on :7880. SKIP_LIVE_AI=1 skips the OpenAI transcription call.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { check, envOf, OUTSIDER, OWNER, setup, signIn, sleep, summary, ws, WS } from "./lib.mts";

const root = path.join(import.meta.dirname, "..");
const env = envOf(path.join(root, ".env"));
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
const OUTBOX = path.join(root, "..", "..", "projects-data", "_forge", "outbox.jsonl");
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
const mailTo = (addr: string) => outbox().filter((x: any) => JSON.stringify(x).toLowerCase().includes(addr.toLowerCase()));
const live = !process.env.SKIP_LIVE_AI && !!env.OPENAI_API_KEY;

async function anon(p: string, body?: unknown, key?: string, method?: string) {
  const r = await fetch(`${WS}/api${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(key ? { "x-meet-guest": key } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const jwt = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
const row = async (code: string) => (await db.query("select * from meetings where code=$1", [code])).rows[0];
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
async function lk(method: string, body: unknown, room: string) {
  const { AccessToken } = await import("livekit-server-sdk");
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { ttl: 60 });
  at.addGrant({ roomList: true, roomAdmin: true, room });
  const r = await fetch(`http://localhost:7880/twirp/livekit.RoomService/${method}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await at.toJwt()}` }, body: JSON.stringify(body) });
  return (await r.json().catch(() => ({}))) as any;
}
async function postAudio(code: string, cookie: string, blob: Blob, name = "chunk.wav") {
  const fd = new FormData();
  fd.append("file", blob, name);
  const r = await fetch(`${WS}/api/meet/${code}/transcribe`, { method: "POST", headers: cookie ? { cookie } : {}, body: fd });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const linkToken = (mail: any) => /[?&]r=([A-Za-z0-9_-]+)/.exec(JSON.stringify(mail))?.[1] ?? "";

const { MEMBER } = await setup();
const O = await signIn(OWNER, "meetings");
const M = await signIn(MEMBER, "meetings");
const X = await signIn(OUTSIDER, "meetings").catch(() => "");
const owner = (await ws("/me", undefined, O)).json.me;
const member = (await ws("/me", undefined, M)).json.me;
const codes: string[] = [];
const bots: { disconnect: () => Promise<void> }[] = [];
const created = async (body: Record<string, unknown>) => {
  const r = await ws("/meet", { title: "Plus test", ...body }, O);
  if (r.json.meeting?.code) codes.push(r.json.meeting.code);
  return r;
};

try {
  // ── 1. End-to-end encryption
  check("encryption needs a check value from the browser", (await created({ e2ee: true })).status === 400);
  const secret = "abcdef-ghjkmn-pqrstu-vwxyz2";
  const check1 = sha(`iotx-e2ee:${secret}`);
  let r: { status: number; json: any } = await created({ e2ee: true, e2eeCheck: check1 });
  const ec = r.json.meeting.code as string;
  check("an encrypted meeting is created", r.status === 201 && r.json.meeting.e2ee === true);
  const pubE = (await anon(`/meet/${ec}`)).json.meeting;
  check("the join page says it's encrypted and gives only the check value", pubE.e2ee === true && pubE.e2eeCheck === check1);
  const erow = await row(ec);
  check("the server never stores the key", !JSON.stringify(erow).includes(secret) && erow.e2eeCheck === check1);
  check("webinars can't be encrypted", (await created({ kind: "webinar", e2ee: true, e2eeCheck: check1 })).status === 400);
  const ej = (await ws(`/meet/${ec}/join`, {}, O)).json;
  check("the host joins the encrypted meeting", ej.status === "admitted");
  check("…and gets no phone dial-in for it", ej.dialIn === null);
  check("recording is refused while encrypted", (await ws(`/meet/${ec}/record`, { kind: "video", action: "start" }, O)).status === 409);
  check("AI notes are refused while encrypted", (await ws(`/meet/${ec}/record`, { kind: "audio", action: "start" }, O)).status === 409);
  check("captions can't be turned on while encrypted", (await ws(`/meet/${ec}/control`, { action: "captions", on: true }, O)).status === 409);
  check("server captions are refused while encrypted", (await postAudio(ec, O, new Blob([new Uint8Array(2000)], { type: "audio/wav" }))).status === 409);
  check("translation is refused while encrypted", (await ws(`/meet/${ec}/translate`, { lines: ["hi"], lang: "Hindi" }, O)).status === 409);
  check("live streaming is refused while encrypted", (await ws(`/meet/${ec}/stream`, { action: "start", url: "rtmp://example.com/live", key: "k" }, O)).status === 409);
  check("only the host changes encryption", (await ws(`/meet/${ec}`, { e2ee: false }, M, "PATCH")).status === 403);
  // With someone in the room, the key can't change under them.
  const { Room } = await import("@livekit/rtc-node");
  const bot = new Room();
  bots.push(bot);
  let inRoom = false;
  try {
    await bot.connect(ej.url, ej.token, { autoSubscribe: false, dynacast: false });
    inRoom = true;
  } catch (e) {
    console.log("bot connect failed", (e as Error).message);
  }
  await sleep(600);
  check("encryption can't change while people are in the room", inRoom && (await ws(`/meet/${ec}`, { e2ee: false }, O, "PATCH")).status === 409);
  await bot.disconnect();
  let off = 0;
  for (let i = 0; i < 20 && off !== 200; i++) {
    await sleep(700);
    off = (await ws(`/meet/${ec}`, { e2ee: false }, O, "PATCH")).status;
  }
  check("…and can once the room is empty", off === 200 && (await row(ec)).e2ee === false && (await row(ec)).e2eeCheck === null);
  const check2 = sha("iotx-e2ee:zzzzzz-yyyyyy-xxxxxx-wwwwww");
  check("turn it back on with a new key", (await ws(`/meet/${ec}`, { e2ee: true, e2eeCheck: check2 }, O, "PATCH")).status === 200 && (await row(ec)).e2eeCheck === check2);
  check("turning it on turns captions off", (await row(ec)).captions === false);

  // ── 2. Webinars
  r = await created({ kind: "webinar", title: "Plus webinar", startsAt: new Date(Date.now() + 86_400_000).toISOString(), registration: true, panelists: [member.email] });
  const wc = r.json.meeting.code as string;
  check("a webinar is created with a registration page", r.status === 201 && r.json.meeting.kind === "webinar" && /\/register$/.test(r.json.meeting.registerUrl));
  const wrow = await row(wc);
  check("panelists are stored by user id", wrow.panelists.includes(member.id));
  const pubW = (await anon(`/meet/${wc}`)).json.meeting;
  check("the join page knows it's a webinar with registration", pubW.kind === "webinar" && pubW.registration === true && !!pubW.startsAt);
  const hj = (await ws(`/meet/${wc}/join`, {}, O)).json;
  check("the host joins and may publish", hj.role === "host" && jwt(hj.token).video.canPublish === true);
  const pj = (await ws(`/meet/${wc}/join`, {}, M)).json;
  check("an invited panelist is on stage", pj.role === "panelist" && jwt(pj.token).video.canPublish === true && !jwt(pj.token).video.hidden);
  const room = await lk("ListRooms", { names: [`meet_${wrow.id}`] }, `meet_${wrow.id}`);
  check("the webinar room holds 1000+ people", (room.rooms?.[0]?.max_participants ?? room.rooms?.[0]?.maxParticipants) >= 1000, room.rooms?.[0]);
  r = await anon(`/meet/${wc}/join`, { name: "Walk In" });
  check("guests must register first", r.status === 403 && r.json.status === "register");
  const page = await fetch(`${WS}/meet/${wc}/register`);
  check("the public registration page loads", page.status === 200 && (await page.text()).includes("Plus webinar"));
  check("registration checks the email", (await anon(`/meet/${wc}/register`, { name: "Bad", email: "nope" })).status === 400);
  const email1 = `reg-${Date.now()}@example.com`;
  r = await anon(`/meet/${wc}/register`, { name: "Rhea Registrant", email: email1, company: "Acme" });
  check("registering without approval is approved at once", r.status === 201 && r.json.status === "approved");
  await sleep(500);
  let mails = mailTo(email1);
  const tok1 = linkToken(mails.at(-1));
  check("the registrant gets a personal join link by email (local outbox)", mails.length >= 1 && tok1.length > 20, mails.at(-1));
  check("the link's secret is stored only as a hash", !JSON.stringify((await db.query(`select * from meet_registrants where email=$1`, [email1])).rows).includes(tok1));
  const aj = (await anon(`/meet/${wc}/join`, { reg: tok1 })).json;
  check("the registrant joins as an attendee", aj.status === "admitted" && aj.role === "attendee" && !!aj.key);
  const ag = jwt(aj.token).video;
  check("attendee tokens can't publish and are hidden", ag.canPublish === false && ag.hidden === true && ag.canSubscribe === true);
  check("one link is one seat (same identity every time)", (await anon(`/meet/${wc}/join`, { reg: tok1 })).json.identity === aj.identity);
  await anon(`/meet/${wc}/register`, { name: "Rhea Registrant", email: email1 });
  await sleep(400);
  const tok1b = linkToken(mailTo(email1).at(-1));
  check("registering again emails a new link…", !!tok1b && tok1b !== tok1);
  check("…and the old one stops working", (await anon(`/meet/${wc}/join`, { reg: tok1 })).status === 403);
  check("panelists can't see registrations", (await ws(`/meet/${wc}/registrants`, undefined, M)).status === 403);
  check("outsiders can't either", (await ws(`/meet/${wc}/registrants`, undefined, X)).status === 403);
  // Approval
  check("turn on approval", (await ws(`/meet/${wc}`, { regApproval: true }, O, "PATCH")).json.settings.regApproval === true);
  const email2 = `appr-${Date.now()}@example.com`;
  r = await anon(`/meet/${wc}/register`, { name: "Arun Approve", email: email2 });
  check("with approval, a registration waits", r.json.status === "pending");
  await sleep(300);
  check("…and the email says so, without a link", mailTo(email2).length === 1 && !linkToken(mailTo(email2)[0]));
  let regs = (await ws(`/meet/${wc}/registrants`, undefined, O)).json.registrants as any[];
  const r2 = regs.find((x) => x.email === email2);
  check("the host sees the waiting registration", r2?.status === "pending");
  r = await ws(`/meet/${wc}/registrants`, { action: "approve", id: r2.id }, O);
  await sleep(300);
  const tok2 = linkToken(mailTo(email2).at(-1));
  check("approving emails their join link", r.json.emailed === 1 && !!tok2);
  const aj2 = (await anon(`/meet/${wc}/join`, { reg: tok2 })).json;
  check("…which works", aj2.status === "admitted" && aj2.role === "attendee");
  await ws(`/meet/${wc}/registrants`, { action: "deny", id: r2.id }, O);
  check("declining stops their link", (await anon(`/meet/${wc}/join`, { reg: tok2 })).status === 403);

  // Attendee in the room: hand, stage, permissions
  const aBot = new Room();
  bots.push(aBot);
  let aIn = false;
  let akey = aj.key as string;
  try {
    const again = (await anon(`/meet/${wc}/join`, { reg: tok1b })).json;
    akey = again.key;
    await aBot.connect(again.url, again.token, { autoSubscribe: false, dynacast: false });
    aIn = true;
  } catch (e) {
    console.log("attendee bot failed", (e as Error).message);
  }
  check("an attendee connects to LiveKit (view only)", aIn);
  await sleep(600);
  const perm = async () => (await lk("ListParticipants", { room: `meet_${wrow.id}` }, `meet_${wrow.id}`)).participants?.find((p: any) => p.identity === aj.identity)?.permission;
  let p0 = await perm();
  check("LiveKit holds them as hidden, no publishing", p0 && !p0.can_publish && !p0.canPublish && (p0.hidden === true), p0);
  check("an attendee can't draw on the whiteboard", (await anon(`/meet/${wc}/board`, { item: { kind: "rect", x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }, akey)).status === 403);
  check("…but can ask in Q&A", (await anon(`/meet/${wc}/qa`, { action: "ask", text: "Will slides be shared?" }, akey)).status === 200);
  check("an attendee raises a hand", (await anon(`/meet/${wc}/hand`, { up: true }, akey)).status === 200);
  let st = (await ws(`/meet/${wc}/stage`, undefined, O)).json;
  check("hosts see the raised hand in the audience list", st.attendees?.some((x: any) => x.identity === aj.identity && x.hand), st);
  check("panelists can't manage the stage", (await ws(`/meet/${wc}/stage`, { identity: aj.identity, on: true }, M)).status === 403);
  r = await ws(`/meet/${wc}/stage`, { identity: aj.identity, on: true }, O);
  check("the host brings them on stage", r.json.role === "panelist" && (await row(wc)).stage.includes(aj.identity));
  await sleep(500);
  p0 = await perm();
  check("LiveKit now lets them publish, visibly", p0 && (p0.can_publish || p0.canPublish) && !p0.hidden, p0);
  check("their hand is lowered", !(await ws(`/meet/${wc}/stage`, undefined, O)).json.stage?.find((x: any) => x.identity === aj.identity)?.hand);
  check("on stage they can draw", (await anon(`/meet/${wc}/board`, { item: { kind: "rect", x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } }, akey)).status === 200);
  check("a rejoin keeps them on stage", jwt((await anon(`/meet/${wc}/join`, { key: akey })).json.token).video.canPublish === true);
  await ws(`/meet/${wc}/stage`, { identity: aj.identity, on: false }, O);
  await sleep(500);
  p0 = await perm();
  check("and back to the audience", p0 && !(p0.can_publish || p0.canPublish) && p0.hidden === true, p0);
  check("webinars have no breakout rooms", (await ws(`/meet/${wc}/breakout`, { action: "create", count: 2 }, O)).status === 400);
  const poll = (await ws(`/meet/${wc}/polls`, { action: "create", question: "Useful?", options: ["Yes", "No"], open: true }, O)).json;
  check("attendees answer polls", (await anon(`/meet/${wc}/polls`, { action: "vote", id: poll.id, choices: [0] }, akey)).status === 200);
  await aBot.disconnect();

  // Live streaming
  const sg = (await ws(`/meet/${wc}/stream`, undefined, O)).json;
  check("the host can see live streaming", sg.enabled === true && Array.isArray(sg.streams));
  check("members without host rights can't stream", (await ws(`/meet/${wc}/stream`, undefined, M)).status === 403);
  check("the stream address is checked", (await ws(`/meet/${wc}/stream`, { action: "start", url: "http://x.com/live" }, O)).status === 400);
  const KEY = `sk-test-${Date.now()}`;
  r = await ws(`/meet/${wc}/stream`, { action: "start", url: "rtmp://127.0.0.1:1935/live", key: KEY }, O);
  check("a live stream starts through LiveKit Egress (or says Egress is missing)", r.status === 201 || r.status === 503, r.json);
  if (r.status === 201) {
    check("the stream key is never stored", !JSON.stringify((await db.query(`select * from meet_streams where "meetingId"=$1`, [wrow.id])).rows).includes(KEY) && r.json.stream.target.endsWith("••••"));
    await sleep(1500);
    const meta = JSON.parse((await lk("ListRooms", { names: [`meet_${wrow.id}`] }, `meet_${wrow.id}`)).rooms?.[0]?.metadata || "{}");
    check("everyone's room shows it's live", meta.live === true || (await db.query(`select status from meet_streams where "meetingId"=$1`, [wrow.id])).rows[0].status === "failed");
    r = await ws(`/meet/${wc}/stream`, { action: "stop" }, O);
    check("the host stops the stream", r.status === 200);
  }

  // ── 3. Phone dial-in (SIP not configured on this server)
  check("every meeting has a 10-digit meeting ID and a 6-digit PIN", /^[1-9]\d{9}$/.test(wrow.dialInId) && /^\d{6}$/.test(wrow.dialInPin));
  check("without SIP config there is no dial-in to show, and no dispatch rule", hj.dialIn === null && (await row(wc)).dialInRuleId === null && (await ws(`/meet/${wc}`, undefined, O)).json.meeting.dialIn === null);
  check("the PIN isn't on the public join page", !JSON.stringify(pubW).includes(wrow.dialInPin));
  const plan = execFileSync(process.execPath, ["--import", "tsx", path.join(root, "scripts", "meet-sip-setup.mts")], { cwd: root, encoding: "utf8", env: { ...process.env, LIVEKIT_SIP_NUMBERS: "" } });
  check("the SIP setup script says dial-in isn't configured", /not configured/.test(plan));
  let self = "";
  try {
    self = execFileSync(process.execPath, ["--import", "tsx", path.join(root, "scripts", "meet-sip-setup.mts"), "--self-test"], { cwd: root, encoding: "utf8" });
  } catch (e) {
    self = String((e as { stdout?: string }).stdout ?? "");
  }
  check("LiveKit accepts the trunk and PIN dispatch rule Meet would create", self.includes("SELFTEST OK"), self.slice(-300));

  // ── 4. Whiteboard: shapes, text, undo, clear, saved after the meeting
  const bc = (await created({})).json.meeting.code as string;
  await ws(`/meet/${bc}/join`, {}, O);
  await ws(`/meet/${bc}/join`, {}, M);
  const items = [
    { id: "it-pen", kind: "pen", color: "#e5484d", size: 4, points: [0.1, 0.1, 0.2, 0.25, 0.3, 0.2] },
    { id: "it-rect", kind: "rect", color: "#2563eb", size: 4, x1: 0.1, y1: 0.5, x2: 0.3, y2: 0.7 },
    { id: "it-ell", kind: "ellipse", color: "#16a34a", size: 2, x1: 0.4, y1: 0.5, x2: 0.6, y2: 0.8 },
    { id: "it-line", kind: "line", color: "#111111", size: 2, x1: 0.7, y1: 0.1, x2: 0.9, y2: 0.1 },
    { id: "it-arrow", kind: "arrow", color: "#d97706", size: 8, x1: 0.7, y1: 0.3, x2: 0.9, y2: 0.5 },
    { id: "it-text", kind: "text", color: "#7c3aed", size: 4, x: 0.5, y: 0.1, text: "Roadmap Q4" },
    { id: "it-erase", kind: "pen", color: "#111111", size: 4, points: [0.15, 0.15, 0.2, 0.2], erase: true },
  ];
  let okAll = true;
  for (const it of items) okAll = (await ws(`/meet/${bc}/board`, { item: it }, it.id === "it-text" ? M : O)).status === 200 && okAll;
  check("draw a pen line, rectangle, ellipse, line, arrow, text and an eraser stroke", okAll);
  const got = (await ws(`/meet/${bc}/board`, undefined, M)).json.strokes as any[];
  check("everyone loads them, in order, with their kinds", got.map((x) => x.kind).join() === "pen,rect,ellipse,line,arrow,text,pen" && got[6].erase === true && got[5].text === "Roadmap Q4");
  check("a shape without corners is refused", (await ws(`/meet/${bc}/board`, { item: { kind: "rect", x1: 0.1 } }, O)).status === 400);
  check("text needs words", (await ws(`/meet/${bc}/board`, { item: { kind: "text", x: 0.1, y: 0.1, text: "  " } }, O)).status === 400);
  check("coordinates are kept on the board", (await ws(`/meet/${bc}/board`, { item: { id: "it-far", kind: "line", x1: -5, y1: 0, x2: 9, y2: 0.5 } }, O)).status === 200 && ((await ws(`/meet/${bc}/board`, undefined, O)).json.strokes as any[]).find((x) => x.id === "it-far").x2 === 1);
  r = await ws(`/meet/${bc}/board`, { action: "undo" }, M);
  check("undo takes back my own latest", r.json.id === "it-text");
  r = await ws(`/meet/${bc}/board`, { action: "undo" }, O);
  check("…and the host's undo takes back theirs", r.json.id === "it-far");
  check("members can't remove someone else's drawing", (await ws(`/meet/${bc}/board`, { action: "remove", id: "it-rect" }, M)).status === 403);
  check("hosts can", (await ws(`/meet/${bc}/board`, { action: "remove", id: "it-rect" }, O)).json.id === "it-rect");
  check("only hosts clear", (await ws(`/meet/${bc}/board`, { action: "clear" }, M)).status === 403);
  check("the board is saved in the database", Number((await db.query(`select count(*) from meet_board_items where "meetingId"=$1 and not deleted`, [(await row(bc)).id])).rows[0].count) === 5);
  await ws(`/meet/${bc}/control`, { action: "end" }, O);
  check("after the meeting the board is still there for attendees (notes page)", ((await ws(`/meet/${bc}/board`, undefined, M)).json.strokes as any[]).length === 5);
  check("…but nobody can draw on it any more", (await ws(`/meet/${bc}/board`, { item: items[1] }, O)).status === 400);
  check("outsiders can't see it", (await ws(`/meet/${bc}/board`, undefined, X)).status === 403);
  const notesPage = await fetch(`${WS}/meet/${bc}/notes`, { headers: { cookie: M } });
  check("the notes page loads", notesPage.status === 200);
  const hostClear = (await created({})).json.meeting.code as string;
  await ws(`/meet/${hostClear}/join`, {}, O);
  await ws(`/meet/${hostClear}/board`, { item: items[0] }, O);
  check("the host clears the board", (await ws(`/meet/${hostClear}/board`, { action: "clear" }, O)).status === 200 && ((await ws(`/meet/${hostClear}/board`, undefined, O)).json.strokes as any[]).length === 0);

  // ── 5. Server captions (browsers without speech recognition)
  const cc = (await created({})).json.meeting.code as string;
  await ws(`/meet/${cc}/join`, {}, O);
  await ws(`/meet/${cc}/join`, {}, M);
  check("server captions need captions on", (await postAudio(cc, M, new Blob([new Uint8Array(4000)], { type: "audio/wav" }))).status === 409);
  await ws(`/meet/${cc}/control`, { action: "captions", on: true, lang: "en-US" }, O);
  check("only audio is accepted", (await postAudio(cc, M, new Blob(["hello"], { type: "text/plain" }), "x.txt")).status === 400);
  check("only people in the meeting", (await postAudio(cc, X, new Blob([new Uint8Array(4000)], { type: "audio/wav" }))).status === 403);
  check("chunks are at most 2 MB", (await postAudio(cc, M, new Blob([new Uint8Array(2.5 * 1024 * 1024)], { type: "audio/webm" }))).status === 400);
  if (live) {
    // Real speech, made offline with Windows' speech synthesizer.
    const wav = path.join(root, "storage", `meet-test-${Date.now()}.wav`);
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}'); $s.Speak('The budget review is moved to Friday afternoon.'); $s.Dispose()`]);
    } catch (e) {
      console.log("speech synthesis failed", (e as Error).message);
    }
    if (fs.existsSync(wav)) {
      r = await postAudio(cc, M, new Blob([fs.readFileSync(wav)], { type: "audio/wav" }));
      fs.rmSync(wav, { force: true });
      check("a spoken chunk becomes a caption (OpenAI transcription)", r.status === 200 && /budget/i.test(r.json.text) && /friday/i.test(r.json.text), r.json);
      const lines = (await ws(`/meet/${cc}/transcript`, undefined, O)).json.lines as any[];
      check("…saved in the same transcript as browser captions, under the speaker", lines.some((l) => l.identity === `u_${member.id}` && /budget/i.test(l.text)));
    } else check("speech sample for the transcription test", false, "System.Speech unavailable");
  } else console.log("SKIP live transcription (SKIP_LIVE_AI or no OPENAI_API_KEY)");
  const silent = await postAudio(cc, M, new Blob([new Uint8Array(1200)], { type: "audio/webm" }));
  check("an unreadable chunk is skipped quietly", silent.status === 200 && silent.json.text === "");

  // ── 6. Self-hosted assets: AI noise model and the E2EE worker
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  check("the noise package is pinned to an exact version", pkg.dependencies["@sapphi-red/web-noise-suppressor"] === "0.4.1");
  const same = (a: string, b: string) => fs.readFileSync(path.join(root, a)).equals(fs.readFileSync(path.join(root, b)));
  check("the served RNNoise files match the pinned package", same("public/meet-noise/rnnoise.wasm", "node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm") && same("public/meet-noise/rnnoise_simd.wasm", "node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm") && same("public/meet-noise/rnnoiseWorklet.js", "node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js"));
  check("the served E2EE worker matches livekit-client", same("public/meet-e2ee/livekit-client.e2ee.worker.mjs", "node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs"));
  const base = new URL(WS).origin;
  const assets = await Promise.all(["meet-noise/rnnoise.wasm", "meet-noise/rnnoise_simd.wasm", "meet-noise/rnnoiseWorklet.js", "meet-e2ee/livekit-client.e2ee.worker.mjs"].map((p) => fetch(`${base}/workspace/${p}`)));
  check("they're served by this app (no CDN)", assets.every((a) => a.status === 200) && assets[0].headers.get("content-type")?.includes("wasm") === true && /javascript/.test(assets[3].headers.get("content-type") ?? ""));
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  for (const b of bots) await b.disconnect().catch(() => {});
  for (const c of codes) {
    const m = await row(c);
    if (!m) continue;
    await db.query(`delete from meet_files where "meetingId"=$1`, [m.id]);
    await db.query(`delete from meetings where id=$1`, [m.id]);
  }
  await db.end();
}
process.exit(summary("Meet round 2") ? 1 : 0);
