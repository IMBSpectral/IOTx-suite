/**
 * Calendar AI: quick add, best-time scheduling, Ask Calendar (tool use, drafts
 * only), the daily brief and conflict detection, meeting prep (with Mail from
 * the suite), Plan my day, working hours and permissions; knowledge first (each
 * AI call gets the suite's company knowledge lookup before the model acts).
 *
 * Deterministic: a mock of the Anthropic Messages API on :4801 and a second
 * Workspace server on :3101 started with ANTHROPIC_BASE_URL pointing at it
 * (same build and database). Then one LIVE smoke test against the real API on
 * the normal server (:3100), skipped with LIVE=0.
 *   npx tsx scripts/test-cal-ai.mts <devToken> <test-users.json>
 */
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import pg from "pg";

process.env.WS = "http://localhost:3101/workspace";
const L = await import("./lib.mts");
const { check, envOf, OWNER, setup, sleep, summary, ws, setMemberPerm, resetMember } = L;

/** A pass through the allowed :3100 callback, redeemed on the :3101 test server (same database). */
async function signIn(suiteCookie: string, port = 3101) {
  const cb = `http://localhost:3100/workspace/auth/callback?next=/calendar`;
  const r = await fetch(`${L.SUITE}/api/iotx/pass?app=calendar&redirect=${encodeURIComponent(cb)}`, { headers: { cookie: suiteCookie }, redirect: "manual" });
  const pass = /#iotx_pass=(.+)$/.exec(r.headers.get("location") ?? "")?.[1];
  if (!pass) throw new Error(`no pass (${r.status})`);
  const s = await fetch(`http://localhost:${port}/workspace/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pass, tz: "Asia/Kolkata" }) });
  const c = /iotx_ws_session=([^;]+)/.exec(s.headers.get("set-cookie") ?? "");
  if (!c) throw new Error(`no session (${s.status})`);
  return `iotx_ws_session=${c[1]}`;
}

const here = (p: string) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const WEB_DB = envOf(here("../../../web/.env")).DATABASE_URL;
const TZ = "Asia/Kolkata";
const tag = `A${Date.now().toString(36)}`;

// ── Dates in the test user's zone (signIn sets Asia/Kolkata) ──────────────
const ist = (t: number) => new Date(t + 330 * 60_000);
const istDate = (days = 0) => ist(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const istHM = (iso: string) => ist(Date.parse(iso)).toISOString().slice(11, 16);
const istDay = (iso: string) => ist(Date.parse(iso)).toISOString().slice(0, 10);
const at = (date: string, hm: string) => new Date(`${date}T${hm}:00+05:30`).toISOString();
const wd = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const nextWeekday = (d: number, min = 2) => {
  for (let i = min; i < 14; i++) if (wd(istDate(i)) === d) return istDate(i);
  return istDate(min);
};

// ── Mock Anthropic API ────────────────────────────────────────────────────
type Req = { model: string; max_tokens: number; system?: string; messages: { role: string; content: any }[]; tools?: { name: string }[]; output_config?: any };
const seen: Req[] = [];
let memberFirst = "Member";
const msg = (content: unknown[], stop: string) => ({ id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model: "mock", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
const json = (o: unknown) => msg([{ type: "text", text: JSON.stringify(o) }], "end_turn");
const tool = (name: string, input: unknown) => msg([{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2)}`, name, input }], "tool_use");
const text = (t: string) => msg([{ type: "text", text: t }], "end_turn");
const parse = (o: Partial<Record<string, unknown>>) => ({ intent: "create", title: "", date: null, time: null, durationMinutes: null, allDay: false, location: "", attendees: [], freq: "NONE", byDay: [], interval: 1, video: false, rangeStart: null, rangeEnd: null, dayPart: "any", note: "", ...o });

function reply(r: Req) {
  const sys = r.system ?? "";
  const last = r.messages[r.messages.length - 1];
  if (sys.startsWith("You read one short calendar request")) {
    const t = String(last.content);
    const fri = /Fri (\d{4}-\d\d-\d\d)/.exec(sys)?.[1];
    const tomorrow = /(\d{4}-\d\d-\d\d) \(tomorrow\)/.exec(sys)?.[1];
    const wed = [...sys.matchAll(/Wed (\d{4}-\d\d-\d\d)/g)].map((m) => m[1]).pop();
    if (/best time/i.test(t)) return json(parse({ intent: "schedule", title: "Planning", attendees: [memberFirst], durationMinutes: 60, rangeStart: /RANGE=(\S+)/.exec(t)?.[1], rangeEnd: /RANGE=\S+ (\S+)/.exec(t)?.[1] }));
    if (/every Monday/i.test(t)) return json(parse({ title: "Standup", time: "10:00", freq: "WEEKLY", byDay: ["MO"] }));
    if (/Ghost/.test(t)) return json(parse({ title: "Sync", date: tomorrow, time: "11:00", attendees: ["Ghost Person"] }));
    if (/supplier/.test(t)) return json(parse({ title: "Call with the supplier", date: wed }));
    if (/weather/.test(t)) return json(parse({ intent: "unclear", note: "" }));
    return json(parse({ title: "Review", date: fri, time: "15:00", durationMinutes: 45, location: "Pune office", attendees: [memberFirst], video: true }));
  }
  if (sys.startsWith("You write the one-sentence headline")) return json({ headline: "Mock headline: one clash at 3 pm." });
  if (sys.startsWith("You prepare a busy person")) {
    const facts = JSON.parse(String(last.content));
    return json({ bullets: [`Decide on ${facts.meeting.title}`, `Emails: ${facts.recentEmails.map((e: { subject: string }) => e.subject).join("; ") || "none"}`, `Tasks: ${facts.relatedTasks.length}`] });
  }
  if (sys.startsWith("You plan focus time")) {
    const list = JSON.parse(String(last.content)) as { id: string }[];
    return json({ plan: list.slice(0, 2).map((x, i) => ({ taskId: x.id, minutes: i ? 30 : 60, reason: "Due soon" })) });
  }
  if (r.tools?.length) {
    const firstQ = String(r.messages.filter((m) => m.role === "user" && typeof m.content === "string").pop()?.content ?? "");
    if (typeof last.content === "string") {
      if (/Ghost/.test(firstQ)) return tool("create_event", { title: "Lunch", date: istDate(1), start_time: "13:00", duration_minutes: 60, attendee_names: ["Ghost Person"], location: "" });
      return tool("list_events", { from: istDate(0), to: istDate(7) });
    }
    const results = (last.content as { type: string; content: string; is_error?: boolean }[]).filter((b) => b.type === "tool_result");
    const prevTool = (r.messages[r.messages.length - 2].content as { type: string; name?: string }[]).find((b) => b.type === "tool_use")?.name;
    if (prevTool === "list_events") {
      const list = results[0].content.startsWith("[") ? (JSON.parse(results[0].content) as { id: string; title: string }[]) : [];
      const ev = list.find((e) => e.title.includes("Design sync"));
      if (/Move/.test(firstQ) && ev) return tool("update_event", { event_id: ev.id, occurrence_start: null, scope: "all", new_date: istDate(1), new_start_time: "10:00", new_duration_minutes: null, new_title: null });
      if (/Cancel/.test(firstQ) && ev) return tool("delete_event", { event_id: ev.id, occurrence_start: null, scope: "all" });
      return text(`You have ${list.length} events this week.`);
    }
    if (results[0]?.is_error) return text("I couldn't find Ghost Person in your workspace.");
    return text("I've prepared that change for you to confirm.");
  }
  return text("ok");
}

const mock = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end("{}");
      return;
    }
    const r = JSON.parse(b) as Req;
    seen.push(r);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply(r)));
  });
});
await new Promise<void>((r) => mock.listen(4801, "127.0.0.1", r));

// ── A second Workspace server pointed at the mock ─────────────────────────
let srv: ChildProcess | null = null;
async function startServer() {
  srv = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "start", "-p", "3101"], {
    cwd: here(".."),
    env: { ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:4801", ANTHROPIC_API_KEY: "mock-key" },
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const ok = await fetch("http://localhost:3101/workspace/api/me").then((r) => r.status === 401).catch(() => false);
    if (ok) return;
  }
  throw new Error("test server on :3101 didn't start");
}
function stopServer() {
  if (!srv?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(srv.pid), "/T", "/F"], { stdio: "ignore" });
  else srv.kill();
}

const db = new pg.Client({ connectionString: WEB_DB });
await db.connect();
const cleanup: (() => Promise<unknown>)[] = [];
const { wsId, MEMBER } = await setup();

try {
  await startServer();
  const O = await signIn(OWNER);
  const M = await signIn(MEMBER);
  const me = (await ws("/me", undefined, O)).json.me;
  const mm = (await ws("/me", undefined, M)).json.me;
  const ppl = (await ws("/people", undefined, O)).json.people as { id: string; name: string }[];
  memberFirst = ppl.find((p) => p.id === mm.id)!.name.split(" ")[0];
  await ws("/calendar/ai/prefs", {}, O); // defaults: 09:30-18:30 Mon-Sat, lunch 13-14
  await ws("/calendar/ai/prefs", {}, M);
  const del = (id?: string, c = O) => id && cleanup.push(() => ws(`/calendar/events/${id}`, undefined, c, "DELETE"));
  const count = async () => ((await ws(`/calendar?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 20 * 86_400_000).toISOString()}&sync=0`, undefined, O)).json.events as unknown[]).length;

  // ── 1. Quick add
  const before = await count();
  const q1 = (await ws("/calendar/ai/quick", { text: `Review with ${memberFirst} Friday 3pm for 45 min at Pune office, add a Meet link` }, O)).json;
  const haiku = seen.find((r) => r.system?.includes("You read one short calendar request"));
  check("quick add: parsed with claude-haiku-5-5, max_tokens 2000, JSON schema output", haiku?.model === "claude-haiku-5-5" && haiku?.max_tokens === 2000 && haiku?.output_config?.format?.type === "json_schema");
  check("quick add: the prompt carries today, the next two weeks and the time zone", !!haiku?.system?.includes(TZ) && /\(tomorrow\)/.test(haiku?.system ?? ""));
  const d1 = q1.draft;
  check("quick add: a draft event comes back", q1.kind === "event" && d1?.title === "Review", q1);
  check("quick add: Friday 3:00 pm in the person's zone, 45 minutes", wd(istDay(d1.start)) === 5 && istHM(d1.start) === "15:00" && Date.parse(d1.end) - Date.parse(d1.start) === 45 * 60_000, [d1.start, d1.end]);
  check("quick add: the named person is matched from the directory", d1.attendees.length === 1 && d1.attendees[0].userId === mm.id);
  check("quick add: place and video request kept; the time was given, not guessed", d1.location === "Pune office" && d1.video === true && d1.timeSource === "given");
  check("quick add: nothing is saved until confirmed", (await count()) === before);
  const made = await ws("/calendar/ai/apply", { action: { kind: "create", summary: "x", input: { title: d1.title, start: d1.start, end: d1.end, location: d1.location, attendees: d1.attendees.map((a: { userId: string }) => ({ userId: a.userId })) } } }, O);
  del(made.json.event?.id);
  check("quick add: one click creates it with the guest invited", made.status === 201 && (await ws(`/calendar/events/${made.json.event?.id}`, undefined, M)).status === 200);

  const q2 = (await ws("/calendar/ai/quick", { text: "Sync with Ghost Person tomorrow 11am" }, O)).json;
  check("quick add: never invents people (unknown name reported, not added)", q2.kind === "event" && q2.draft.attendees.length === 0 && q2.notes.some((n: string) => n.includes("Ghost Person")));
  const q3 = (await ws("/calendar/ai/quick", { text: "Standup every Monday 10am" }, O)).json;
  check("quick add: “every Monday 10am” repeats weekly on Mondays from the next Monday", q3.draft?.rrule === "FREQ=WEEKLY;BYDAY=MO" && wd(istDay(q3.draft.start)) === 1 && istHM(q3.draft.start) === "10:00", q3.draft);
  const q4 = (await ws("/calendar/ai/quick", { text: "Call with the supplier on Wednesday" }, O)).json;
  const hm4 = q4.draft ? istHM(q4.draft.start) : "";
  check("quick add: no time given -> a free time suggested and labelled as a suggestion", q4.draft?.timeSource === "suggested" && hm4 >= "09:30" && hm4 < "18:30" && q4.notes.some((n: string) => /suggested/i.test(n)), q4);
  check("quick add: not a calendar request -> unclear, no draft", (await ws("/calendar/ai/quick", { text: "what's the weather" }, O)).json.kind === "unclear");

  // ── 2. Best time for several people
  const mon = nextWeekday(1, 3), sat = (() => { for (let i = 0; i < 7; i++) { const d = new Date(`${mon}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); const k = d.toISOString().slice(0, 10); if (wd(k) === 6) return k; } return mon; })();
  const busyM = await ws("/calendar/events", { title: `${tag} Member busy`, start: at(mon, "09:30"), end: at(mon, "12:30") }, M);
  del(busyM.json.event?.id, M);
  const busyO = await ws("/calendar/events", { title: `${tag} My busy`, start: at(mon, "14:00"), end: at(mon, "18:30") }, O);
  del(busyO.json.event?.id);
  const s1 = (await ws("/calendar/ai/quick", { text: `Find the best time for me and ${memberFirst} next week, 1 hour RANGE=${mon} ${sat}` }, O)).json;
  const slots = (s1.slots ?? []) as { start: string; end: string; reason: string }[];
  check("best time: 3 slots with a reason each", s1.kind === "slots" && slots.length === 3 && slots.every((x) => x.reason.length > 5), s1);
  check("best time: never over anyone's meetings", slots.every((x) => !(Date.parse(x.start) < Date.parse(at(mon, "12:30")) && Date.parse(x.end) > Date.parse(at(mon, "09:30"))) && !(Date.parse(x.start) < Date.parse(at(mon, "18:30")) && Date.parse(x.end) > Date.parse(at(mon, "14:00")))));
  check("best time: inside working hours (09:30-18:30), never over lunch, never on Sunday", slots.every((x) => istHM(x.start) >= "09:30" && istHM(x.end) <= "18:30" && !(istHM(x.start) < "14:00" && istHM(x.end) > "13:00") && wd(istDay(x.start)) !== 0), slots.map((x) => x.start));
  check("best time: 1 hour each, spread over different days", slots.every((x) => Date.parse(x.end) - Date.parse(x.start) === 3_600_000) && new Set(slots.map((x) => istDay(x.start))).size === 3);
  const booked = await ws("/calendar/ai/apply", { action: { kind: "create", summary: "x", input: { title: "Planning", start: slots[0].start, end: slots[0].end, attendees: [{ userId: mm.id }] } } }, O);
  del(booked.json.event?.id);
  check("best time: booked in one click, guest invited", booked.status === 201 && (await ws(`/calendar/events/${booked.json.event?.id}`, undefined, M)).status === 200);

  // Working hours are per person
  await ws("/calendar/ai/prefs", { start: "11:00", end: "16:00", days: [1, 2, 3, 4, 5], lunchStart: "13:00", lunchEnd: "13:30", buffer: 10 }, M);
  const prefs = (await ws("/calendar/ai/prefs", undefined, M)).json.hours;
  check("working hours: saved per person", prefs.start === "11:00" && prefs.end === "16:00" && prefs.days.length === 5);
  const s2 = (await ws("/calendar/ai/quick", { text: `Find the best time for me and ${memberFirst} next week, 1 hour RANGE=${mon} ${sat}` }, O)).json;
  check("working hours: slots respect the guest's shorter day and days off", (s2.slots as { start: string; end: string }[]).every((x) => istHM(x.start) >= "11:00" && istHM(x.end) <= "16:00" && wd(istDay(x.start)) !== 6), s2.slots);
  check("working hours: bad values fall back to defaults", (await ws("/calendar/ai/prefs", { start: "25:99", end: "nope", days: [] }, M)).json.hours.start === "09:30");
  await ws("/calendar/ai/prefs", {}, M);

  // ── 3. Ask Calendar
  const dsDate = istDate(2);
  const ds = await ws("/calendar/events", { title: `${tag} Design sync`, start: at(dsDate, "15:00"), end: at(dsDate, "15:30") }, O);
  del(ds.json.event?.id);
  const a1 = (await ws("/calendar/ai/ask", { question: "Move my design sync to tomorrow morning", history: [] }, O)).json;
  const sonnet = seen.filter((r) => r.tools?.length);
  check("ask: tool use with claude-sonnet-5-5 and the five calendar tools", sonnet.every((r) => r.model === "claude-sonnet-5-5") && ["list_events", "find_free_time", "create_event", "update_event", "delete_event"].every((n) => sonnet[0]?.tools?.some((t) => t.name === n)));
  const act = a1.actions?.[0];
  check("ask: “move” comes back as a draft change to that event", act?.kind === "update" && act.eventId === ds.json.event?.id && istHM(act.input.start) === "10:00" && istDay(act.input.start) === istDate(1), a1);
  check("ask: the answer says what was looked at", a1.looked?.some((l: { kind: string }) => l.kind === "list") && typeof a1.answer === "string");
  const still = (await ws(`/calendar/events/${ds.json.event?.id}`, undefined, O)).json.event;
  check("ask: nothing changes before the confirm click", istHM(still.start) === "15:00");
  check("ask: confirm applies it", (await ws("/calendar/ai/apply", { action: act }, O)).status === 200 && istHM((await ws(`/calendar/events/${ds.json.event?.id}`, undefined, O)).json.event.start) === "10:00");
  const a2 = (await ws("/calendar/ai/ask", { question: "Cancel the design sync", history: [{ role: "user", text: "Move my design sync" }, { role: "assistant", text: "Done" }] }, O)).json;
  check("ask: “cancel” is a draft delete; the event stays until confirmed", a2.actions?.[0]?.kind === "delete" && (await ws(`/calendar/events/${ds.json.event?.id}`, undefined, O)).status === 200);
  const a3 = (await ws("/calendar/ai/ask", { question: "Invite Ghost Person to lunch tomorrow", history: [] }, O)).json;
  check("ask: an unknown person is refused by the tool; no draft is made", (a3.actions ?? []).length === 0 && /Ghost/.test(a3.answer));
  const a4 = (await ws("/calendar/ai/ask", { question: "What does my week look like?", history: [] }, O)).json;
  check("ask: questions are answered from the real calendar", /You have \d+ events/.test(a4.answer) && (a4.actions ?? []).length === 0);
  check("ask: an empty question is refused", (await ws("/calendar/ai/ask", { question: " " }, O)).status === 400);

  // ── 4 + 5. Daily brief, conflicts, overload
  const bd = nextWeekday(2, 2); // a Tuesday
  const e1 = await ws("/calendar/events", { title: `${tag} Budget call`, start: at(bd, "15:00"), end: at(bd, "16:00") }, O);
  const e2 = await ws("/calendar/events", { title: `${tag} Vendor demo`, start: at(bd, "15:30"), end: at(bd, "16:30"), attendees: [{ userId: mm.id }] }, O);
  const e3 = await ws("/calendar/events", { title: `${tag} Late call`, start: at(bd, "20:00"), end: at(bd, "21:00") }, O);
  for (const e of [e1, e2, e3]) del(e.json.event?.id);
  const proj = await ws("/tasks/projects", { name: `${tag} Project`, memberIds: [mm.id] }, O);
  cleanup.push(() => ws(`/tasks/projects/${proj.json.project?.id}`, { archived: true }, O, "PATCH"));
  const t1 = await ws("/tasks", { projectId: proj.json.project?.id, title: `${tag} Zephyr pricing sheet`, due: bd, assigneeId: me.id, priority: 3 }, O);
  const t2 = await ws("/tasks", { projectId: proj.json.project?.id, title: `${tag} Write release notes`, due: bd, assigneeId: me.id, priority: 1 }, O);
  const b = (await ws(`/calendar/ai/brief?date=${bd}`, undefined, O)).json;
  const conflict = (b.issues as { kind: string; eventIds: string[]; fix?: { start: string; end: string; eventId: string } }[]).find((i) => i.kind === "conflict");
  check("brief: today's agenda", b.events?.length >= 3 && b.events.some((e: { title: string }) => e.title === `${tag} Budget call`));
  check("brief: the double-booking is flagged", !!conflict && conflict.eventIds.includes(e1.json.event?.id) && conflict.eventIds.includes(e2.json.event?.id));
  check("brief: a fix is suggested in free time", !!conflict?.fix && !(Date.parse(conflict.fix.start) < Date.parse(at(bd, "16:00")) && Date.parse(conflict.fix.end) > Date.parse(at(bd, "15:00"))));
  check("brief: a meeting outside working hours is flagged", b.issues.some((i: { kind: string; eventIds: string[] }) => i.kind === "outside" && i.eventIds.includes(e3.json.event?.id)));
  check("brief: free gaps and focus suggestions", b.gaps.length > 0 && b.focus.length > 0 && b.focus.every((g: { minutes: number }) => g.minutes >= 90));
  check("brief: tasks due that day (from Tasks)", (b.tasks as { id: string }[]).some((x) => x.id === t1.json.task?.id));
  check("brief: prep notes per meeting", (b.prep as { id: string; notes: string[] }[]).some((p) => p.id === e2.json.event?.id && p.notes.some((n) => /guest/.test(n)) && p.notes.includes("No agenda yet")));
  const hl = (await ws(`/calendar/ai/brief?date=${bd}`, {}, O)).json;
  check("brief: AI headline", hl.headline === "Mock headline: one clash at 3 pm.");
  const ins = (await ws(`/calendar/ai/insights?from=${istDate(0)}&to=${istDate(13)}`, undefined, O)).json;
  check("insights: the range's issues for the toolbar", ins.issues.some((i: { kind: string; date: string }) => i.kind === "conflict" && i.date === bd));
  const fixed = await ws("/calendar/ai/apply", { action: { kind: "update", summary: "fix", eventId: conflict!.fix!.eventId, occ: null, scope: "all", input: { start: conflict!.fix!.start, end: conflict!.fix!.end } } }, O);
  const b2 = (await ws(`/calendar/ai/brief?date=${bd}`, undefined, O)).json;
  check("brief: applying the fix clears the conflict", fixed.status === 200 && !b2.issues.some((i: { kind: string }) => i.kind === "conflict"));

  // Back-to-back and overload
  const bb = nextWeekday(4, 2);
  for (const [s, e] of [["10:00", "11:00"], ["11:00", "12:00"], ["12:00", "13:00"], ["14:00", "16:00"], ["16:00", "17:30"]]) del((await ws("/calendar/events", { title: `${tag} Block ${s}`, start: at(bb, s), end: at(bb, e) }, O)).json.event?.id);
  const ib = (await ws(`/calendar/ai/insights?from=${bb}&to=${bb}`, undefined, O)).json.issues as { kind: string }[];
  check("insights: back-to-back runs and overloaded days are flagged", ib.some((i) => i.kind === "backtoback") && ib.some((i) => i.kind === "overload"), ib.map((i) => i.kind));

  // ── 6. Meeting prep
  const zp = await ws("/calendar/events", { title: `${tag} Zephyr pricing review`, start: at(bd, "11:00"), end: at(bd, "11:30"), attendees: [{ userId: mm.id }] }, O);
  del(zp.json.event?.id);
  const boxId = `${tag}-box`;
  await db.query(`INSERT INTO mailboxes (id, "workspaceId", "ownerId", email, "imapHost", "smtpHost", username, secret, status, "createdById", "updatedAt") VALUES ($1,$2,$3,$4,'imap.test','smtp.test',$4,'{}'::jsonb,'ok',$3,now())`, [boxId, wsId, me.id, `${tag.toLowerCase()}@iotx.test`]);
  cleanup.push(() => db.query("DELETE FROM mailboxes WHERE id = $1", [boxId]));
  await db.query(`INSERT INTO mail_messages (id, "mailboxId", folder, uid, "fromAddr", "to", subject, snippet, date) VALUES ($1,$2,'INBOX',1,'client@zephyr.test','[]'::jsonb,$3,'Revised numbers attached', now())`, [`${tag}-mail`, boxId, `${tag} Zephyr pricing v2`]);
  const pr = (await ws("/calendar/ai/prep", { eventId: zp.json.event?.id }, O)).json;
  check("prep: guests with their replies", pr.attendees?.length === 1 && pr.attendees[0].response === "needs");
  check("prep: related tasks from Tasks", pr.tasks?.some((x: { id: string }) => x.id === t1.json.task?.id), pr.tasks);
  check("prep: related emails from the person's Mail", pr.mail === "ok" && pr.emails?.some((m: { subject: string }) => m.subject === `${tag} Zephyr pricing v2`), pr.emails);
  check("prep: a 3-bullet briefing built from those facts", pr.bullets?.length === 3 && pr.bullets[1].includes("Zephyr pricing v2"));
  check("prep: an event the person can't see -> 404", (await ws("/calendar/ai/prep", { eventId: "nope" }, O)).status === 404);
  // Company knowledge base (the suite's Read app): a matching article joins the prep facts and comes back as a link.
  const kbDoc = (await L.suite("/api/kb", { title: `${tag} Zephyr pricing policy`, kind: "pricing", body: `# Zephyr
Zephyr gets list price minus 4 percent, 30 days credit. ${tag}` })).json.doc;
  cleanup.push(() => L.suite(`/api/kb/${kbDoc?.id}`, undefined, OWNER, "DELETE"));
  const pk = (await ws("/calendar/ai/prep", { eventId: zp.json.event?.id }, O)).json;
  check("prep: matching company knowledge is listed with a link", pk.knowledge?.some((k: { title: string; href: string }) => k.title === `${tag} Zephyr pricing policy` && k.href === `/knowledge?doc=${kbDoc?.id}`), pk.knowledge);
  check("prep: …and given to the AI first, as numbered company knowledge", seen.some((r) => r.system?.includes("prepare a busy person") && r.system.includes("Company knowledge (the platform searched") && r.system.includes("minus 4 percent")));
  // Knowledge first in Ask Calendar: the question is looked up before the model sees it, and the tool stays for more.
  const seenBefore = seen.length;
  const ak = (await ws("/calendar/ai/ask", { question: `What credit terms does Zephyr get on pricing? ${tag}`, history: [] }, O)).json;
  const askReq = seen.slice(seenBefore).find((r) => r.tools?.length);
  check("ask: the question is looked up in company knowledge before the model acts", !!askReq?.system?.includes("Company knowledge (the platform searched") && askReq.system.includes("minus 4 percent") && askReq.system.includes("call search_company_knowledge"), askReq?.system?.slice(-800));
  check("ask: …the knowledge tool is still offered", !!askReq?.tools?.some((t) => t.name === "search_company_knowledge"));
  check("ask: …and the answer says the knowledge base was checked first", ak.looked?.[0]?.kind === "knowledge" && /checked first: \d+ found/.test(ak.looked[0].detail), ak.looked);
  const qa = seen.find((r) => r.system?.includes("You read one short calendar request"));
  check("quick add: company knowledge was checked before parsing (a match, or a line saying none matched)", !!qa?.system?.includes("Company knowledge"));
  check("brief: the headline writer got the knowledge-first block", seen.some((r) => r.system?.includes("headline") && r.system.includes("Company knowledge")));

  // ── 7. Plan my day
  const pl = (await ws("/calendar/ai/plan", { date: bd }, O)).json;
  const blocks = (pl.blocks ?? []) as { taskId: string; start: string; end: string; title: string }[];
  const evsBd = (await ws(`/calendar?from=${at(bd, "00:00")}&to=${at(bd, "23:59")}&sync=0`, undefined, O)).json.events as { start: string; end: string; allDay: boolean }[];
  check("plan: open tasks placed as tentative focus blocks", blocks.length === 2 && blocks.some((x) => x.taskId === t1.json.task?.id), pl);
  check("plan: blocks sit in free working time, clear of meetings and lunch", blocks.every((x) => istHM(x.start) >= "09:30" && istHM(x.end) <= "18:30" && !(istHM(x.start) < "14:00" && istHM(x.end) > "13:00") && !evsBd.some((e) => !e.allDay && Date.parse(e.start) < Date.parse(x.end) && Date.parse(e.end) > Date.parse(x.start))), blocks);
  check("plan: planned with claude-sonnet-5-5", seen.some((r) => r.system?.includes("You plan focus time") && r.model === "claude-sonnet-5-5"));
  check("plan: the tasks were looked up in company knowledge first", seen.some((r) => r.system?.includes("You plan focus time") && r.system.includes("minus 4 percent")));
  check("plan: nothing saved until accepted", evsBd.every((e) => !(e as { title?: string }).title?.startsWith("Focus:")));
  const acc = await ws("/calendar/ai/apply", { action: { kind: "create", summary: "x", input: { title: `Focus: ${blocks[0].title}`, start: blocks[0].start, end: blocks[0].end } } }, O);
  del(acc.json.event?.id);
  check("plan: accepting a block adds it to the calendar", acc.status === 201);
  void t2;

  // ── Permissions
  await setMemberPerm({ "calendar.create": false });
  await sleep(300);
  const M2 = await signIn(MEMBER);
  check("permissions: without “Create events” quick add is refused", (await ws("/calendar/ai/quick", { text: "Review Friday 3pm" }, M2)).status === 403);
  check("permissions: …and so is applying a create draft", (await ws("/calendar/ai/apply", { action: { kind: "create", summary: "x", input: { title: "x", start: at(bd, "10:00"), end: at(bd, "11:00") } } }, M2)).status === 403);
  await resetMember();
  check("permissions: AI endpoints need a session", (await ws("/calendar/ai/brief")).status === 401 && (await ws("/calendar/ai/ask", { question: "hi" })).status === 401);
  check("apply: an unknown action is refused", (await ws("/calendar/ai/apply", { action: { kind: "drop-table" } }, O)).status === 400);
  check("all Haiku calls used max_tokens 2000", seen.filter((r) => r.model === "claude-haiku-5-5").every((r) => r.max_tokens === 2000));
} finally {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  stopServer();
  mock.close();
}

// ── LIVE smoke test against the real Claude API (normal server on :3100) ──
if (process.env.LIVE !== "0") {
  const LIVE = "http://localhost:3100/workspace";
  const call = async (p: string, body: unknown, cookie: string) => {
    const r = await fetch(`${LIVE}/api${p}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const O = await signIn(OWNER, 3100);
  const t0 = Date.now();
  const live = await call("/calendar/ai/quick", { text: `Review with ${memberFirst} Friday 3pm for 45 min at Pune office` }, O);
  const d = live.json.draft;
  check(`LIVE quick add (Claude Haiku 5.5, ${Date.now() - t0} ms): Friday 15:00 for 45 min with ${memberFirst}`, live.status === 200 && live.json.kind === "event" && wd(istDay(d.start)) === 5 && istHM(d.start) === "15:00" && Date.parse(d.end) - Date.parse(d.start) === 45 * 60_000 && d.attendees.some((a: { name: string }) => a.name.startsWith(memberFirst)), live.json);
  const t1 = Date.now();
  const ask = await call("/calendar/ai/ask", { question: "When am I free tomorrow afternoon?", history: [] }, O);
  check(`LIVE Ask Calendar (Claude Sonnet 5.5 + tools, ${Date.now() - t1} ms): answers from the calendar`, ask.status === 200 && typeof ask.json.answer === "string" && ask.json.answer.length > 10 && ask.json.looked?.length > 0, ask.json);
}
await db.end();
process.exit(summary("calendar AI") ? 1 : 0);
