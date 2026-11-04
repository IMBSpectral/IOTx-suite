/**
 * IOTx Workspace — Meet at Zoom / Google Meet parity: passcodes, guest rate
 * limits and bans, "everyone waits", co-hosts (members and guests), host
 * hand-over (leave and LiveKit webhook), spotlight, live captions and the
 * speaker transcript, saved chat with private messages and files, polls,
 * Q&A, breakout rooms, personal rooms, recordings (list, Range playback,
 * delete, retention), notes to attendees, notes from captions, caption
 * translation and the whiteboard — with isolation and permission checks.
 *   npx tsx scripts/test-meet-pro.mts <devToken> <test-users.json>
 * Needs LiveKit on :7880. SKIP_LIVE_AI=1 skips the Claude calls.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { check, envOf, OUTSIDER, OWNER, setup, signIn, sleep, summary, ws, WS } from "./lib.mts";

const env = envOf(path.join(import.meta.dirname, "..", ".env"));
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
const OUTBOX = new URL("../../../projects-data/_forge/outbox.jsonl", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const REC_DIR = path.join(import.meta.dirname, "..", "storage", "meet-recordings");
const live = !process.env.SKIP_LIVE_AI && !!env.ANTHROPIC_API_KEY;

/** Calls with no Workspace cookie (guests), optionally with a guest key. */
async function anon(p: string, body?: unknown, key?: string, method?: string) {
  const r = await fetch(`${WS}/api${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(key ? { "x-meet-guest": key } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any, headers: r.headers };
}
const jwt = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
const tick = async (job: string, now?: Date) => (await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "x-iotx-key": env.IOTX_SERVICE_KEY, "content-type": "application/json" }, body: JSON.stringify({ job, now: now?.toISOString() }) })).json();
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
const meetingRow = async (code: string) => (await db.query("select * from meetings where code=$1", [code])).rows[0];
async function up(cookie: string, code: string, name: string, type: string, data: string, key?: string) {
  const fd = new FormData();
  fd.append("file", new Blob([data], { type }), name);
  const r = await fetch(`${WS}/api/meet/${code}/files`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), ...(key ? { "x-meet-guest": key } : {}) }, body: fd });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const raw = (p: string, cookie = "", headers: Record<string, string> = {}) => fetch(`${WS}/api${p}`, { headers: { ...(cookie ? { cookie } : {}), ...headers } });

const { MEMBER } = await setup();
const O = await signIn(OWNER, "meetings");
const M = await signIn(MEMBER, "meetings");
const X = await signIn(OUTSIDER, "meetings").catch(() => "");
const owner = (await ws("/me", undefined, O)).json.me;
const member = (await ws("/me", undefined, M)).json.me;
const uO = `u_${owner.id}`, uM = `u_${member.id}`;
const codes: string[] = [];
const bots: { disconnect: () => Promise<void> }[] = [];
const recFiles: string[] = [];
const newMeeting = async (body: Record<string, unknown> = {}) => {
  const r = await ws("/meet", { title: "Pro test", ...body }, O);
  codes.push(r.json.meeting.code);
  return r.json.meeting.code as string;
};
/** A guest who asks, is admitted, and gets a token. */
async function guest(code: string, name: string, extra: Record<string, unknown> = {}) {
  const a = await anon(`/meet/${code}/join`, { name, ...extra });
  if (a.json.status === "waiting") {
    await ws(`/meet/${code}/lobby`, { participantId: a.json.participantId, action: "admit" }, O);
    const b = await anon(`/meet/${code}/join`, { key: a.json.key });
    return { key: a.json.key as string, ...b.json };
  }
  return a.json;
}

try {
  // ── Passcode
  check("a passcode must be 4–10 letters or digits", (await ws("/meet", { title: "x", passcode: "ab" }, O)).status === 400);
  const pc = await newMeeting({ passcode: "4821" });
  const pub = (await anon(`/meet/${pc}`)).json.meeting;
  check("the join page says a passcode is needed, without showing it", pub.passcode === true && !JSON.stringify(pub).includes("4821"));
  check("the host sees the passcode", (await ws(`/meet/${pc}`, undefined, O)).json.meeting.settings.passcode === "4821");
  check("a member who isn't a host doesn't", !JSON.stringify((await ws(`/meet/${pc}`, undefined, M)).json).includes("4821"));
  let r = await anon(`/meet/${pc}/join`, { name: "No Code" });
  check("a guest without the passcode is asked for it", r.status === 401 && r.json.status === "passcode");
  check("a wrong passcode is refused", (await anon(`/meet/${pc}/join`, { name: "Wrong", passcode: "1111" })).status === 401);
  r = await anon(`/meet/${pc}/join`, { name: "Right", passcode: "4821" });
  check("the right passcode lets them ask to join", r.status === 200 && r.json.status === "waiting");
  check("members don't need the passcode", (await ws(`/meet/${pc}/join`, {}, M)).json.status === "admitted");
  check("only hosts can change the passcode", (await ws(`/meet/${pc}`, { passcode: null }, M, "PATCH")).status === 403);
  await ws(`/meet/${pc}`, { passcode: null }, O, "PATCH");
  check("remove the passcode", (await anon(`/meet/${pc}/join`, { name: "Free" })).json.status === "waiting");

  // ── Rate limits and bans
  const rl = await newMeeting();
  let codesOk = 0, limited = false;
  for (let i = 0; i < 10; i++) {
    const x = await anon(`/meet/${rl}/join`, { name: `Flood ${i}` });
    if (x.status === 200) codesOk++;
    if (x.status === 429) limited = true;
  }
  check("guest join requests are rate-limited per address", codesOk === 8 && limited);
  const bn = await newMeeting({ waitingRoom: false });
  const gA = (await anon(`/meet/${bn}/join`, { name: "Trouble" })).json;
  check("a guest walks straight in without a waiting room", gA.status === "admitted");
  await ws(`/meet/${bn}/join`, {}, O);
  await ws(`/meet/${bn}/control`, { action: "remove", identity: gA.identity }, O);
  check("a removed guest's key stops working", (await anon(`/meet/${bn}/join`, { key: gA.key })).json.status === "removed");
  r = await anon(`/meet/${bn}/join`, { name: "Totally New Person" });
  check("…and they can't come back under a new name", r.status === 403 && r.json.status === "removed");

  // ── Everyone waits
  const ew = await newMeeting({ everyoneWaits: true });
  check("everyone-waits shows on the join page", (await anon(`/meet/${ew}`)).json.meeting.everyoneWaits === true);
  r = await ws(`/meet/${ew}/join`, {}, M);
  check("with everyone waits, members wait too", r.json.status === "waiting");
  const lob = (await ws(`/meet/${ew}/lobby`, undefined, O)).json.waiting;
  check("the host sees the member in the waiting room", lob.some((w: any) => w.kind === "member" && w.name === member.name));
  check("the host walks in", (await ws(`/meet/${ew}/join`, {}, O)).json.status === "admitted");
  await ws(`/meet/${ew}/lobby`, { participantId: lob[0].id, action: "admit" }, O);
  check("once admitted, the member gets in", (await ws(`/meet/${ew}/join`, {}, M)).json.status === "admitted");

  // ── Co-hosts
  const co = await newMeeting();
  await ws(`/meet/${co}/join`, {}, O);
  await ws(`/meet/${co}/join`, {}, M);
  const g1 = await guest(co, "Guest One");
  check("a member can't use host controls", (await ws(`/meet/${co}/lobby`, undefined, M)).status === 403 && (await ws(`/meet/${co}/control`, { action: "lock" }, M)).status === 403);
  r = await ws(`/meet/${co}/control`, { action: "cohost", identity: uM }, O);
  check("the host makes a member co-host", r.status === 200 && r.json.coHosts.includes(uM));
  check("the co-host's view has host settings", (await ws(`/meet/${co}`, undefined, M)).json.meeting.settings !== undefined && (await ws(`/meet/${co}`, undefined, M)).json.meeting.owner === false);
  check("the co-host's token says co-host", jwt((await ws(`/meet/${co}/join`, {}, M)).json.token).metadata.includes("cohost"));
  const gw = (await anon(`/meet/${co}/join`, { name: "Waiting Guest" })).json;
  check("a co-host admits people", (await ws(`/meet/${co}/lobby`, { participantId: gw.participantId, action: "admit" }, M)).status === 200);
  check("a co-host locks the meeting", (await ws(`/meet/${co}/control`, { action: "lock" }, M)).json.locked === true);
  await ws(`/meet/${co}/control`, { action: "unlock" }, M);
  check("a co-host can't name co-hosts", (await ws(`/meet/${co}/control`, { action: "cohost", identity: g1.identity }, M)).status === 403);
  check("a co-host can't remove the host", (await ws(`/meet/${co}/control`, { action: "remove", identity: uO }, M)).status === 400);
  await ws(`/meet/${co}/control`, { action: "cohost", identity: g1.identity }, O);
  check("a guest co-host uses host controls with their key", (await anon(`/meet/${co}/lobby`, undefined, g1.key)).status === 200);
  check("…but can't end the meeting for everyone", (await anon(`/meet/${co}/control`, { action: "end" }, g1.key)).status === 403);
  check("a co-host can't remove another co-host", (await anon(`/meet/${co}/control`, { action: "remove", identity: uM }, g1.key)).status === 403);
  check("the participant list role changes too", (await db.query(`select role from meet_participants p join meetings m on m.id=p."meetingId" where m.code=$1 and identity=$2`, [co, uM])).rows[0]?.role === "cohost");
  await ws(`/meet/${co}/control`, { action: "cohost", identity: uM, on: false }, O);
  check("remove a co-host", (await ws(`/meet/${co}/lobby`, undefined, M)).status === 403);
  check("only people in the meeting can be co-hosts", (await ws(`/meet/${co}/control`, { action: "cohost", identity: "u_nobody" }, O)).status === 400);

  // ── Spotlight (room metadata)
  const mco = await meetingRow(co);
  await ws(`/meet/${co}/control`, { action: "spotlight", identity: uM }, O);
  let meta = JSON.parse((await listRoom(`meet_${mco.id}`))?.metadata || "{}");
  check("spotlight shows for everyone in the room metadata", meta.spotlight === uM && meta.coHosts.includes(g1.identity));
  check("non-hosts can't spotlight", (await anon(`/meet/${co}/control`, { action: "spotlight", identity: uO }, gw.key)).status === 403);
  await ws(`/meet/${co}/control`, { action: "spotlight", identity: "" }, O);

  // ── Captions and the transcript
  check("caption lines are refused while captions are off", (await ws(`/meet/${co}/captions`, { text: "hello" }, M)).status === 409);
  check("caption language must look like en-US", (await ws(`/meet/${co}/control`, { action: "captions", on: true, lang: "english" }, O)).status === 400);
  r = await ws(`/meet/${co}/control`, { action: "captions", on: true, lang: "en-IN" }, O);
  meta = JSON.parse((await listRoom(`meet_${mco.id}`))?.metadata || "{}");
  check("a host turns captions on for everyone", r.json.captions === true && meta.captions === true && meta.captionLang === "en-IN");
  check("a member's finished caption line is saved", (await ws(`/meet/${co}/captions`, { text: "We ship the dispatch module on Friday." }, M)).status === 201);
  check("…and a guest's", (await anon(`/meet/${co}/captions`, { text: "I will send the vendor quote by Thursday." }, g1.key)).status === 201);
  check("someone not in the meeting can't add captions", (await ws(`/meet/${co}/captions`, { text: "x" }, X)).status === 403 && (await anon(`/meet/${co}/captions`, { text: "x" })).status === 403);
  const tr = (await ws(`/meet/${co}/transcript`, undefined, M)).json.lines as any[];
  check("the transcript has speaker names and times", tr.length === 2 && tr[0].name === member.name && tr[1].name === "Guest One" && !!tr[0].at);
  check("an outsider can't read the transcript", (await ws(`/meet/${co}/transcript`, undefined, X)).status === 404);

  // ── Chat: saved, private messages, files
  const pubMsg = await ws(`/meet/${co}/chat`, { text: "Agenda is in the doc" }, M);
  check("send a chat message", pubMsg.status === 201 && pubMsg.json.message.fromName === member.name);
  const priv = await anon(`/meet/${co}/chat`, { text: "psst, can we talk after?", to: uM }, g1.key);
  check("send a private message", priv.status === 201 && priv.json.message.to === uM);
  let chatO = (await ws(`/meet/${co}/chat`, undefined, O)).json.messages as any[];
  check("others don't see private messages", chatO.some((x) => x.id === pubMsg.json.message.id) && !chatO.some((x) => x.id === priv.json.message.id));
  check("the recipient does", ((await ws(`/meet/${co}/chat`, undefined, M)).json.messages as any[]).some((x) => x.id === priv.json.message.id));
  check("private messages only go to people in the meeting", (await ws(`/meet/${co}/chat`, { text: "x", to: "u_nobody" }, M)).status === 400);
  const f1 = await up(M, co, "agenda.txt", "text/plain", "1. Dispatch\n2. Vendors");
  check("upload a file to the chat", f1.status === 201 && f1.json.file.name === "agenda.txt");
  check("an unsent file is private to its uploader", (await raw(`/meet/${co}/files/${f1.json.file.id}`, O)).status === 404);
  await ws(`/meet/${co}/chat`, { text: "", fileIds: [f1.json.file.id] }, M);
  const fr = await raw(`/meet/${co}/files/${f1.json.file.id}`, O);
  check("a sent file opens for others, sandboxed", fr.status === 200 && fr.headers.get("content-security-policy") === "sandbox" && (await fr.text()).includes("Dispatch"));
  check("a guest opens it with their key", (await raw(`/meet/${co}/files/${f1.json.file.id}?k=${encodeURIComponent(g1.key)}`)).status === 200);
  check("an outsider can't", (await raw(`/meet/${co}/files/${f1.json.file.id}`, X)).status === 404);
  const f2 = await up("", co, "secret.txt", "text/plain", "for Max only", g1.key);
  await anon(`/meet/${co}/chat`, { text: "", to: uM, fileIds: [f2.json.file.id] }, g1.key);
  check("a file in a private message stays private", (await raw(`/meet/${co}/files/${f2.json.file.id}`, O)).status === 404 && (await raw(`/meet/${co}/files/${f2.json.file.id}`, M)).status === 200);
  const h = await up(M, co, "x.html", "text/html", "<script>alert(1)</script>");
  await ws(`/meet/${co}/chat`, { text: "", fileIds: [h.json.file.id] }, M);
  check("HTML files download instead of running", (await raw(`/meet/${co}/files/${h.json.file.id}`, O)).headers.get("content-type") === "application/octet-stream");
  check("an outsider can't read the chat", (await ws(`/meet/${co}/chat`, undefined, X)).status === 404 && (await anon(`/meet/${co}/chat`)).status === 404);

  // ── Polls
  check("non-hosts can't create polls", (await ws(`/meet/${co}/polls`, { action: "create", question: "q", options: ["a", "b"] }, M)).status === 403);
  check("a poll needs 2–10 answers", (await ws(`/meet/${co}/polls`, { action: "create", question: "q", options: ["a"] }, O)).status === 400);
  const draft = (await ws(`/meet/${co}/polls`, { action: "create", question: "Draft?", options: ["a", "b"] }, O)).json.id;
  check("drafts are hidden from others", !((await ws(`/meet/${co}/polls`, undefined, M)).json.polls as any[]).some((p) => p.id === draft));
  const poll = (await ws(`/meet/${co}/polls`, { action: "create", question: "Ship on Friday?", options: ["Yes", "No", "Not sure"], open: true, anonymous: false }, O)).json.id;
  check("vote on an open poll", (await ws(`/meet/${co}/polls`, { action: "vote", id: poll, choices: [0] }, M)).status === 200);
  check("a guest votes too", (await anon(`/meet/${co}/polls`, { action: "vote", id: poll, choices: [1] }, g1.key)).status === 200);
  check("one answer only unless the poll allows more", (await ws(`/meet/${co}/polls`, { action: "vote", id: poll, choices: [0, 1] }, M)).status === 400);
  let pm = ((await ws(`/meet/${co}/polls`, undefined, M)).json.polls as any[]).find((p) => p.id === poll);
  const po = ((await ws(`/meet/${co}/polls`, undefined, O)).json.polls as any[]).find((p) => p.id === poll);
  check("hosts see live results and who voted; others don't until shared", po.results.join() === "1,1,0" && po.voters.length === 2 && pm.results === null && pm.mine.join() === "0");
  await ws(`/meet/${co}/polls`, { action: "close", id: poll }, O);
  await ws(`/meet/${co}/polls`, { action: "share", id: poll }, O);
  pm = ((await ws(`/meet/${co}/polls`, undefined, M)).json.polls as any[]).find((p) => p.id === poll);
  check("shared results reach everyone (names stay with hosts)", pm.results.join() === "1,1,0" && pm.voters === null && pm.status === "closed");
  check("a closed poll takes no votes", (await ws(`/meet/${co}/polls`, { action: "vote", id: poll, choices: [2] }, M)).status === 400);

  // ── Q&A
  const q1 = (await ws(`/meet/${co}/qa`, { action: "ask", text: "Who owns the vendor list?", anonymous: true }, M)).json.id;
  check("ask a question anonymously", !!q1);
  check("you can't upvote your own question", (await ws(`/meet/${co}/qa`, { action: "upvote", id: q1 }, M)).status === 400);
  await anon(`/meet/${co}/qa`, { action: "upvote", id: q1 }, g1.key);
  const qg = ((await anon(`/meet/${co}/qa`, undefined, g1.key)).json.questions as any[]).find((q) => q.id === q1);
  check("others see the vote but not who asked", qg.votes === 1 && qg.upvoted === true && qg.name === "Anonymous" && !JSON.stringify(qg).includes(member.name));
  check("only hosts answer", (await ws(`/meet/${co}/qa`, { action: "answer", id: q1, answer: "x" }, M)).status === 403);
  await ws(`/meet/${co}/qa`, { action: "answer", id: q1, answer: "Priya does." }, O);
  check("the answer shows", ((await ws(`/meet/${co}/qa`, undefined, M)).json.questions as any[]).find((q) => q.id === q1).answer === "Priya does.");
  const q2 = (await anon(`/meet/${co}/qa`, { action: "ask", text: "Off-topic question" }, g1.key)).json.id;
  await ws(`/meet/${co}/qa`, { action: "dismiss", id: q2 }, O);
  check("dismissed questions disappear for attendees", !((await ws(`/meet/${co}/qa`, undefined, M)).json.questions as any[]).some((q) => q.id === q2) && ((await ws(`/meet/${co}/qa`, undefined, O)).json.questions as any[]).some((q) => q.id === q2));

  // ── Breakout rooms
  check("non-hosts can't create breakout rooms", (await ws(`/meet/${co}/breakout`, { action: "create", count: 2 }, M)).status === 403);
  check("an outsider can't see them", (await ws(`/meet/${co}/breakout`, undefined, X)).status === 403);
  r = await ws(`/meet/${co}/breakout`, { action: "create", count: 2, names: ["Sales", "Ops"] }, O);
  check("create named breakout rooms", r.json.breakout.rooms.length === 2 && r.json.breakout.rooms[0].name === "Sales");
  await ws(`/meet/${co}/breakout`, { action: "assign", identity: uM, n: 1 }, O);
  await ws(`/meet/${co}/breakout`, { action: "assign", identity: gw.identity, n: 2 }, O);
  check("an attendee sees which room is theirs, not the lists", (await ws(`/meet/${co}/breakout`, undefined, M)).json.mine === 1 && (await ws(`/meet/${co}/breakout`, undefined, M)).json.breakout.rooms[0].members === undefined);
  check("rooms can't be entered before they open", (await ws(`/meet/${co}/breakout`, { action: "token", n: 1 }, M)).status === 400);
  await ws(`/meet/${co}/breakout`, { action: "open" }, O);
  r = await ws(`/meet/${co}/breakout`, { action: "token", n: 1 }, M);
  check("join my breakout room", r.status === 200 && jwt(r.json.token).video.room === `meet_${mco.id}_b1` && r.json.name === "Sales");
  check("not someone else's", (await ws(`/meet/${co}/breakout`, { action: "token", n: 2 }, M)).status === 403);
  check("hosts can visit any room", jwt((await ws(`/meet/${co}/breakout`, { action: "token", n: 2 }, O)).json.token).video.room === `meet_${mco.id}_b2`);
  await ws(`/meet/${co}/breakout`, { action: "options", allowChoose: true }, O);
  check("with choosing on, people can switch rooms", (await ws(`/meet/${co}/breakout`, { action: "token", n: 2 }, M)).status === 200 && (await ws(`/meet/${co}/breakout`, undefined, M)).json.mine === 2);
  check("message every room", (await ws(`/meet/${co}/breakout`, { action: "broadcast", text: "5 minutes left" }, O)).status === 200);
  check("an outsider can't get a room token", (await ws(`/meet/${co}/breakout`, { action: "token", n: 1 }, X)).status === 403);
  await ws(`/meet/${co}/breakout`, { action: "close" }, O);
  check("closed rooms can't be entered", (await ws(`/meet/${co}/breakout`, { action: "token", n: 1 }, M)).status === 400);
  check("back to the main room", jwt((await ws(`/meet/${co}/breakout`, { action: "token", n: 0 }, M)).json.token).video.room === `meet_${mco.id}`);

  // ── Whiteboard
  check("draw on the whiteboard", (await ws(`/meet/${co}/board`, { stroke: { color: "#e5484d", size: 4, points: [0.1, 0.1, 0.2, 0.2] } }, M)).status === 200);
  check("others load the drawing", ((await anon(`/meet/${co}/board`, undefined, g1.key)).json.strokes as any[]).length === 1);
  check("only hosts clear it", (await ws(`/meet/${co}/board`, { action: "clear" }, M)).status === 403 && (await ws(`/meet/${co}/board`, { action: "clear" }, O)).status === 200);
  check("an outsider can't see it", (await ws(`/meet/${co}/board`, undefined, X)).status === 403);

  // ── Caption translation and notes from captions (live AI)
  if (live) {
    r = await ws(`/meet/${co}/translate`, { lines: ["Good morning, everyone."], lang: "Hindi" }, M);
    check("translate caption lines for one viewer", r.status === 200 && r.json.lines.length === 1 && r.json.lines[0] !== "Good morning, everyone." && /[ऀ-ॿ]/.test(r.json.lines[0]), r.json);
    check("translation needs a language", (await ws(`/meet/${co}/translate`, { lines: ["x"], lang: "" }, M)).status === 400);
    check("only hosts with AI notes write notes from captions", (await ws(`/meet/${co}/notes`, { action: "from_captions" }, M)).status === 403);
    r = await ws(`/meet/${co}/notes`, { action: "from_captions" }, O);
    let st = "";
    for (let i = 0; i < 40 && r.status === 200; i++) {
      await sleep(1500);
      st = (await ws(`/meet/${co}/notes`, undefined, O)).json.status;
      if (st === "ready" || st === "failed") break;
    }
    const nn = (await ws(`/meet/${co}/notes`, undefined, M)).json;
    check("notes are written from the captions", r.status === 200 && st === "ready" && /friday/i.test(JSON.stringify(nn.notes)), nn);
  } else console.log("SKIP live AI (translation, notes from captions)");

  // ── Send notes to attendees
  await db.query(`update meetings set "notesStatus"='ready', notes=$2, invitees=array[$3] where code=$1`, [co, JSON.stringify({ summary: "We agreed to ship on Friday.", decisions: ["Ship Friday"], actionItems: [] }), member.id]);
  check("members can't send the notes", (await ws(`/meet/${co}/notes`, { action: "send" }, M)).status === 403);
  const e0 = outbox().length;
  r = await ws(`/meet/${co}/notes`, { action: "send" }, O);
  const sent = outbox().slice(e0).filter((x) => x.to === "member@localhost");
  check("send the notes to attendees (in the app and by email)", r.status === 200 && r.json.people >= 1 && r.json.emailed >= 1 && sent.some((x) => /Notes: Pro test/.test(x.subject) && /ship on Friday/.test(x.text)), r.json);
  check("they get it in the app too", ((await ws("/notifications", undefined, M)).json.items as any[]).some((n) => n.title === "Notes from Pro test"));

  // ── Recordings: list, playback with Range, delete, retention
  fs.mkdirSync(REC_DIR, { recursive: true });
  const file = `${co}-video-test.mp4`;
  fs.writeFileSync(path.join(REC_DIR, file), Buffer.alloc(1000, 7));
  recFiles.push(file);
  const rec = (await db.query(`insert into meet_recordings (id, "meetingId", kind, "egressId", file, status, size, "startedBy", "startedAt", "endedAt") values ($1,$2,'video',$3,$4,'complete',1000,$5,now(),now()) returning id`, [`rt${Date.now()}`, mco.id, `eg${Date.now()}`, file, owner.id])).rows[0].id;
  r = await ws(`/meet/${co}/recordings`, undefined, M);
  check("attendees see the recordings list", r.status === 200 && (r.json.recordings as any[]).some((x) => x.id === rec));
  check("an outsider doesn't", (await ws(`/meet/${co}/recordings`, undefined, X)).status === 404);
  let pr = await raw(`/meet/${co}/recordings/${rec}`, M, { range: "bytes=0-99" });
  check("recordings stream with Range requests (seekable in the browser)", pr.status === 206 && pr.headers.get("content-range") === "bytes 0-99/1000" && (await pr.arrayBuffer()).byteLength === 100);
  pr = await raw(`/meet/${co}/recordings/${rec}`, M);
  check("…and play inline", pr.status === 200 && /^inline/.test(pr.headers.get("content-disposition") ?? "") && pr.headers.get("accept-ranges") === "bytes");
  check("download saves it", /^attachment/.test((await raw(`/meet/${co}/recordings/${rec}?download=1`, M)).headers.get("content-disposition") ?? ""));
  check("members can't delete recordings", (await ws(`/meet/${co}/recordings/${rec}`, undefined, M, "DELETE")).status === 403);
  check("hosts can", (await ws(`/meet/${co}/recordings/${rec}`, undefined, O, "DELETE")).status === 200 && !fs.existsSync(path.join(REC_DIR, file)) && (await raw(`/meet/${co}/recordings/${rec}`, M)).status === 404);
  const oldFile = `${co}-video-old.mp4`;
  fs.writeFileSync(path.join(REC_DIR, oldFile), Buffer.alloc(10, 1));
  recFiles.push(oldFile);
  const oldId = (await db.query(`insert into meet_recordings (id, "meetingId", kind, "egressId", file, status, size, "startedBy", "startedAt", "endedAt") values ($1,$2,'video',$3,$4,'complete',10,$5,now() - interval '200 days',now() - interval '200 days') returning id`, [`ro${Date.now()}`, mco.id, `eo${Date.now()}`, oldFile, owner.id])).rows[0].id;
  const t = await tick("meet-retention");
  check("recordings past the retention period are deleted", t.deleted >= 1 && !fs.existsSync(path.join(REC_DIR, oldFile)) && !!(await db.query(`select "deletedAt" from meet_recordings where id=$1`, [oldId])).rows[0].deletedAt);

  // ── Personal room
  const p1 = (await ws("/meet/personal", undefined, O)).json.meeting;
  const p2 = (await ws("/meet/personal", undefined, O)).json.meeting;
  const pm2 = (await ws("/meet/personal", undefined, M)).json.meeting;
  check("a personal room has one fixed link", p1.code === p2.code && /\/workspace\/meet\//.test(p1.url));
  check("everyone has their own", pm2.code !== p1.code);
  check("it shows as personal and stays out of recent meetings", (await anon(`/meet/${p1.code}`)).json.meeting.personal === true && !((await ws("/meet", undefined, O)).json.meetings as any[]).some((x) => x.code === p1.code));

  // ── Host hand-over: leaving, and dropping out (LiveKit webhook)
  const ho = await newMeeting({ waitingRoom: false });
  const mho = await meetingRow(ho);
  const { Room } = await import("@livekit/rtc-node");
  const tM = (await ws(`/meet/${ho}/join`, {}, M)).json;
  const tG = (await anon(`/meet/${ho}/join`, { name: "Bot Guest" })).json;
  await ws(`/meet/${ho}/join`, {}, O);
  const botM = new Room(), botG = new Room();
  bots.push(botM, botG);
  let joined = true;
  try {
    await botM.connect(tM.url, tM.token, { autoSubscribe: false, dynacast: false });
    await sleep(300);
    await botG.connect(tG.url, tG.token, { autoSubscribe: false, dynacast: false });
  } catch (e) {
    joined = false;
    console.log("bot connect failed", (e as Error).message);
  }
  check("two people are in the room (WebRTC)", joined);
  await sleep(800);
  r = await ws(`/meet/${ho}/leave`, {}, O);
  check("when the host leaves, the longest-present member gets host controls", r.status === 200 && r.json.newHost?.identity === uM && (await meetingRow(ho)).coHosts.includes(uM), r.json);
  check("…and can run the waiting room", (await ws(`/meet/${ho}/lobby`, undefined, M)).status === 200);
  await botM.disconnect();
  let handed = false;
  for (let i = 0; i < 20 && !handed; i++) {
    await sleep(500);
    handed = (await meetingRow(ho)).coHosts.includes(tG.identity);
  }
  check("when the last host drops out, the next person takes over (LiveKit webhook)", handed);
  check("a member can't hand the meeting to someone", (await anon(`/meet/${ho}/leave`, { transferTo: uM }, tG.key)).status === 200 && (await ws(`/meet/${ho}/leave`, { transferTo: tG.identity }, X)).status === 403);
  await botG.disconnect();
  void mho;

  // ── End: notes from captions start by themselves only with the AI switch; history stays readable
  await ws(`/meet/${co}/control`, { action: "end" }, O);
  check("after the meeting, attendees can still read the chat", ((await ws(`/meet/${co}/chat`, undefined, M)).json.messages as any[]).some((x) => x.id === pubMsg.json.message.id));
  check("…and the transcript", ((await ws(`/meet/${co}/transcript`, undefined, M)).json.lines as any[]).length >= 2);
  check("guests can't post once it has ended", (await anon(`/meet/${co}/chat`, { text: "hello?" }, g1.key)).status !== 201);
  chatO = (await ws(`/meet/${co}/chat`, undefined, O)).json.messages;
  void chatO;
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  for (const b of bots) await b.disconnect().catch(() => {});
  for (const f of recFiles) fs.rmSync(path.join(REC_DIR, f), { force: true });
  for (const c of codes) {
    const row = await meetingRow(c);
    if (!row) continue;
    await db.query(`delete from meet_files where "meetingId"=$1`, [row.id]);
    fs.rmSync(path.join(import.meta.dirname, "..", "storage", "meet-files", row.id), { recursive: true, force: true });
    await db.query(`delete from meetings where id=$1`, [row.id]);
  }
  await db.end();
}
process.exit(summary("Meet (Zoom parity)") ? 1 : 0);
