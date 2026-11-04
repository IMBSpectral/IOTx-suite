/**
 * IOTx Workspace — Meet across meetings (Read AI parity, helper B):
 * canSeeReport (shares, folders, calendar guests), Ask (search with the
 * coverage threshold, folder scope, tasks and chat, one real answer with
 * citations, history), For You (topics over time, what you missed, action
 * items → tasks, key questions), Coaching (MeetSpeaker numbers, moments
 * with timestamps), Meeting Policy (day, time, size, length, on-time rate,
 * admin scope), Recommendations (skips and low scores, accept through
 * Calendar, ignore), Folders (personal, shared, smart), the Daily Read
 * (email once per day), Flexible meetings (auto-move and proposal),
 * the recap setting and opt-outs (members and people outside), attendance
 * per day, and the pages.
 *   npx tsx scripts/test-meet-insights.mts <devToken> <test-users.json>
 * Meeting, MeetSegment, MeetSpeaker and report rows are written directly.
 * SKIP_LIVE_AI=1 skips the one Claude call.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { check, envOf, OUTSIDER, OWNER, setup, signIn, summary, ws, WS } from "./lib.mts";

const env = envOf(path.join(import.meta.dirname, "..", ".env"));
// Prisma's timestamps have no zone and are UTC: read and write them as UTC (pg's default is local time).
pg.defaults.parseInputDatesAsUTC = true;
pg.types.setTypeParser(1114, (v: string) => new Date(`${v.replace(" ", "T")}Z`));
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
const OUTBOX = new URL("../../../projects-data/_forge/outbox.jsonl", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const live = !process.env.SKIP_LIVE_AI && !!env.ANTHROPIC_API_KEY;
const tick = async (job: string, extra: Record<string, unknown> = {}) =>
  (await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "x-iotx-key": env.IOTX_SERVICE_KEY, "content-type": "application/json" }, body: JSON.stringify({ job, ...extra }) })).json();

const { MEMBER } = await setup();
const O = await signIn(OWNER, "meetings");
const M = await signIn(MEMBER, "meetings");
const X = await signIn(OUTSIDER, "meetings").catch(() => "");
const owner = (await ws("/me", undefined, O)).json.me;
const member = (await ws("/me", undefined, M)).json.me;
const WSID = owner.ws as string;
const mFirst = String(member.name).split(" ")[0];
const memberAdmin = !!member.owner || !!member.perms["teamchat.admin"];

// ── Seeding ───────────────────────────────────────────────────────────────
const L = "abcdefghijkmnopqrstuvwxyz";
const newCode = () => [3, 4, 3].map((n) => Array.from({ length: n }, () => L[crypto.randomInt(L.length)]).join("")).join("-");
const id = () => crypto.randomUUID();
const meetingIds: string[] = [];
const eventIds: string[] = [];
type Seg = { start: number; end: number; speaker: string; identity?: string | null; text: string };
type Spk = { userId?: string | null; name: string; talkSec: number; words: number; wpm: number; fillers?: number; questions?: number; nonInclusive?: number; longestMonologueSec?: number };
function report(o: Partial<{ summary: string; topics: string[]; chapters: unknown[]; actionItems: unknown[]; keyQuestions: unknown[]; highlights: unknown[]; scores: { read: number; sentiment: number; engagement: number }; decisions: string[] }>) {
  return { version: 2, template: "general", language: "en", summary: o.summary ?? "A meeting.", chapters: o.chapters ?? [], actionItems: o.actionItems ?? [], keyQuestions: o.keyQuestions ?? [], decisions: o.decisions ?? [], topics: o.topics ?? [], highlights: o.highlights ?? [], sections: [], scores: o.scores ?? { read: 0, sentiment: 0, engagement: 0 }, timeline: [] };
}
async function seed(o: {
  title: string; host?: string; at: Date; minutes?: number; invitees?: string[]; kind?: string; eventId?: string | null; report?: unknown; transcript?: string;
  participants?: { userId?: string | null; name: string; identity: string; kind?: string }[]; segments?: Seg[]; speakers?: Spk[];
}) {
  const mid = id();
  const code = newCode();
  const end = new Date(o.at.getTime() + (o.minutes ?? 30) * 60_000);
  await db.query(
    `insert into meetings (id, ws, code, title, "hostId", invitees, "startedAt", "endedAt", "durationSec", kind, "eventId", report, transcript, "notesStatus", "createdAt")
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$7)`,
    [mid, WSID, code, o.title, o.host ?? owner.id, o.invitees ?? [], o.at, end, (o.minutes ?? 30) * 60, o.kind ?? "meeting", o.eventId ?? null, o.report ? JSON.stringify(o.report) : null, o.transcript ?? "", o.report ? "ready" : ""],
  );
  meetingIds.push(mid);
  for (const p of o.participants ?? [])
    await db.query(`insert into meet_participants (id, "meetingId", kind, "userId", name, identity, role, status, "joinedAt") values ($1,$2,$3,$4,$5,$6,$7,'admitted',$8)`, [id(), mid, p.kind ?? (p.userId ? "member" : "guest"), p.userId ?? null, p.name, p.identity, p.userId === (o.host ?? owner.id) ? "host" : p.kind ?? "member", o.at]);
  let seq = 0;
  for (const s of o.segments ?? []) await db.query(`insert into meet_segments (id, "meetingId", seq, start, "end", speaker, identity, text) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id(), mid, seq++, s.start, s.end, s.speaker, s.identity ?? null, s.text]);
  for (const s of o.speakers ?? [])
    await db.query(`insert into meet_speakers (id, "meetingId", "userId", name, "talkSec", words, wpm, fillers, questions, "nonInclusive", "longestMonologueSec") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id(), mid, s.userId ?? null, s.name, s.talkSec, s.words, s.wpm, s.fillers ?? 0, s.questions ?? 0, s.nonInclusive ?? 0, s.longestMonologueSec ?? 0]);
  return { id: mid, code };
}
const P_O = { userId: owner.id, name: owner.name, identity: `u_${owner.id}` };
const P_M = { userId: member.id, name: member.name, identity: `u_${member.id}` };
async function event(body: Record<string, unknown>, cookie = O) {
  const r = await ws("/calendar/events", body, cookie);
  if (r.json.event?.id) eventIds.push(r.json.event.id);
  return r;
}
const iso = (s: string) => new Date(s).toISOString();
const get = async (p: string, c = O) => (await ws(`/meet/read/${p}`, undefined, c));
const post = async (p: string, b: unknown, c = O, method?: string) => ws(`/meet/read/${p}`, b, c, method);

// IST helpers (both test people sign in with Asia/Kolkata).
const istDay = (offset = 0, now = new Date()) => new Date(now.getTime() + 5.5 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const istAt = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

const threads: string[] = [];
const folders: string[] = [];
let taskProjectCreated: string | null = null;
let channelId: string | null = null;
const prevRecap = (await db.query(`select "recapTo" from meet_read_settings where ws=$1`, [WSID])).rows[0]?.recapTo ?? null;

try {
  // ── For You data (March 2025) ───────────────────────────────────────────
  const FY = "from=2025-03-01T00:00:00Z&to=2025-03-31T00:00:00Z";
  const ev3 = await event({ title: "RDTEST-FY Customer call", start: "2025-03-12T06:00:00.000Z", end: "2025-03-12T06:30:00.000Z", tz: "UTC", attendees: [{ userId: member.id }] });
  check("seed: a calendar event with the member as guest", ev3.status === 201, ev3.json);
  const F1 = await seed({
    title: "RDTEST-FY Kickoff", at: new Date("2025-03-03T05:00:00Z"), kind: "upload", participants: [P_O, P_M],
    report: report({
      summary: "We agreed the enterprise pricing tier. Hiring was discussed.", topics: ["Pricing", "Hiring"],
      chapters: [{ title: "Pricing", start: 120, end: 400, summary: "Enterprise tier set at 40 dollars per seat." }],
      actionItems: [{ title: "Send the price sheet", owner: mFirst, due: "2025-03-10", start: 300 }, { title: "Book the venue", owner: owner.name, due: "", start: null }],
      keyQuestions: [{ question: "What is the discount for annual plans?", askedBy: owner.name, answered: false, start: 200 }],
      scores: { read: 70, sentiment: 65, engagement: 60 },
    }),
    segments: [
      { start: 125, end: 135, speaker: owner.name, identity: `u_${owner.id}`, text: "We agreed the enterprise pricing tier will be 40 dollars per seat." },
      { start: 300, end: 306, speaker: member.name, identity: `u_${member.id}`, text: "I will send the price sheet on Monday." },
    ],
  });
  const F2 = await seed({ title: "RDTEST-FY Roadmap review", at: new Date("2025-03-10T05:00:00Z"), invitees: [member.id], participants: [P_O], report: report({ summary: "The roadmap moved the mobile app to Q3.", topics: ["pricing", "Roadmap"], scores: { read: 75, sentiment: 70, engagement: 77 } }) });
  const F3 = await seed({ title: "RDTEST-FY Customer call", at: new Date("2025-03-12T06:01:00Z"), eventId: ev3.json.event.id, participants: [P_O], report: report({ summary: "The customer asked for SSO.", topics: ["SSO"], scores: { read: 60, sentiment: 55, engagement: 40 } }) });
  const F4 = await seed({ title: "RDTEST-FY Board prep", at: new Date("2025-03-14T05:00:00Z"), participants: [P_O], report: report({ summary: "The classified acquisition project is on track.", topics: ["Secret"] }), segments: [{ start: 10, end: 20, speaker: owner.name, identity: `u_${owner.id}`, text: "The classified acquisition project is on track for June." }] });

  let fy = (await get(`foryou?${FY}`, M)).json;
  const pricing = fy.topics?.find((t: any) => t.name.toLowerCase() === "pricing");
  check("For You: a topic is followed across meetings, oldest first", pricing?.meetings.length === 2 && pricing.meetings[0].code === F1.code && pricing.meetings[1].code === F2.code, fy.topics);
  check("For You: the topic links to its chapter's moment", pricing?.meetings[0].href === `/workspace/meet/${F1.code}/notes?t=120`, pricing);
  check("For You: topics only from reports I may see", !fy.topics.some((t: any) => t.name === "Secret"));
  check("What you missed: Meet invitee who didn't join", fy.missed.some((m: any) => m.code === F2.code && m.topics.includes("Roadmap")), fy.missed);
  check("What you missed: calendar guest who didn't join", fy.missed.some((m: any) => m.code === F3.code));
  check("What you missed: not meetings I attended", !fy.missed.some((m: any) => m.code === F1.code));
  check("What you missed: most engaging first", fy.missed[0]?.code === F2.code);
  const act = fy.actions.find((a: any) => a.title === "Send the price sheet");
  check("Action items: owner matched by name → For me", act?.mine === true && act.href.endsWith("?t=300"), act);
  check("Action items: someone else's isn't mine", fy.actions.find((a: any) => a.title === "Book the venue")?.mine === false);
  check("Key questions are gathered", fy.questions.some((q: any) => q.question.startsWith("What is the discount") && q.answered === false && q.mine === false));
  check("For You counts the reports used", fy.reports === 3, fy.reports);
  const ofy = (await get(`foryou?${FY}`)).json;
  check("For You (host): sees all four, 'Book the venue' is theirs", ofy.reports === 4 && ofy.actions.find((a: any) => a.title === "Book the venue")?.mine === true);
  if (member.perms["tasks.open"] && member.perms["tasks.create"]) {
    const had = (await db.query(`select id from projects where ws=$1 and name='Meeting follow-ups' and exists (select 1 from project_members pm where pm."projectId"=projects.id and pm."userId"=$2)`, [WSID, member.id])).rows[0];
    const t = await post("actions/task", { code: F1.code, idx: 0 }, M);
    if (!had && t.json.projectId) taskProjectCreated = t.json.projectId;
    const row = t.json.taskId ? (await db.query(`select title, "assigneeId", labels from tasks where id=$1`, [t.json.taskId])).rows[0] : null;
    check("Action item → task (assigned to me, labelled)", t.status === 200 && row?.title === "Send the price sheet" && row.assigneeId === member.id && row.labels.includes("meeting"), t.json);
    const t2 = await post("actions/task", { code: F1.code, idx: 0 }, M);
    check("…only once", t2.json.taskId === t.json.taskId && t2.json.existing === true);
    fy = (await get(`foryou?${FY}`, M)).json;
    check("…and For You links the task", !!fy.actions.find((a: any) => a.title === "Send the price sheet")?.taskHref);
    if (t.json.taskId && !taskProjectCreated) await db.query(`delete from tasks where id=$1`, [t.json.taskId]);
  } else check("Action item → task needs tasks.create (member lacks it)", (await post("actions/task", { code: F1.code, idx: 0 }, M)).status === 403);
  check("Action item → task: a report I can't see is 404", (await post("actions/task", { code: F4.code, idx: 0 }, M)).status === 404);

  // ── canSeeReport: shares and folders ────────────────────────────────────
  const rep = async (c: string) => ((await get(`reports?${FY}`, c)).json.reports as any[]).map((r) => r.code);
  check("Reports: the member can't see the host-only meeting", !(await rep(M)).includes(F4.code));
  let r = await post("share", { code: F4.code, userIds: [member.id] });
  check("Share a report with a colleague", r.status === 200 && r.json.shared === 1, r.json);
  check("…now they see it (canSeeReport)", (await rep(M)).includes(F4.code));
  check("…and it reaches For You topics", ((await get(`foryou?${FY}`, M)).json.topics as any[]).some((t) => t.name === "Secret"));
  check("…but they can't share it on (only people in the meeting)", (await post("share", { code: F4.code, userIds: [owner.id] }, M)).status === 403);
  r = await ws(`/meet/read/share?code=${F4.code}&user=${member.id}`, undefined, O, "DELETE");
  check("Stop sharing", r.status === 200 && !(await rep(M)).includes(F4.code));
  check("Sharing a report I can't see is 404", (await post("share", { code: F4.code, userIds: [owner.id] }, M)).status === 404);

  r = await post("folders", { name: "RDTEST shared", kind: "shared", members: [member.id] });
  const shared = r.json.folder?.id;
  folders.push(shared);
  check("Create a shared folder", r.status === 201 && r.json.folder.members.includes(member.id), r.json);
  r = await post(`folders/${shared}/items`, { codes: [F4.code] });
  check("Add a report to it", r.status === 200 && r.json.added === 1);
  check("Folder sharing widens canSeeReport", (await rep(M)).includes(F4.code));
  const mf = (await get("folders", M)).json.folders as any[];
  check("Members see the shared folder", mf.some((f) => f.id === shared && !f.mine && f.count === 1));
  check("…and its reports", ((await get(`folders/${shared}`, M)).json.reports as any[]).some((x) => x.code === F4.code));
  check("Members can add reports they see", (await post(`folders/${shared}/items`, { codes: [F1.code] }, M)).status === 200);
  check("…but not ones they can't", (await post(`folders/${shared}/items`, { codes: [newCode()] }, M)).status === 404);
  check("Members can't take out what the owner added", (await ws(`/meet/read/folders/${shared}/items?code=${F4.code}`, undefined, M, "DELETE")).status === 403);
  check("Members can't delete the folder", (await ws(`/meet/read/folders/${shared}`, undefined, M, "DELETE")).status === 403);
  check("Members can't rename it", (await ws(`/meet/read/folders/${shared}`, { name: "x" }, M, "PATCH")).status === 403);
  r = await post("folders", { name: "RDTEST mine", kind: "personal" });
  const personal = r.json.folder?.id;
  folders.push(personal);
  await post(`folders/${personal}/items`, { codes: [F4.code] });
  check("A personal folder is private", (await get(`folders/${personal}`, M)).status === 404);
  if (X) check("Other workspaces can't open a folder", (await get(`folders/${shared}`, X)).status === 404);
  r = await ws(`/meet/read/folders/${shared}`, { members: [] }, O, "PATCH");
  check("Remove the member → they lose the folder's reports", r.status === 200 && !(await rep(M)).includes(F4.code));
  r = await ws(`/meet/read/folders/${personal}`, { kind: "shared", members: [member.id] }, O, "PATCH");
  check("Personal → shared keeps its reports", r.status === 200 && r.json.folder.kind === "shared" && (await rep(M)).includes(F4.code), r.json);
  await ws(`/meet/read/folders/${personal}`, { kind: "personal" }, O, "PATCH");
  check("…and back to personal drops the members", !(await rep(M)).includes(F4.code));

  // Smart folders.
  r = await post("folders", { name: "RDTEST smart", kind: "smart", rules: { titleContains: "RDTEST-FY" } });
  const smart = r.json.folder?.id;
  folders.push(smart);
  let sv = (await get(`folders/${smart}`)).json;
  check("Smart folder fills itself (title contains)", r.status === 201 && [F1, F2, F3, F4].every((f) => sv.reports.some((x: any) => x.code === f.code)), sv.reports?.length);
  await ws(`/meet/read/folders/${smart}`, { rules: { topic: "roadmap", titleContains: "RDTEST-FY" } }, O, "PATCH");
  sv = (await get(`folders/${smart}`)).json;
  check("…topic rule", sv.reports.length === 1 && sv.reports[0].code === F2.code, sv.reports.map((x: any) => x.title));
  await ws(`/meet/read/folders/${smart}`, { rules: { source: "upload", titleContains: "RDTEST" } }, O, "PATCH");
  sv = (await get(`folders/${smart}`)).json;
  check("…source rule (upload)", sv.reports.length === 1 && sv.reports[0].code === F1.code);
  await ws(`/meet/read/folders/${smart}`, { rules: { attendee: member.email, titleContains: "RDTEST-FY" } }, O, "PATCH");
  sv = (await get(`folders/${smart}`)).json;
  check("…attendee rule (participants and invitees)", sv.reports.some((x: any) => x.code === F1.code) && sv.reports.some((x: any) => x.code === F2.code) && !sv.reports.some((x: any) => x.code === F4.code), sv.reports.map((x: any) => x.title));
  check("Smart folders can't be filled by hand", (await post(`folders/${smart}/items`, { codes: [F4.code] })).status === 400);
  check("A smart folder needs a rule", (await post("folders", { name: "RDTEST empty", kind: "smart", rules: {} })).status === 400);
  await ws(`/meet/read/folders/${smart}`, { rules: { topic: "secret", titleContains: "RDTEST-FY" }, members: [member.id] }, O, "PATCH");
  check("A shared smart folder widens access to what it holds", (await rep(M)).includes(F4.code));
  await ws(`/meet/read/folders/${smart}`, { members: [] }, O, "PATCH");

  // ── Ask: search with the coverage threshold, scope, tasks and chat ──────
  const search = async (q: string, c = O, folder?: string) => (await get(`ask/search?q=${encodeURIComponent(q)}${folder ? `&folder=${folder}` : ""}`, c)).json;
  let s = await search("enterprise pricing tier seat");
  const seg = s.sources?.find((x: any) => x.kind === "meeting" && x.href === `/workspace/meet/${F1.code}/notes?t=125`);
  check("Ask search: a transcript line, linked at its moment", !!seg && seg.ref.startsWith("M"), s.sources?.slice(0, 3));
  check("Ask search: chapters and summaries too", s.sources.some((x: any) => x.href === `/workspace/meet/${F1.code}/notes?t=120`) && s.sources.some((x: any) => x.href === `/workspace/meet/${F1.code}/notes` && /^Summary/.test(x.text)));
  s = await search("enterprise banana mango kiwi zebra");
  check("Ask search: one stray word isn't an answer (coverage threshold)", !s.sources.some((x: any) => x.kind === "meeting"), s.sources);
  check("Ask search: the member finds what they attended", (await search("enterprise pricing tier", M)).sources.some((x: any) => x.href.includes(F1.code)));
  check("Ask search: never what they can't see", !(await search("classified acquisition project", M)).sources.some((x: any) => x.kind === "meeting"));
  check("Ask search: the host does", (await search("classified acquisition project")).sources.some((x: any) => x.href.includes(F4.code)));
  check("Ask search: in a folder, only its reports", !(await search("enterprise pricing tier", O, personal)).sources.some((x: any) => x.href.includes(F1.code)) && (await search("classified acquisition", O, personal)).sources.some((x: any) => x.href.includes(F4.code)));
  check("Ask search: someone else's folder is 404", (await get(`ask/search?q=x&folder=${personal}`, M)).status === 404);
  const lastWeek = new Date(Date.now() - (((new Date().getUTCDay() + 6) % 7) + 3) * 86_400_000);
  const LW = await seed({ title: "RDTEST Weekly wrap", at: lastWeek, participants: [P_O], report: report({ summary: "Takeaways: the beta shipped and churn fell.", topics: ["Beta"] }) });
  s = await search("What are the major takeaways from last week's meetings?");
  check("Ask search: 'last week' brings that week's summaries", s.sources.some((x: any) => x.href === `/workspace/meet/${LW.code}/notes`), s.sources.map((x: any) => x.title));
  if (owner.perms["tasks.open"] && owner.perms["tasks.create"]) {
    const p = await ws("/tasks/projects", { name: `RDTEST Ask ${Date.now()}` }, O);
    const t = await ws("/tasks", { projectId: p.json.project.id, title: "Prepare the enterprise pricing deck" }, O);
    s = await search("enterprise pricing deck");
    check("Ask search: tasks I can see", t.status < 300 && s.sources.some((x: any) => x.kind === "task" && x.ref.startsWith("T") && x.text.includes("enterprise pricing deck")), s.sources.map((x: any) => x.ref));
    check("…not someone else's projects", !(await search("enterprise pricing deck", M)).sources.some((x: any) => x.kind === "task" && x.text.includes("Prepare the enterprise pricing deck")));
    await db.query(`delete from projects where id=$1`, [p.json.project.id]);
  }
  if (owner.perms["teamchat.open"]) {
    const ch = await ws("/chat/channels", { name: `rdtest-${Date.now() % 100000}`, kind: "private" }, O);
    channelId = ch.json.channel?.id ?? null;
    if (channelId) await ws(`/chat/channels/${channelId}/messages`, { body: "The enterprise pricing deck is ready for review" }, O);
    s = await search("enterprise pricing deck");
    check("Ask search: chat messages I can see", s.sources.some((x: any) => x.kind === "chat" && x.ref.startsWith("C")), s.sources.map((x: any) => x.ref));
    check("…not private channels I'm not in", !(await search("enterprise pricing deck", M)).sources.some((x: any) => x.kind === "chat" && x.href.includes(`channel=${channelId}`)));
  }
  const sug = (await get("ask/suggestions")).json.prompts as string[];
  check("Ask: Read's four suggested prompts", sug.length === 4 && sug[0].startsWith("What are the major takeaways") && sug[3].includes("at risk or overdue"));
  check("Ask needs a question", (await post("ask", { question: " " })).status === 400);
  check("Ask in someone else's folder is 404", (await post("ask", { question: "anything?", folderId: personal }, M)).status === 404);
  if (live) {
    r = await post("ask", { question: "What did we agree about the enterprise pricing tier?" });
    const msg = r.json.message;
    threads.push(r.json.threadId);
    check("Ask (Claude Sonnet 5.5): an answer from the meeting", r.status === 200 && /40/.test(msg?.text ?? ""), r.json);
    check("…citing the meeting at its moment", (msg?.sources ?? []).some((x: any) => x.kind === "meeting" && x.href.includes(F1.code)) && /\[M\d+\]/.test(msg?.text ?? ""), msg);
    const th = (await get("ask/threads")).json.threads as any[];
    check("Chat history lists it", th.some((t) => t.id === r.json.threadId));
    const one = (await get(`ask/threads/${r.json.threadId}`)).json.thread;
    check("…with the question and the answer", one?.messages.length === 2 && one.messages[0].role === "user");
    check("Someone else can't open my chat", (await get(`ask/threads/${r.json.threadId}`, M)).status === 404);
    check("Delete a chat", (await ws(`/meet/read/ask/threads/${r.json.threadId}`, undefined, O, "DELETE")).status === 200);
  } else console.log("SKIP live Ask (SKIP_LIVE_AI or no key)");

  // ── Coaching (February 2025) ────────────────────────────────────────────
  const CO = "from=2025-02-01T00:00:00Z&to=2025-02-28T00:00:00Z";
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const C1 = await seed({ title: "RDTEST-CO One", at: new Date("2025-02-03T05:00:00Z"), participants: [P_O, P_M], speakers: [{ userId: owner.id, name: owner.name, talkSec: 300, words: 600, wpm: 120, fillers: 10, questions: 3, longestMonologueSec: 60 }, { userId: member.id, name: member.name, talkSec: 100, words: 250, wpm: 150 }] });
  await seed({ title: "RDTEST-CO Two", at: new Date("2025-02-10T05:00:00Z"), participants: [P_O], speakers: [{ userId: owner.id, name: owner.name, talkSec: 600, words: 1500, wpm: 150, fillers: 4, questions: 5, nonInclusive: 0, longestMonologueSec: 90 }] });
  const C3 = await seed({
    title: "RDTEST-CO Three", at: new Date("2025-02-17T05:00:00Z"), participants: [P_O],
    speakers: [{ userId: owner.id, name: owner.name, talkSec: 400, words: 1267, wpm: 190, fillers: 6, questions: 1, nonInclusive: 2, longestMonologueSec: 180 }],
    segments: [
      { start: 10, end: 20, speaker: owner.name, identity: `u_${owner.id}`, text: words(70) },
      { start: 30, end: 34, speaker: owner.name, identity: `u_${owner.id}`, text: "Um, so, uh, we should basically ship it." },
      { start: 40, end: 44, speaker: owner.name, identity: `u_${owner.id}`, text: "Hey guys, check the blacklist first." },
      { start: 100, end: 160, speaker: owner.name, identity: `u_${owner.id}`, text: words(150) },
      { start: 161, end: 220, speaker: owner.name, identity: `u_${owner.id}`, text: words(150) },
      { start: 221, end: 280, speaker: owner.name, identity: `u_${owner.id}`, text: words(150) },
    ],
  });
  const co = (await get(`coaching?${CO}`)).json;
  check("Coaching: one row per meeting from MeetSpeaker", co.summary?.meetings === 3, co.summary);
  check("Coaching: pace range and share on target (130–175)", co.summary.wpm.min === 120 && co.summary.wpm.max === 190 && co.summary.paceInTarget === 33 && co.target.low === 130 && co.target.high === 175, co.summary.wpm);
  check("Coaching: talk ratio against everyone's talk", co.meetings.find((m: any) => m.code === C1.code)?.talkRatio === 75);
  check("Coaching: fillers per minute", co.meetings.find((m: any) => m.code === C1.code)?.fillersPerMin === 2);
  check("Coaching: longest monologue and non-inclusive range", co.summary.longestMonologueSec.max === 180 && co.summary.nonInclusive.max === 2);
  const kinds = new Set((co.moments as any[]).map((m) => m.kind));
  check("Moments: too fast, fillers, non-inclusive, long monologue", ["fast", "filler", "noninclusive", "monologue"].every((k) => kinds.has(k)), [...kinds]);
  check("Moments link to the report at the time", (co.moments as any[]).some((m) => m.kind === "fast" && m.href === `/workspace/meet/${C3.code}/notes?t=10`) && (co.moments as any[]).some((m) => m.kind === "monologue" && m.start === 100));
  check("Coaching: no face metrics", !JSON.stringify(co).match(/charisma|bias|face/i));
  check("Coaching: the member can't see the owner's", (await get(`coaching?${CO}&user=${owner.id}`, M)).status === (memberAdmin ? 200 : 403));
  const cm = await get(`coaching?${CO}&user=${member.id}`);
  check("Coaching: an admin can see a member's", cm.status === 200 && cm.json.person.id === member.id && cm.json.summary.meetings === 1, cm.json.summary);
  check("Coaching: bad period is 400", (await get("coaching?from=2025-02-10&to=2025-02-01")).status === 400);

  // ── Meeting Policy (January 2025) ───────────────────────────────────────
  const PO = "from=2025-01-01T00:00:00Z&to=2025-01-31T00:00:00Z";
  const e1 = await event({ title: "RDTEST-PO On time", start: "2025-01-06T04:30:00.000Z", end: "2025-01-06T05:00:00.000Z", tz: "UTC" });
  const e2 = await event({ title: "RDTEST-PO Late", start: "2025-01-13T08:45:00.000Z", end: "2025-01-13T09:30:00.000Z", tz: "UTC" });
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: null, name: `Guest ${i}`, identity: `g_rd${i}_${crypto.randomInt(1e9)}`, kind: "guest" }));
  await seed({ title: "RDTEST-PO A", at: new Date("2025-01-06T04:32:00Z"), minutes: 25, eventId: e1.json.event.id, participants: [P_O, P_M], report: report({ scores: { read: 80, sentiment: 70, engagement: 60 } }) });
  await seed({ title: "RDTEST-PO B", at: new Date("2025-01-13T09:00:00Z"), minutes: 45, eventId: e2.json.event.id, participants: [P_O, ...many(4)], report: report({ scores: { read: 60, sentiment: 50, engagement: 40 } }) });
  await seed({ title: "RDTEST-PO C", at: new Date("2025-01-08T13:00:00Z"), minutes: 90, participants: [P_O, ...many(8)], report: report({ scores: { read: 40, sentiment: 30, engagement: 20 } }) });
  await seed({ title: "RDTEST-PO D", at: new Date("2025-01-15T04:00:00Z"), minutes: 30, participants: [P_O, P_M] });
  const po = (await get(`policy?${PO}`)).json;
  const b = (arr: any[], k: string) => arr.find((x) => x.k === k);
  check("Policy: my meetings in the period", po.meetings === 4 && po.overall.scored === 3, po.overall);
  check("Policy: averages from speech/text scores", po.overall.read === 60 && po.overall.sentiment === 50 && po.overall.engagement === 40);
  check("Policy: on-time rate = Meet start vs calendar start", po.overall.onTime === 50 && po.overall.timed === 2, po.overall);
  check("Policy: by day of week (in my zone)", b(po.day, "1").meetings === 2 && b(po.day, "1").read === 70 && b(po.day, "3").meetings === 2 && b(po.day, "3").read === 40, po.day);
  check("Policy: by time of day", b(po.time, "morning").meetings === 2 && b(po.time, "afternoon").meetings === 1 && b(po.time, "evening").meetings === 1, po.time);
  check("Policy: by size (1:1, 3–7, 8+)", b(po.size, "1:1").meetings === 2 && b(po.size, "3-7").meetings === 1 && b(po.size, "8+").meetings === 1, po.size);
  check("Policy: by length (≤30, 30–60, >60)", b(po.duration, "<=30").meetings === 2 && b(po.duration, "30-60").meetings === 1 && b(po.duration, ">60").meetings === 1, po.duration);
  check("Policy: personal by default (the member was in two)", (await get(`policy?${PO}`, M)).json.meetings === 2);
  check("Policy: workspace-wide is for admins", (await get(`policy?${PO}&scope=workspace`, M)).status === (memberAdmin ? 200 : 403));
  const pw = await get(`policy?${PO}&scope=workspace`);
  check("Policy: the owner sees the workspace", pw.status === 200 && pw.json.meetings >= 4 && pw.json.scope === "workspace");

  // ── Recommendations ─────────────────────────────────────────────────────
  const dayMs = 86_400_000;
  const startMon = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 42, 5, 0));
  const rs = await event({ title: "RDTEST-RC Weekly sync", start: startMon.toISOString(), end: new Date(startMon.getTime() + 3_600_000).toISOString(), tz: "UTC", rrule: "FREQ=WEEKLY", attendees: [{ userId: member.id }] });
  const rsId = rs.json.event.id;
  const RM = await seed({ title: "RDTEST-RC Weekly sync", at: new Date(startMon.getTime() + 35 * dayMs), eventId: rsId, participants: [P_O, P_M], report: report({ scores: { read: 40, sentiment: 45, engagement: 35 } }) });
  const past = [0, 1, 2, 3, 4, 5].map((w) => new Date(startMon.getTime() + w * 7 * dayMs)).filter((d) => d.getTime() < Date.now() - 2 * 3_600_000);
  for (const d of past) await tick("attendance", { meetingId: RM.id, userId: owner.id, now: d.toISOString() });
  await tick("attendance", { meetingId: RM.id, userId: member.id, now: past[0].toISOString() });
  let mr = (await get("recommendations?refresh=1", M)).json.items as any[];
  const dec = mr.find((x) => x.kind === "decline" && x.event?.id === rsId);
  check("Recommendation: decline a series you often skip, with the reason", !!dec && new RegExp(`missed ${past.length - 1} of the last ${past.length}`).test(dec.reason), mr);
  const sgg = mr.find((x) => x.kind === "suggest" && x.event?.id === rsId);
  check("Recommendation: a low-scoring series → suggest it be shorter (guest)", !!sgg && /Read score is 40/.test(sgg.reason));
  let orc = (await get("recommendations?refresh=1")).json.items as any[];
  const shorter = orc.find((x) => x.kind === "shorter" && x.event?.id === rsId);
  const less = orc.find((x) => x.kind === "less_often" && x.event?.id === rsId);
  check("Recommendation (organiser): make it shorter", !!shorter && shorter.details.minutes === 45, orc);
  check("Recommendation (organiser): less often", !!less && less.details.rrule === "FREQ=WEEKLY;INTERVAL=2");
  check("Organisers aren't told to decline their own series", !orc.some((x) => x.kind === "decline" && x.event?.id === rsId));
  check("Nothing changed before Accept", (await db.query(`select response from attendees where "eventId"=$1 and "userId"=$2`, [rsId, member.id])).rows[0].response === "needs");
  check("Someone else's suggestion is 404", (await post(`recommendations/${dec.id}`, { action: "accept" })).status === 404);
  r = await post(`recommendations/${dec.id}`, { action: "accept" }, M);
  check("Accept → declines the series in Calendar", r.status === 200 && (await db.query(`select response from attendees where "eventId"=$1 and "userId"=$2`, [rsId, member.id])).rows[0].response === "no", r.json);
  check("…only once", (await post(`recommendations/${dec.id}`, { action: "accept" }, M)).status === 400);
  r = await post(`recommendations/${sgg.id}`, { action: "ignore" }, M);
  check("Ignore hides it", r.status === 200 && !((await get("recommendations?refresh=1", M)).json.items as any[]).some((x) => x.id === sgg.id));
  const rev = (await get("recommendations?tab=reviewed", M)).json.items as any[];
  check("Reviewed tab: accepted and ignored, with what happened", rev.some((x) => x.id === dec.id && x.status === "accepted" && /declined/.test(x.result)) && rev.some((x) => x.id === sgg.id && x.status === "ignored"));
  r = await post(`recommendations/${shorter.id}`, { action: "accept" });
  const evRow = (await db.query(`select start, "end", rrule from events where id=$1`, [rsId])).rows[0];
  check("Accept 'shorter' → the series is 45 minutes", r.status === 200 && (evRow.end - evRow.start) === 45 * 60_000, r.json);
  r = await post(`recommendations/${less.id}`, { action: "accept" });
  check("Accept 'less often' → every other week", r.status === 200 && (await db.query(`select rrule from events where id=$1`, [rsId])).rows[0].rrule === "FREQ=WEEKLY;INTERVAL=2");
  orc = (await get("recommendations?refresh=1")).json.items as any[];
  check("Reviewed suggestions aren't offered again", !orc.some((x) => (x.kind === "shorter" || x.kind === "less_often") && x.event?.id === rsId));

  // ── Flexible meetings ───────────────────────────────────────────────────
  let D = istDay(2);
  while (![1, 2, 3, 4, 5].includes(weekday(D))) D = istDay(Math.round((Date.parse(D) - Date.parse(istDay(0))) / dayMs) + 1);
  const fx1 = await event({ title: "RDTEST-FX Internal", start: istAt(D, "11:00").toISOString(), end: istAt(D, "11:30").toISOString(), tz: "Asia/Kolkata", attendees: [{ userId: member.id }] });
  await event({ title: "RDTEST-FX Block A", start: istAt(D, "11:00").toISOString(), end: istAt(D, "12:00").toISOString(), tz: "Asia/Kolkata" });
  const fx2 = await event({ title: "RDTEST-FX External", start: istAt(D, "15:00").toISOString(), end: istAt(D, "15:30").toISOString(), tz: "Asia/Kolkata", attendees: [{ userId: member.id }, { email: "rd-ext@example.com" }] });
  await event({ title: "RDTEST-FX Block B", start: istAt(D, "15:00").toISOString(), end: istAt(D, "16:00").toISOString(), tz: "Asia/Kolkata" });
  const rec = await event({ title: "RDTEST-FX Series", start: istAt(D, "17:00").toISOString(), end: istAt(D, "17:30").toISOString(), tz: "Asia/Kolkata", rrule: "FREQ=WEEKLY;COUNT=3", attendees: [{ userId: member.id }] });
  const f1 = fx1.json.event.id, f2 = fx2.json.event.id;
  check("Flexible: the organiser can switch it on", (await get(`flexible?eventId=${f1}`)).json.canSet === true && (await post("flexible", { eventId: f1, on: true })).status === 200);
  check("Flexible: a guest can't", (await post("flexible", { eventId: f1, on: true }, M)).status === 403);
  check("Flexible: not for repeating events (for now)", (await post("flexible", { eventId: rec.json.event.id, on: true })).status === 400);
  const o0 = outbox().length;
  const ft = await tick("flexible");
  const a1 = (ft.actions as any[]).find((x) => x.eventId === f1);
  const e1row = (await db.query(`select start, "end" from events where id=$1`, [f1])).rows[0];
  const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString();
  check("Flexible: a clash with only internal guests moves it by itself", a1?.action === "moved" && e1row.start.getTime() !== istAt(D, "11:00").getTime(), ft);
  check("…to the same day, inside working hours, clear of the clash", ist(e1row.start).slice(0, 10) === D && ist(e1row.start).slice(11, 16) >= "09:30" && ist(e1row.end).slice(11, 16) <= "18:30" && !(e1row.start < istAt(D, "12:00") && e1row.end > istAt(D, "11:00")), ist(e1row.start));
  check("…keeping its length", e1row.end - e1row.start === 30 * 60_000);
  const notes = (await ws("/notifications", undefined, M)).json.items as any[];
  check("…and guests are told (the usual update)", notes.some((n) => /changed the time: RDTEST-FX Internal/.test(n.title)));
  await post("flexible", { eventId: f2, on: true });
  const ftb = await tick("flexible");
  const a2 = (ftb.actions as any[]).find((x) => x.eventId === f2);
  check("Flexible: with an outside guest it only proposes", a2?.action === "proposed" && (await db.query(`select start from events where id=$1`, [f2])).rows[0].start.getTime() === istAt(D, "15:00").getTime(), ftb);
  orc = (await get("recommendations")).json.items as any[];
  const mv = orc.find((x) => x.kind === "move" && x.event?.id === f2);
  check("…as a recommendation with the reason", !!mv && /another meeting at the same time/.test(mv.reason) && /outside the workspace/.test(mv.reason), mv);
  const auto = ((await get("recommendations?tab=reviewed")).json.items as any[]).find((x) => x.kind === "move" && x.event?.id === f1);
  check("The automatic move is logged under Reviewed", auto?.status === "accepted" && auto.details.auto === true);
  r = await post(`recommendations/${mv.id}`, { action: "accept" });
  const e2row = (await db.query(`select start from events where id=$1`, [f2])).rows[0];
  check("Accept the proposal → moved", r.status === 200 && e2row.start.getTime() === Date.parse(mv.details.to.start), r.json);
  check("…and the outside guest gets the updated invite", outbox().slice(o0).some((x) => x.to === "rd-ext@example.com" && /Updated invitation: RDTEST-FX External/.test(x.subject)));
  const ft2 = await tick("flexible");
  check("Flexible: nothing to do once it's clear", !(ft2.actions as any[]).some((x) => x.eventId === f1 || x.eventId === f2), ft2);
  await post("flexible", { eventId: f1, on: false });
  check("Flexible: switch it off", (await get(`flexible?eventId=${f1}`)).json.on === false);

  // ── Daily Read ──────────────────────────────────────────────────────────
  let now = new Date();
  const istHour = Number(ist(now).slice(11, 13));
  if (istHour < 4) now = istAt(istDay(0), "05:00");
  const today = istDay(0, now), yday = istDay(-1, now);
  await db.query(`delete from read_digests where "userId"=$1 and day=$2`, [member.id, today]);
  const DY = await seed({ title: "RDTEST-DR Beta planning", at: istAt(yday, "12:00"), participants: [P_O, P_M], report: report({ summary: "We planned the beta launch. More details followed.", actionItems: [{ title: "Draft the beta FAQ", owner: mFirst, due: "", start: 42 }] }) });
  await event({ title: "RDTEST-DR Standup", start: istAt(today, "21:00").toISOString(), end: istAt(today, "21:15").toISOString(), tz: "Asia/Kolkata", attendees: [{ userId: member.id }] });
  r = await post("settings", { dailyRead: true, dailyHour: 4 }, M);
  check("Daily Read: opt in (Meet settings)", r.status === 200 && r.json.prefs.dailyRead === true && r.json.prefs.dailyHour === 4, r.json);
  check("Daily Read: hours are 4–11", (await post("settings", { dailyHour: 15 }, M)).json.prefs.dailyHour === 4);
  const d0 = outbox().length;
  const dt = await tick("daily-read", { now: now.toISOString() });
  const mail = outbox().slice(d0).find((x) => x.to === member.email && /Your Daily Read/.test(x.subject));
  check("Daily Read: emailed through the suite mail route", dt.sent >= 1 && !!mail, dt);
  check("…yesterday's meetings with a summary line", !!mail && mail.text.includes("RDTEST-DR Beta planning: We planned the beta launch.") && mail.html.includes(`/workspace/meet/${DY.code}/notes`));
  check("…my open action items", !!mail && mail.text.includes("Draft the beta FAQ"));
  check("…today's meetings with prep links", !!mail && mail.text.includes("RDTEST-DR Standup") && /calendar\?event=[^&\s]+&prep=1/.test(mail.text));
  check("…not to people who didn't opt in", !outbox().slice(d0).some((x) => x.to === owner.email && /Your Daily Read/.test(x.subject)));
  await tick("daily-read", { now: now.toISOString() });
  check("…once a day", outbox().slice(d0).filter((x) => x.to === member.email && /Your Daily Read/.test(x.subject)).length === 1);
  const dd = (await get("daily", M)).json;
  check("Daily Read is shown in the app", dd.saved === true && dd.data.yesterday.some((y: any) => y.code === DY.code) && !!dd.emailedAt, dd);
  check("Daily Read preview for someone who hasn't opted in", (await get("daily")).json.saved === false);
  await post("settings", { dailyRead: false }, M);

  // ── Report sharing setting and opt-outs ─────────────────────────────────
  const st = (await get("settings", M)).json;
  check("Settings: the member isn't an admin", st.admin === memberAdmin && st.recap.recapTo);
  if (!memberAdmin) check("Only admins change who gets recaps", (await post("settings", { recapTo: "me" }, M)).status === 403);
  await post("settings", { recapTo: "invitees" });
  let rr = (await get(`recap?code=${F2.code}`)).json;
  check("Recaps to invitees: Meet invitees who didn't join get it", rr.recapTo === "invitees" && rr.userIds.includes(member.id) && rr.userIds.includes(owner.id), rr);
  rr = (await get(`recap?code=${F3.code}`)).json;
  check("…and calendar guests", rr.userIds.includes(member.id));
  await post("settings", { recapTo: "attendees" });
  check("Recaps to attendees: only people who joined", !(await get(`recap?code=${F2.code}`)).json.userIds.includes(member.id) && (await get(`recap?code=${F1.code}`)).json.userIds.includes(member.id));
  await post("settings", { recapTo: "me" });
  rr = (await get(`recap?code=${F1.code}`)).json;
  check("Recaps to only me: the host", rr.userIds.length === 1 && rr.userIds[0] === owner.id);

  check("Opt out (member, signed in)", (await post("settings", { optOut: true }, M)).json.optedOut === true && (await get("settings", M)).json.optedOut === true);
  const guestName = `Guest Gita ${crypto.randomInt(1e6)}`;
  const OP = await seed({
    title: "RDTEST-OP Opt-out", at: new Date(), participants: [P_O, P_M, { userId: null, name: guestName, identity: `g_rd_${crypto.randomInt(1e9)}`, kind: "guest" }],
    transcript: `${owner.name}: Hello all.\n${member.name}: My private remark.\n${guestName}: Guest words.`,
    report: report({ summary: "Opt-out test.", highlights: [{ start: 5, end: 9, text: "private remark", by: member.name }, { start: 1, end: 3, text: "Hello", by: owner.name }], keyQuestions: [{ question: "Is this private?", askedBy: member.name, answered: false, start: 5 }] }),
    segments: [
      { start: 1, end: 3, speaker: owner.name, identity: `u_${owner.id}`, text: "Hello all." },
      { start: 5, end: 9, speaker: member.name, identity: `u_${member.id}`, text: "My private remark." },
      { start: 10, end: 12, speaker: guestName, identity: null, text: "Guest words." },
    ],
    speakers: [{ userId: owner.id, name: owner.name, talkSec: 2, words: 2, wpm: 60 }, { userId: member.id, name: member.name, talkSec: 4, words: 3, wpm: 45 }],
  });
  await db.query(`insert into meet_captions (id, "meetingId", identity, name, text) values ($1,$2,$3,$4,'caption line')`, [id(), OP.id, `u_${member.id}`, member.name]);
  let dropped = (await tick("read-optouts", { meetingId: OP.id })).dropped as string[];
  const segsLeft = (await db.query(`select speaker from meet_segments where "meetingId"=$1 order by seq`, [OP.id])).rows.map((x) => x.speaker);
  check("Opt-out drops their transcript lines", dropped.includes(member.name.toLowerCase()) && !segsLeft.includes(member.name) && segsLeft.includes(owner.name), { dropped, segsLeft });
  check("…their captions and speaker numbers", (await db.query(`select count(*)::int n from meet_captions where "meetingId"=$1 and identity=$2`, [OP.id, `u_${member.id}`])).rows[0].n === 0 && (await db.query(`select count(*)::int n from meet_speakers where "meetingId"=$1 and "userId"=$2`, [OP.id, member.id])).rows[0].n === 0);
  const opRow = (await db.query(`select report, transcript from meetings where id=$1`, [OP.id])).rows[0];
  check("…and what the report attributes to them", !opRow.report.highlights.some((h: any) => h.by === member.name) && opRow.report.highlights.length === 1 && opRow.report.keyQuestions.length === 0 && !opRow.transcript.includes("private remark"));
  await post("settings", { optOut: false }, M);
  check("Opt back in", (await get("settings", M)).json.optedOut === false);

  const extEmail = `rd-optout-${crypto.randomInt(1e6)}@example.com`;
  check("Outside opt-out: needs an email", (await ws("/meet/read/optout", { code: OP.code, email: "nope" })).status === 400);
  check("Outside opt-out: needs a real meeting code", (await ws("/meet/read/optout", { code: "zzz-zzzz-zzz", email: extEmail })).status === 400);
  const o1 = outbox().length;
  r = await ws("/meet/read/optout", { code: OP.code, email: extEmail, name: guestName });
  const conf = outbox().slice(o1).find((x) => x.to === extEmail);
  const token = /opt-out\?t=([A-Za-z0-9_-]+)/.exec(conf?.text ?? "")?.[1];
  check("Outside opt-out: a confirmation link by email (no sign-in)", r.status === 200 && !!token, conf);
  check("…not in force until confirmed", ((await tick("read-optouts", { meetingId: OP.id })).dropped as string[]).length === 0);
  check("Confirm", (await ws("/meet/read/optout/confirm", { token })).status === 200);
  check("…a link works once", (await ws("/meet/read/optout/confirm", { token })).status === 400);
  dropped = (await tick("read-optouts", { meetingId: OP.id })).dropped as string[];
  check("…then the guest's lines are dropped too", dropped.includes(guestName.toLowerCase()) && !(await db.query(`select speaker from meet_segments where "meetingId"=$1`, [OP.id])).rows.some((x) => x.speaker === guestName), dropped);
  await db.query(`delete from read_opt_outs where ws=$1 and email=$2`, [WSID, extEmail]);

  // ── Attendance per day, from a real join ────────────────────────────────
  const nm = await ws("/meet", { title: "RDTEST attendance" }, O);
  const nmRow = (await db.query(`select id from meetings where code=$1`, [nm.json.meeting.code])).rows[0];
  meetingIds.push(nmRow.id);
  const j = await ws(`/meet/${nm.json.meeting.code}/join`, {}, M);
  let att = 0;
  for (let i = 0; i < 10 && !att; i++) {
    await new Promise((res) => setTimeout(res, 200));
    att = (await db.query(`select count(*)::int n from read_attendance where "meetingId"=$1 and "userId"=$2`, [nmRow.id, member.id])).rows[0].n;
  }
  check("Joining logs attendance for the day", j.status === 200 && att === 1, j.json);

  // ── Pages ───────────────────────────────────────────────────────────────
  for (const p of ["", "/ask", "/foryou", "/coaching", "/recommendations", "/insights", "/folders", "/daily", "/settings"]) {
    const res = await fetch(`${WS}/meet${p}`, { headers: { cookie: O } });
    const html = await res.text();
    check(`Page /meet${p} renders with the Meet nav`, res.status === 200 && html.includes("Meet sections"), res.status);
  }
  const op = await fetch(`${WS}/meet/opt-out`);
  check("Opt-out page is public", op.status === 200 && (await op.text()).includes("summarise me"));
} finally {
  // ── Clean up everything this test made ───────────────────────────────────
  if (meetingIds.length) {
    await db.query(`delete from meet_folder_items where "meetingId" = any($1)`, [meetingIds]);
    await db.query(`delete from meet_report_shares where "meetingId" = any($1)`, [meetingIds]);
    await db.query(`delete from read_action_tasks where "meetingId" = any($1)`, [meetingIds]);
    await db.query(`delete from read_attendance where "meetingId" = any($1)`, [meetingIds]);
    await db.query(`delete from meetings where id = any($1)`, [meetingIds]);
  }
  if (folders.length) await db.query(`delete from meet_folders where id = any($1)`, [folders.filter(Boolean)]);
  if (eventIds.length) {
    await db.query(`delete from meet_recommendations where "eventId" = any($1)`, [eventIds]);
    await db.query(`delete from meet_flexible where "eventId" = any($1)`, [eventIds]);
    await db.query(`delete from events where id = any($1) or "recurringId" = any($1)`, [eventIds]);
  }
  if (taskProjectCreated) await db.query(`delete from projects where id=$1`, [taskProjectCreated]);
  if (channelId) await db.query(`delete from channels where id=$1`, [channelId]);
  if (threads.length) await db.query(`delete from meet_ask_threads where id = any($1)`, [threads]);
  await db.query(`delete from read_digests where "userId"=$1 and day >= $2`, [member.id, istDay(-1)]);
  await db.query(`delete from read_prefs where "userId" = any($1)`, [[member.id]]);
  await db.query(`delete from read_opt_outs where ws=$1 and "userId" = any($2)`, [WSID, [member.id, owner.id]]);
  if (prevRecap) await db.query(`update meet_read_settings set "recapTo"=$2 where ws=$1`, [WSID, prevRecap]);
  else await db.query(`delete from meet_read_settings where ws=$1`, [WSID]);
  await db.end();
}
process.exit(summary("test-meet-insights") ? 1 : 0);
