/**
 * IOTx Workspace — Meet outside meetings and integrations (Read AI parity, helper C):
 * extension tokens (create, pairing code, revoke, bad tokens), a call captured
 * by the browser extension (start, 10-second chunks, finish → report through
 * report.ts ingestAudio with a real transcription of synthesized speech),
 * webhooks out (signed like Chat's bots, verified by a mock on 127.0.0.1:4795,
 * test delivery, delivery log, rotate, SSRF guard), "report ready" auto-share
 * (Chat channel, Tasks project, knowledge-base suggestion, calendar write-back,
 * email recap) for the extension's call and, through the background job, for
 * a regular Meet call, and the MCP server (initialize, tools/list, tools/call).
 *   npx tsx scripts/test-meet-external.mts <devToken> <test-users.json>
 * The workspace's .env.local lets 127.0.0.1:4795 through (CHAT_OUTBOUND_ALLOW).
 * SKIP_LIVE_AI=1 skips the capture's transcription and report (and what needs them).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { check, envOf, OWNER, setup, signIn, sleep, summary, SUITE, ws, WS } from "./lib.mts";

const env = envOf(path.join(import.meta.dirname, "..", ".env"));
const KEY = env.IOTX_SERVICE_KEY;
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
const OUTBOX = path.resolve(import.meta.dirname, "..", "..", "..", "projects-data", "_forge", "outbox.jsonl");
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const LIVE = process.env.SKIP_LIVE_AI !== "1";
const tag = crypto.randomBytes(3).toString("hex");

/** A call with "Authorization: Bearer <token>" (or none). */
async function bearer(p: string, token: string | null, body?: unknown, method?: string, extra: Record<string, string> = {}) {
  const raw = body instanceof Uint8Array;
  const r = await fetch(`${WS}/api${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": raw ? "audio/webm" : "application/json" } : {}), ...extra },
    body: body === undefined ? undefined : raw ? (body as unknown as BodyInit) : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {}
  return { status: r.status, json, headers: r.headers, text };
}
const tick = async (only?: string[]) => (await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "x-iotx-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ job: "meet-integrations", only }) })).json();

// ── Mock webhook receiver on 127.0.0.1:4795 ───────────────────────────────
type Hit = { path: string; headers: http.IncomingHttpHeaders; raw: string; json: any; sigOk: boolean };
const hits: Hit[] = [];
const secrets = new Map<string, string>(); // path -> current signing secret
const PORT = 4795;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const p = req.url ?? "";
    const secret = secrets.get(p) ?? "";
    const ts = String(req.headers["x-iotx-timestamp"] ?? "");
    const want = `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;
    const got = String(req.headers["x-iotx-signature"] ?? "");
    const sigOk = !!secret && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)) && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    hits.push({ path: p, headers: req.headers, raw, json, sigOk });
    if (p === "/fail") return res.writeHead(500).end("nope");
    res.writeHead(sigOk ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify({ ok: sigOk }));
  });
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
const MOCK = `http://127.0.0.1:${PORT}`;
const waitHit = async (pred: (h: Hit) => boolean, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const h = hits.find(pred);
    if (h) return h;
    await sleep(100);
  }
  return null;
};

const { wsId, MEMBER } = await setup();
const O = await signIn(OWNER, "meetings");
const M = await signIn(MEMBER, "meetings");
const owner = (await ws("/me", undefined, O)).json.me;
const member = (await ws("/me", undefined, M)).json.me;
const ownerId = owner.userId ?? owner.id;
const memberId = member.userId ?? member.id;
check("owner can use Meet AI notes (needed to record calls)", owner.perms["meetings.ai_notes"] === true, owner.perms);

// ── Extension tokens ─────────────────────────────────────────────────────
let r: any = await ws("/meet/tokens", { kind: "extension", name: `Test extension ${tag}` }, O);
check("create an extension token -> 201", r.status === 201, r);
const shown = r.json.token as string;
const pairCode = r.json.pairCode as string;
const tokId = r.json.item?.id as string;
check("token looks like iotxr_… and is shown once", /^iotxr_[\w-]{30,}$/.test(shown ?? ""), shown);
check("pairing code looks like ABCD-EFGH, valid ~10 minutes", /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pairCode ?? "") && Math.abs(new Date(r.json.pairUntil).getTime() - Date.now() - 600_000) < 60_000, r.json);
const row = (await db.query(`select * from extension_tokens where id = $1`, [tokId])).rows[0];
check("only the sha256 is stored (no plain token in the row)", row?.tokenHash === crypto.createHash("sha256").update(shown).digest("hex") && !JSON.stringify(row).includes(shown), row);
r = await ws("/meet/tokens", undefined, O);
const listed = (r.json.tokens as any[]).find((t) => t.id === tokId);
check("the list shows it (hint, waiting for pairing) without the token", !!listed && listed.pairing === true && !JSON.stringify(r.json).includes(shown) && shown.startsWith(listed.hint), listed);
check("the member doesn't see the owner's tokens", !((await ws("/meet/tokens", undefined, M)).json.tokens as any[]).some((t) => t.id === tokId));

r = await bearer("/meet/ext/me", shown);
check("the shown token signs the extension in", r.status === 200 && r.json.user?.email === owner.email && r.json.canRecord === true, r.json);
check("no Authorization -> 401", (await bearer("/meet/ext/me", null)).status === 401);
check("a made-up token -> 401", (await bearer("/meet/ext/me", `iotxr_${crypto.randomBytes(30).toString("base64url")}`)).status === 401);
check("a bot-style token -> 401", (await bearer("/meet/ext/me", "xbot-abcdefghijklmnopqrstuvwxyz")).status === 401);
check("Basic auth instead of Bearer -> 401", (await bearer("/meet/ext/me", null, undefined, "GET", { authorization: `Basic ${Buffer.from(`x:${shown}`).toString("base64")}` })).status === 401);

r = await bearer("/meet/ext/pair", null, { code: "ZZZZ-ZZZZ" });
check("a wrong pairing code -> 401", r.status === 401, r);
r = await bearer("/meet/ext/pair", null, { code: pairCode.toLowerCase().replace("-", " ") });
check("pairing with the code (any case, any separator) gives a new token", r.status === 200 && /^iotxr_/.test(r.json.token) && r.json.token !== shown && r.json.user?.email === owner.email, r);
const T = r.json.token as string;
check("…the token shown on screen stops working", (await bearer("/meet/ext/me", shown)).status === 401);
check("…the paired token works", (await bearer("/meet/ext/me", T)).status === 200);
check("…the code works only once", (await bearer("/meet/ext/pair", null, { code: pairCode })).status === 401);

r = await ws("/meet/tokens", { kind: "extension", name: "To revoke" }, O);
const revTok = r.json.token as string, revId = r.json.item.id as string;
check("the member can't revoke the owner's token", (await ws(`/meet/tokens/${revId}`, undefined, M, "DELETE")).status === 404);
check("revoke -> 200", (await ws(`/meet/tokens/${revId}`, undefined, O, "DELETE")).status === 200);
check("a revoked token -> 401 at once", (await bearer("/meet/ext/me", revTok)).status === 401);
check("revoked tokens leave the list", !((await ws("/meet/tokens", undefined, O)).json.tokens as any[]).some((t) => t.id === revId));

// The member's own token (AI notes are off for members by default: no recording).
r = await ws("/meet/tokens", { kind: "api", name: "Member MCP" }, M);
const MT = r.json.token as string;
check("an API token has no pairing code", r.status === 201 && r.json.pairCode === null, r.json);
r = await bearer("/meet/ext/capture", MT, { url: "https://meet.google.com/abc-defg-hij", platform: "meet" });
check("a role without AI notes can't start a recording (403)", r.status === 403 && r.json.key === "meetings.ai_notes", r);

// ── Integrations set-up (before the call, so "report ready" runs on finish) ──
const ch = await ws("/chat/channels", { name: `meet-reports-${tag}`, kind: "public" }, O);
check("a Chat channel for reports", ch.status === 201, ch.json);
const channelId = ch.json.channel?.id as string;
const pj = await ws("/tasks/projects", { name: `Meet follow-ups ${tag}`, memberIds: [memberId] }, O);
check("a Tasks project for action items", pj.status === 201, pj.json);
const projectId = pj.json.project?.id as string;

r = await ws("/meet/webhooks", { url: "http://10.1.2.3/hook" }, O);
check("webhook to a private address -> 400 (SSRF guard)", r.status === 400, r.json);
r = await ws("/meet/webhooks", { url: "http://localhost:9/hook" }, O);
check("webhook to localhost -> 400", r.status === 400, r.json);
r = await ws("/meet/webhooks", { url: "ftp://example.com/x" }, O);
check("webhook that isn't http(s) -> 400", r.status === 400, r.json);
r = await ws("/meet/webhooks", { url: `${MOCK}/hook` }, O);
check("add a webhook (allowed test address) -> 201 with a whsec_ secret", r.status === 201 && /^whsec_/.test(r.json.secret), r.json);
const hookId = r.json.webhook.id as string;
secrets.set("/hook", r.json.secret);
check("the list doesn't repeat the secret", !JSON.stringify((await ws("/meet/webhooks", undefined, O)).json).includes(r.json.secret));
r = await ws("/meet/webhooks", { url: `${MOCK}/fail` }, O);
const failId = r.json.webhook.id as string;
secrets.set("/fail", r.json.secret);

r = await ws(`/meet/webhooks/${hookId}/test`, undefined, O, "POST");
check("test delivery -> ok 200", r.status === 200 && r.json.delivery?.ok === true && r.json.delivery?.status === 200 && r.json.delivery?.test === true, r.json);
let h = await waitHit((x) => x.path === "/hook" && x.json?.event === "report.test");
check("the receiver got report.test with a valid HMAC signature and timestamp", !!h && h.sigOk && h.headers["content-type"] === "application/json", h && { sig: h.headers["x-iotx-signature"], ts: h.headers["x-iotx-timestamp"] });
check("…the payload has the meeting and report shape", !!h?.json?.meeting && "report" in h.json && typeof h.json.reportUrl === "string", h?.json);
r = await ws(`/meet/webhooks/${failId}/test`, undefined, O, "POST");
check("a receiver answering 500 is logged as failed", r.status === 200 && r.json.delivery?.ok === false && r.json.delivery?.status === 500, r.json);
check("the member can't test the owner's webhook", (await ws(`/meet/webhooks/${hookId}/test`, undefined, M, "POST")).status === 404);
r = await ws(`/meet/webhooks/${hookId}`, { rotate: true }, O, "PATCH");
check("rotate the secret -> a new one", r.status === 200 && /^whsec_/.test(r.json.secret) && r.json.secret !== secrets.get("/hook"), r.json);
const oldSecret = secrets.get("/hook")!;
secrets.set("/hook", r.json.secret);
hits.length = 0;
await ws(`/meet/webhooks/${hookId}/test`, undefined, O, "POST");
h = await waitHit((x) => x.path === "/hook");
check("…deliveries are signed with the new secret", !!h && h.sigOk, h?.headers);
check("…and not with the old one", !!h && !h.raw.includes(oldSecret) && h.headers["x-iotx-signature"] !== `v0=${crypto.createHmac("sha256", oldSecret).update(`v0:${h.headers["x-iotx-timestamp"]}:${h.raw}`).digest("hex")}`);
r = await ws("/meet/integrations", undefined, O);
check("delivery log lists the test deliveries (ok and failed)", r.status === 200 && (r.json.deliveries as any[]).some((d) => d.test && d.ok) && (r.json.deliveries as any[]).some((d) => d.test && !d.ok && d.status === 500), r.json.deliveries?.slice(0, 4));
await ws(`/meet/webhooks/${failId}`, undefined, O, "DELETE");
check("Meet's sharing setting is read (default attendees)", ["attendees", "invitees", "me"].includes(r.json.workspaceRecap), r.json.workspaceRecap);

r = await ws("/meet/integrations", { emailRecap: "everyone" }, O, "PUT");
check("a bad email recap rule -> 400", r.status === 400, r.json);
const mch = await ws("/chat/channels", { name: `private-${tag}`, kind: "private" }, O);
r = await ws("/meet/integrations", { chatChannelId: mch.json.channel?.id }, M, "PUT");
check("the member can't pick a private channel they're not in", r.status === 404 || r.status === 400 || r.status === 403, r);
r = await ws("/meet/integrations", { tasksProjectId: "nope" }, O, "PUT");
check("an unknown project -> 404", r.status === 404, r);

// ── A calendar event for the call (matched by its link) ──────────────────
const now = Date.now();
const callUrl = `https://meet.google.com/${["xqz", "wvut", "rsp"].join("-")}`;
r = await ws("/calendar/events", { title: `Pricing review ${tag}`, start: new Date(now - 10 * 60_000).toISOString(), end: new Date(now + 50 * 60_000).toISOString(), tz: "UTC", conferenceUrl: callUrl, description: "Agenda: pricing.", attendees: [{ userId: memberId }, { email: `client-${tag}@example.com`, name: "Client" }] }, O);
check("a calendar event with a Google Meet link", r.status === 201, r.json);
const eventId = r.json.event?.id as string;
r = await bearer("/meet/ext/upcoming", T);
const up = (r.json.meetings as any[])?.find((m) => m.id === eventId);
check("the popup's list has today's event with its Google Meet link", r.status === 200 && !!up && up.platform === "meet" && up.url === callUrl, r.json);

// ── A captured call: start, chunks, finish ───────────────────────────────
r = await bearer("/meet/ext/capture", T, { url: `${callUrl}?authuser=0`, title: "", participants: ["Asha Rao", "Ravi Kumar", "You", "Asha Rao"], mime: "audio/webm;codecs=opus" });
check("start a capture -> 201 (platform meet, matched to the event)", r.status === 201 && r.json.platform === "meet" && r.json.eventId === eventId, r.json);
const cap = r.json;
check("…titled from the calendar event", cap.title === `Pricing review ${tag}`, cap.title);
const mrow = (await db.query(`select kind, "hostId", invitees, "notesStatus", "startedAt" from meetings where id = $1`, [cap.meetingId])).rows[0];
check("…a meeting of kind external, hosted by me, with the event's members invited", mrow?.kind === "external" && mrow.hostId === ownerId && mrow.invitees.includes(memberId) && mrow.notesStatus === "recording" && !!mrow.startedAt, mrow);
r = await bearer(`/meet/ext/capture/${cap.captureId}`, MT);
check("someone else's token can't see the capture (404)", r.status === 404);

// Synthesized speech, encoded like the extension's MediaRecorder output (Opus/WebM) when ffmpeg is there.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c-ext-"));
const wav = path.join(tmp, "call.wav");
const SPEECH = "Hello everyone, this is the quarterly pricing review. We decided to raise the starter plan to twelve dollars from January. Ravi will send the updated pricing proposal to the customer by Friday. Asha will update the pricing page on the website next week. Is everyone fine with that? Yes. Thanks everyone.";
let audio: Buffer = Buffer.alloc(0);
try {
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${SPEECH}'); $s.Dispose()`]);
  const ff = path.join(import.meta.dirname, "..", "node_modules", "ffmpeg-static", "ffmpeg.exe");
  if (fs.existsSync(ff)) {
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-c:a", "libopus", "-b:a", "32k", path.join(tmp, "call.webm")]);
    audio = fs.readFileSync(path.join(tmp, "call.webm"));
  } else audio = fs.readFileSync(wav);
} catch (e) {
  console.log("speech synthesis failed", (e as Error).message);
}
check("synthesized the call's audio", audio.length > 10_000, audio.length);
// Five "10-second" chunks, as MediaRecorder's timeslice gives them (only the first has the header).
const parts: Buffer[] = [];
for (let i = 0; i < 5; i++) parts.push(audio.subarray(Math.floor((i * audio.length) / 5), Math.floor(((i + 1) * audio.length) / 5)));
let okChunks = 0;
for (let i = 0; i < parts.length; i++) {
  r = await bearer(`/meet/ext/capture/${cap.captureId}/chunk?seq=${i}`, T, new Uint8Array(parts[i]), "PUT");
  if (r.status === 200 && r.json.seq === i) okChunks++;
}
check("five chunks uploaded in order", okChunks === 5, r.json);
r = await bearer(`/meet/ext/capture/${cap.captureId}/chunk?seq=2`, T, new Uint8Array(parts[2]), "PUT");
check("a retried chunk replaces itself (still 5 chunks, same bytes)", r.status === 200 && r.json.chunks === 5 && r.json.bytes === audio.length, r.json);
check("a chunk without seq -> 400", (await bearer(`/meet/ext/capture/${cap.captureId}/chunk`, T, new Uint8Array(parts[0]), "PUT")).status === 400);
check("an empty chunk -> 400", (await bearer(`/meet/ext/capture/${cap.captureId}/chunk?seq=9`, T, new Uint8Array(0), "PUT")).status === 400);
check("a chunk with a bad token -> 401", (await bearer(`/meet/ext/capture/${cap.captureId}/chunk?seq=9`, revTok, new Uint8Array(parts[0]), "PUT")).status === 401);
check("a chunk to someone else's capture -> 404 (member token)", (await bearer(`/meet/ext/capture/${cap.captureId}/chunk?seq=9`, MT, new Uint8Array(parts[0]), "PUT")).status === 404);
r = await bearer(`/meet/ext/capture/${cap.captureId}`, T, { participants: ["Meera Iyer"] }, "PATCH");
check("names seen later on the page are added (no duplicates, no 'You')", r.status === 200 && r.json.participants.join("|") === "Asha Rao|Ravi Kumar|Meera Iyer", r.json.participants);

// Turn auto-share on just before the call ends (kept short: other test runs use this owner too).
r = await ws("/meet/integrations", { chatChannelId: channelId, tasksProjectId: projectId, kbSuggest: true, calendarWriteback: true, emailRecap: "invitees" }, O, "PUT");
check("save auto-share (Chat, Tasks, knowledge base, calendar, email recap)", r.status === 200 && r.json.settings.chatChannelId === channelId && r.json.settings.tasksProjectId === projectId && r.json.settings.kbSuggest && r.json.settings.calendarWriteback && r.json.settings.emailRecap === "invitees", r.json);
const mailsBefore = outbox().length;
hits.length = 0;

r = await bearer(`/meet/ext/capture/${cap.captureId}/finish`, T, { title: "" });
check("finish -> the report is being made", r.status === 200 && ["finishing", "done"].includes(r.json.status) && r.json.notesStatus === "processing", r.json);
check("…a chunk after finishing -> 409", (await bearer(`/meet/ext/capture/${cap.captureId}/chunk?seq=7`, T, new Uint8Array(parts[0]), "PUT")).status === 409);

let st: any = r.json;
if (LIVE) {
  for (let i = 0; i < 120 && !["done", "failed"].includes(st.status); i++) {
    await sleep(3000);
    st = (await bearer(`/meet/ext/capture/${cap.captureId}`, T)).json;
  }
  check("the report is made (A's ingestAudio: real transcription + Claude)", st.status === "done" && st.notesStatus === "ready", st);
  const m = (await db.query(`select report, notes, transcript, "durationSec", "notesTaskIds", "endedAt" from meetings where id = $1`, [cap.meetingId])).rows[0];
  const segs = (await db.query(`select speaker, text from meet_segments where "meetingId" = $1 order by seq`, [cap.meetingId])).rows;
  check("timestamped transcript with the spoken words", segs.length > 0 && /pric/i.test(segs.map((s) => s.text).join(" ")) && /friday/i.test(segs.map((s) => s.text).join(" ")), segs.slice(0, 3));
  check("report v2 with a summary and action items", m?.report?.version === 2 && m.report.summary.length > 20 && m.report.actionItems.length > 0, m?.report);
  check("meeting ended, duration known", !!m?.endedAt && m.durationSec > 5, { d: m?.durationSec });
  check("the capture's chunks are cleaned up (the recording is kept with the meeting)", !fs.existsSync(path.join(import.meta.dirname, "..", "storage", "meet-external", cap.captureId)));

  // report.ready went everywhere.
  h = await waitHit((x) => x.path === "/hook" && x.json?.event === "report.ready" && x.json?.meeting?.id === cap.meetingId, 15000);
  check("webhook report.ready, signed", !!h && h.sigOk, h?.headers);
  check("…with the meeting (external, Google Meet, participants) and the report", h?.json?.meeting?.kind === "external" && h.json.meeting.platform === "meet" && h.json.meeting.participants.includes("Asha Rao") && h.json.meeting.callUrl.startsWith(callUrl) && h.json.report?.version === 2 && h.json.report.summary === m.report.summary, h?.json?.meeting);
  const msgs = (await ws(`/chat/channels/${channelId}/messages`, undefined, O)).json.messages as any[];
  check("Chat: the summary is posted in the channel with the report link", (msgs ?? []).some((x) => x.body.includes(`/workspace/meet/${cap.code}/notes`) && x.body.includes("Notes from")), msgs?.map((x) => x.body.slice(0, 80)));
  check("Tasks: the action items became tasks in the project", m.notesTaskIds.length === m.report.actionItems.length && m.notesTaskIds.length > 0, m.notesTaskIds);
  const tasks = (await db.query(`select "projectId", labels from tasks where id = any($1)`, [m.notesTaskIds])).rows;
  check("…in the chosen project, labelled meeting", tasks.length > 0 && tasks.every((t) => t.projectId === projectId && t.labels.includes("meeting")), tasks);
  const ev = (await ws(`/calendar/events/${eventId}`, undefined, O)).json.event;
  check("Calendar: the summary and link are added to the event's description", ev?.description?.startsWith("Agenda: pricing.") && ev.description.includes("Meeting summary (IOTx Meet)") && ev.description.includes(`/workspace/meet/${cap.code}/notes`), ev?.description);
  const mails = outbox().slice(mailsBefore).filter((x) => String(x.subject ?? "").includes(`Pricing review ${tag}`));
  const to = mails.map((x) => String(x.to).toLowerCase());
  check("Email recap (invitees): host, invited member and the event's outside guest", to.includes(owner.email.toLowerCase()) && to.includes(member.email.toLowerCase()) && to.includes(`client-${tag}@example.com`), to);
  const log = (await ws("/meet/integrations", undefined, O)).json.deliveries as any[];
  const mine = log.filter((d) => d.meeting?.code === cap.code);
  for (const t of ["webhook", "chat", "tasks", "calendar", "email"]) check(`delivery log: ${t} ok`, mine.some((d) => d.target === t && d.ok), mine.map((d) => `${d.target}:${d.ok}:${d.detail}`));
  const kb = mine.find((d) => d.target === "kb");
  if (kb?.ok) check("delivery log: knowledge-base suggestion ok", true);
  else if (kb && /answered (400|404)/.test(kb.detail)) console.log(`SKIP knowledge-base suggestion: the running suite doesn't have the new suggest path yet (rebuild web) — ${kb.detail}`);
  else check("delivery log: knowledge-base suggestion", false, kb);
  if (kb?.ok) {
    const sug = await fetch(`${SUITE}/api/kb/suggestions?status=pending`, { headers: { cookie: OWNER } }).then((x) => x.json()).catch(() => ({}));
    check("…the decisions wait in Knowledge → Review", (sug.suggestions ?? []).some((s: any) => s.sourceRef === `meet:${cap.code}` && s.source === "assistant"), sug.suggestions?.slice(0, 2));
  }
  // Once only.
  const before = hits.filter((x) => x.json?.meeting?.id === cap.meetingId).length;
  r = { status: 200, json: await tick([cap.meetingId]), headers: new Headers(), text: "" } as any;
  await sleep(500);
  check("the job doesn't send the same report again", r.json.ran === 0 && hits.filter((x) => x.json?.meeting?.id === cap.meetingId).length === before, { r: r.json, before });
} else console.log("SKIP live transcription and report (SKIP_LIVE_AI=1)");

// ── A regular Meet call whose notes become ready: the background job sends them ──
r = await ws("/meet", { title: `Design sync ${tag}`, invitees: [memberId] }, O);
const live = r.json.meeting;
const liveId = (await db.query(`select id from meetings where code = $1`, [live.code])).rows[0].id as string;
const notes = { summary: `We agreed the onboarding redesign ships next sprint (${tag}).`, decisions: ["Ship the onboarding redesign next sprint"], actionItems: [{ title: "Write the onboarding release notes", owner: "", due: "" }] };
await db.query(`update meetings set notes = $2, "notesStatus" = 'ready', "notesAt" = now(), "startedAt" = now() - interval '30 minutes', "endedAt" = now() where id = $1`, [liveId, JSON.stringify(notes)]);
hits.length = 0;
r = { status: 200, json: await tick([liveId]), headers: new Headers(), text: "" } as any;
check("the job runs the integrations for a Meet call's notes", r.json.ran === 1, r.json);
h = await waitHit((x) => x.json?.meeting?.code === live.code);
check("…webhook report.ready with the notes (no v2 report yet)", !!h && h.sigOk && h.json.meeting.kind === "meeting" && h.json.meeting.platform === "iotx" && h.json.notes?.summary === notes.summary, h?.json);
const msgs2 = (await ws(`/chat/channels/${channelId}/messages`, undefined, O)).json.messages as any[];
check("…and the summary in Chat", (msgs2 ?? []).some((x) => x.body.includes(notes.summary)), msgs2?.length);
const liveTasks = (await db.query(`select "notesTaskIds" from meetings where id = $1`, [liveId])).rows[0].notesTaskIds;
check("…and the action item in Tasks", liveTasks.length === 1, liveTasks);
r = { status: 200, json: await tick([liveId]), headers: new Headers(), text: "" } as any;
check("…once", r.json.ran === 0, r.json);
// A new version of the notes (regenerated) is sent again.
await db.query(`update meetings set "notesAt" = now() + interval '1 second' where id = $1`, [liveId]);
hits.length = 0;
r = { status: 200, json: await tick([liveId]), headers: new Headers(), text: "" } as any;
check("regenerated notes are sent again (one more webhook)", r.json.ran === 1 && !!(await waitHit((x) => x.json?.meeting?.code === live.code)), r.json);
// Reports that were ready before the integrations were turned on aren't sent.
await ws("/meet/integrations", { chatChannelId: null, tasksProjectId: null, kbSuggest: false, calendarWriteback: false, emailRecap: "off" }, O, "PUT");
await db.query(`update meetings set "notesAt" = now() + interval '2 seconds' where id = $1`, [liveId]);
await sleep(2500);
await ws("/meet/integrations", { chatChannelId: channelId }, O, "PUT");
const chatBefore = ((await ws(`/chat/channels/${channelId}/messages`, undefined, O)).json.messages as any[]).length;
await tick([liveId]);
check("turning auto-share on doesn't send reports that were ready before", ((await ws(`/chat/channels/${channelId}/messages`, undefined, O)).json.messages as any[]).length === chatBefore);

// ── MCP ──────────────────────────────────────────────────────────────────
const rpc = (body: unknown, token: string | null = T, extra: Record<string, string> = {}) => bearer("/mcp", token, body, "POST", { accept: "application/json, text/event-stream", ...extra });
r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, null);
check("MCP without a token -> 401 with WWW-Authenticate", r.status === 401 && /Bearer/.test(r.headers.get("www-authenticate") ?? ""), r);
r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, revTok);
check("MCP with a revoked token -> 401", r.status === 401);
r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
check("initialize -> protocol version, tools capability, server info", r.status === 200 && r.json.jsonrpc === "2.0" && r.json.id === 1 && r.json.result?.protocolVersion === "2025-06-18" && !!r.json.result.capabilities?.tools && r.json.result.serverInfo?.name === "iotx-meet", r.json);
r = await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
check("initialize with an unknown version -> the server's latest", r.json.result?.protocolVersion === "2025-11-25", r.json);
r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
check("notifications/initialized -> 202, no body", r.status === 202 && r.text === "");
r = await rpc({ jsonrpc: "2.0", id: 3, method: "ping" });
check("ping -> {}", r.status === 200 && JSON.stringify(r.json.result) === "{}", r.json);
r = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" });
const tools = (r.json.result?.tools ?? []) as any[];
check("tools/list -> search_meetings, get_report, list_action_items with input schemas", ["search_meetings", "get_report", "list_action_items"].every((n) => tools.some((t) => t.name === n && t.inputSchema?.type === "object" && t.description)), tools.map((t) => t.name));
r = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_meetings", arguments: { query: "onboarding redesign" } } });
check("search_meetings finds the Meet call by its summary", r.status === 200 && r.json.result?.isError === false && r.json.result.structuredContent.meetings.some((x: any) => x.code === live.code) && r.json.result.content[0].type === "text", r.json);
if (LIVE) {
  r = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_meetings", arguments: { query: "pricing proposal", limit: 5 } } });
  check("search_meetings finds the captured call", r.json.result?.structuredContent?.meetings?.some((x: any) => x.code === cap.code), r.json.result?.structuredContent);
  r = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_report", arguments: { meeting: cap.code, transcript: true } } });
  check("get_report -> the v2 report, as text and structured, with the transcript", r.json.result?.isError === false && r.json.result.structuredContent.report.version === 2 && r.json.result.structuredContent.transcript.length > 0 && r.json.result.content[0].text.includes("## Summary"), r.json.result?.content?.[0]?.text?.slice(0, 300));
  r = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "get_report", arguments: { meeting: cap.meetingId } } });
  check("get_report by meeting id works too", r.json.result?.structuredContent?.meeting?.code === cap.code, r.json);
}
r = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_action_items", arguments: { days: 7 } } });
check("list_action_items -> items with their meeting", r.json.result?.isError === false && r.json.result.structuredContent.items.some((x: any) => x.meeting.code === live.code && x.title === "Write the onboarding release notes"), r.json.result?.structuredContent?.items?.length);
r = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_action_items", arguments: { days: 7, mine: true } } });
check("list_action_items mine -> only items owned by me", r.json.result?.isError === false && !r.json.result.structuredContent.items.some((x: any) => x.meeting.code === live.code), r.json.result?.structuredContent?.items?.map((x: any) => x.owner));
// The member's token only sees what the member may see.
await db.query(`update meetings set invitees = '{}' where id = $1`, [liveId]);
r = await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "get_report", arguments: { meeting: live.code } } }, MT);
check("get_report on a meeting the person can't see -> a tool error, not the report", r.status === 200 && r.json.result?.isError === true && !JSON.stringify(r.json).includes(notes.summary), r.json);
r = await rpc({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "search_meetings", arguments: { query: "onboarding redesign" } } }, MT);
check("search_meetings with the member's token doesn't list it", r.json.result?.structuredContent?.meetings?.every((x: any) => x.code !== live.code), r.json.result?.structuredContent);
r = await rpc({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "get_report", arguments: {} } });
check("get_report without meeting -> a tool error", r.json.result?.isError === true, r.json);
r = await rpc({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
check("unknown tool -> JSON-RPC error -32602", r.json.error?.code === -32602, r.json);
r = await rpc({ jsonrpc: "2.0", id: 15, method: "sampling/createMessage" });
check("unknown method -> -32601", r.json.error?.code === -32601, r.json);
r = await bearer("/mcp", T, undefined, "POST", { "content-type": "application/json" });
check("not JSON -> 400 parse error -32700", r.status === 400 && r.json.error?.code === -32700, r);
r = await rpc({ id: 16, method: "tools/list" });
check("not JSON-RPC 2.0 -> -32600", r.json.error?.code === -32600, r.json);
r = await rpc({ jsonrpc: "2.0", id: 17, method: "tools/list" }, T, { origin: "https://evil.example" });
check("a browser from another site (Origin) -> 403", r.status === 403);
check("GET /api/mcp -> 405 (no server stream)", (await fetch(`${WS}/api/mcp`, { headers: { authorization: `Bearer ${T}` } })).status === 405);

// ── Discard ───────────────────────────────────────────────────────────────
r = await bearer("/meet/ext/capture", T, { url: "https://us02web.zoom.us/wc/join/81234567890", participants: [] });
check("a Zoom web call is recognised", r.status === 201 && r.json.platform === "zoom" && r.json.title === "Zoom call", r.json);
const z = r.json;
await bearer(`/meet/ext/capture/${z.captureId}/chunk?seq=0`, T, new Uint8Array(parts[0] ?? Buffer.from("x")), "PUT");
r = await bearer(`/meet/ext/capture/${z.captureId}`, T, undefined, "DELETE");
check("discard -> the recording and its meeting are gone", r.status === 200 && (await db.query(`select 1 from meetings where id = $1`, [z.meetingId])).rowCount === 0);
r = await bearer("/meet/ext/capture", T, { url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123", participants: [] });
check("a Teams call is recognised", r.status === 201 && r.json.platform === "teams", r.json);
await bearer(`/meet/ext/capture/${r.json.captureId}/finish`, T, {});
st = (await bearer(`/meet/ext/capture/${r.json.captureId}`, T)).json;
check("finishing with nothing recorded -> failed, said plainly", st.status === "failed" && /Nothing was recorded/.test(st.error), st);

// ── Pages ───────────────────────────────────────────────────────────────
const pg1 = await fetch(`${WS}/meet/integrations`, { headers: { cookie: O }, redirect: "manual" });
check("Meet → Integrations page renders", pg1.status === 200 && (await pg1.text()).includes("Meet integrations"));
const zipRes = await fetch(`${WS}/read-extension.zip`);
check("the extension zip is downloadable", zipRes.status === 200 && (await zipRes.arrayBuffer()).byteLength > 5000);

// ── Clean up: auto-share off, webhook removed ─────────────────────────────
await ws("/meet/integrations", { chatChannelId: null, tasksProjectId: null, kbSuggest: false, calendarWriteback: false, emailRecap: "off" }, O, "PUT");
check("delete the webhook", (await ws(`/meet/webhooks/${hookId}`, undefined, O, "DELETE")).status === 200);
await ws(`/meet/tokens/${tokId}`, undefined, O, "DELETE");
await db.query(`update extension_tokens set "revokedAt" = now() where "userId" = $1 and name = 'Member MCP' and "revokedAt" is null`, [memberId]);
// The test's own Chat channel and Tasks project (public "pricing" notes there would show up in other tests' searches).
await db.query(`delete from channels where id = $1`, [channelId]);
await db.query(`delete from projects where id = $1`, [projectId]);
fs.rmSync(tmp, { recursive: true, force: true });
server.close();
await db.end();
process.exit(summary("test-meet-external") ? 1 : 0);
