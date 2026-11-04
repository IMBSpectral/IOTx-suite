/**
 * IOTx Workspace — Meet reports (Read AI parity, helper A): speaker numbers,
 * report shape, upload -> diarized transcript -> report (synthesized speech
 * from two voices), the in-person recorder's chunk upload and finish,
 * templates, translation, "Ask this meeting", reports from live captions,
 * and who may read a report.
 *   npx tsx scripts/test-meet-report.mts <devToken> <test-users.json>
 * Real AI calls: ~3 transcriptions (OpenAI) and ~6 Claude calls. SKIP_LIVE_AI=1 runs only the offline checks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { check, envOf, OUTSIDER, OWNER, setup, signIn, sleep, summary, ws, WS } from "./lib.mts";

const root = path.join(import.meta.dirname, "..");
const env = envOf(path.join(root, ".env"));
for (const k of ["DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) if (env[k] && !process.env[k]) process.env[k] = env[k];
const R = await import(new URL("../src/lib/meet/report.ts", import.meta.url).href);
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
const live = !process.env.SKIP_LIVE_AI && !!env.OPENAI_API_KEY && !!env.ANTHROPIC_API_KEY;
const tmp = path.join(root, "storage", "meet-tmp", `test-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const codes: string[] = [];

// ── 1. Speaker numbers (pure) ──────────────────────────────────────────────
{
  const segs = [
    { start: 0, end: 10, speaker: "Asha", text: "Um, so, like, we should ship. You know, it's basically done. Can we ship on Friday?" },
    { start: 10.5, end: 16, speaker: "Asha", text: "I mean it is ready. I like the plan. Uh, what kind of risk is left?" },
    { start: 15.5, end: 25.5, speaker: "Ravi", text: "Yes. Hey guys, the whitelist is fine and the manpower is there. Literally nothing is left." },
  ];
  const st = R.speakerStats(segs);
  const asha = st.find((s: any) => s.name === "Asha"), ravi = st.find((s: any) => s.name === "Ravi");
  check("stats: one row per speaker, most talk first", st.length === 2 && st[0].name === "Asha", st);
  check("stats: talk seconds add up per speaker", asha.talkSec === 15.5 && ravi.talkSec === 10, st);
  check("stats: words counted", asha.words === 32 && ravi.words === 16, { a: asha.words, r: ravi.words });
  check("stats: words per minute", asha.wpm === Math.round((32 / (15.5 / 60)) * 10) / 10, asha.wpm);
  check("stats: fillers (um, like as a filler, you know, basically, uh) but not 'I like', 'what kind of' or 'I mean it'", asha.fillers === 5, asha.fillers);
  check("stats: questions are sentences ending in ?", asha.questions === 2 && ravi.questions === 0);
  check("stats: non-inclusive terms (guys, whitelist, manpower)", ravi.nonInclusive === 3 && asha.nonInclusive === 0, ravi.nonInclusive);
  check("stats: 'literally' is a filler", ravi.fillers === 1, ravi.fillers);
  check("stats: longest monologue joins one speaker's back-to-back segments", asha.longestMonologueSec === 16 && ravi.longestMonologueSec === 10, st);
  check("stats: empty input", R.speakerStats([]).length === 0);
  check("filler list holds the agreed words", ["um", "uh", "like", "you know", "I mean", "sort of", "kind of", "basically", "actually", "literally"].every((w) => R.FILLERS.some((f: any) => f.name === w)));
  check("'sort of' after 'a' isn't a filler; on its own it is", R.fillerCount("It is a sort of tool.") === 0 && R.fillerCount("It's sort of done.") === 1);
  const eng = R.engagementOf(segs, 0, 26);
  check("engagement: two people trading turns with questions scores well", eng >= 40 && eng <= 100, eng);
  check("engagement: one person alone scores low", R.engagementOf([{ start: 0, end: 60, speaker: "A", text: "Long talk." }], 0, 60) < 20);
  check("engagement: silence is 0", R.engagementOf(segs, 100, 160) === 0);
  check("read score: weights and clamping", R.readScore({ sentiment: 100, engagement: 100, agenda: true, decisions: 3, actionItems: 3, onTime: 100 }) === 100 && R.readScore({ sentiment: 0, engagement: 0, agenda: false, decisions: 0, actionItems: 0, onTime: null }) === 0);
  check("read score: unknown start time is left out, not counted as late", R.readScore({ sentiment: 50, engagement: 50, agenda: true, decisions: 2, actionItems: 2, onTime: null }) === Math.round((0.35 * 50 + 0.35 * 50 + 20) / 0.9));
  const t0 = new Date("2026-10-29T10:00:00Z");
  check("on time: up to 2 min late is full, 15+ is 0", R.onTimeScore(t0, new Date(t0.getTime() + 60_000)) === 100 && R.onTimeScore(t0, new Date(t0.getTime() + 20 * 60_000)) === 0 && R.onTimeScore(null, t0) === null);
  const w = R.timelineWindows(3600);
  check("timeline: about a minute a window, about 60 at most", w.step === 60 && w.starts.length === 60 && R.timelineWindows(40).starts.length === 4);
}

// ── 2. Report shape (pure) ─────────────────────────────────────────────────
{
  const v = R.validateReport(
    {
      summary: "  ok  ", chapters: [{ title: "B", start: 90, end: 10 }, { title: "A", start: 5, end: "20" }, { title: "" }], scores: { read: 140, sentiment: -5, engagement: "62.4" },
      actionItems: [{ title: "Send notes", owner: "Priya", due: "Thursday", start: -1 }, { title: "" }], keyQuestions: [{ question: "Ship?", answered: "true", start: "8" }],
      decisions: ["Launch Friday", { text: "Keep budget" }, ""], topics: ["Launch", "Launch", "Budget"], highlights: [{ start: 3, text: "Ship it" }], sections: [{ title: "Next steps", body: 3 }], timeline: [{ start: 30, sentiment: 200 }, { start: 0, sentiment: 40, engagement: 50 }],
      extra: "dropped",
    },
    { template: "sales", language: "English", durationSec: 60 },
  );
  check("shape: version 2 with every field", v.version === 2 && ["template", "language", "summary", "chapters", "actionItems", "keyQuestions", "decisions", "topics", "highlights", "sections", "scores", "timeline"].every((k) => k in v) && !("extra" in v), Object.keys(v));
  check("shape: scores clamped to 0–100 and rounded", v.scores.read === 100 && v.scores.sentiment === 0 && v.scores.engagement === 62);
  check("shape: times clamped to the length, end never before start, sorted", v.chapters.length === 2 && v.chapters[0].title === "A" && v.chapters[1].start === 60 && v.chapters[1].end === 60, v.chapters);
  check("shape: bad due date dropped, -1 time becomes null, empty items dropped", v.actionItems.length === 1 && v.actionItems[0].due === "" && v.actionItems[0].start === null);
  check("shape: answered/start repaired from strings", v.keyQuestions[0].answered === true && v.keyQuestions[0].start === 8);
  check("shape: decisions repaired, topics de-duplicated", v.decisions.length === 2 && v.topics.length === 2);
  check("shape: highlight without end gets one", v.highlights[0].end > v.highlights[0].start);
  check("shape: section body coerced to text; timeline sorted and clamped", v.sections[0].body === "3" && v.timeline[0].start === 0 && v.timeline[1].sentiment === 100);
  check("shape: template and language from context", v.template === "sales" && v.language === "English");
  check("shape: garbage in gives an empty valid report", R.validateReport(null).version === 2 && R.validateReport("x").chapters.length === 0 && R.validateReport(undefined).scores.read === 50);
  check("vocab: near-misses respelled, other words untouched", R.applyVocab("the Zephyriax plan by Pria and price", ["Zephyrix", "Priya"]) === "the Zephyrix plan by Priya and price");
  check("vocab: long names heard with another ending", R.applyVocab("the Zephyreeks launch", ["Zephyrix"]) === "the Zephyrix launch" && R.applyVocab("a zebra crossing", ["Zephyrix"]) === "a zebra crossing");
  check("vocab: possessives keep their 's", R.applyVocab("the Zephyrec's plan", ["Zephyrix"]) === "the Zephyrix's plan");
  check("vocab: no terms leaves text alone", R.applyVocab("Hello there", []) === "Hello there");
  const merged = R.mergeSegments([{ start: 0, end: 1, speaker: "A", text: "Good" }, { start: 1.5, end: 2, speaker: "A", text: "morning." }, { start: 2.1, end: 3, speaker: "B", text: "Hi" }]);
  check("merge: one speaker's phrases join into a line", merged.length === 2 && merged[0].text === "Good morning." && merged[0].end === 2);
  const base = new Date("2026-10-29T10:00:00Z");
  const caps = R.captionSegments([{ identity: "u_1", name: "Asha", text: "one two three four five", at: new Date(base.getTime() + 12_000) }, { identity: "u_2", name: "Ravi", text: "hi", at: new Date(base.getTime() + 5_000) }], base);
  check("captions: timed from the meeting start, sorted, start before end", caps[0].speaker === "Ravi" && caps[1].end === 12 && caps[1].start === 10 && caps[1].identity === "u_1", caps);
  const named = R.nameFromCaptions([{ start: 9, end: 12, speaker: "Speaker A", text: "x" }, { start: 3, end: 5, speaker: "Speaker B", text: "y" }], caps);
  check("captions name diarized speakers", named[0].speaker === "Asha" && named[1].speaker === "Ravi", named);
  check("ask: [t=…] citations parsed", JSON.stringify(R.citationsOf("Friday [t=12] and [t=30.5].")) === "[12,30.5]");
}

// ── 3. ffmpeg: transcode and split with offsets ────────────────────────────
const wav = path.join(tmp, "two.wav");
execFileSync("powershell.exe", ["-NoProfile", "-Command", [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$v = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }",
  "$v1 = ($v | Where-Object { $_ -match 'David' } | Select-Object -First 1); if (-not $v1) { $v1 = $v[0] }",
  "$v2 = ($v | Where-Object { $_ -match 'Zira' } | Select-Object -First 1); if (-not $v2) { $v2 = $v[-1] }",
  "$p = New-Object System.Speech.Synthesis.PromptBuilder",
  "$p.StartVoice($v1); $p.AppendText('Good morning everyone. Um, lets review the Zephyrix launch plan. The agenda is the budget and the release date. Can we ship by Friday?'); $p.EndVoice()",
  "$p.AppendBreak([TimeSpan]::FromMilliseconds(700))",
  "$p.StartVoice($v2); $p.AppendText('Yes, I think we can ship by Friday. Basically the build is ready. The budget is fifty thousand dollars and we decided to keep it.'); $p.EndVoice()",
  "$p.AppendBreak([TimeSpan]::FromMilliseconds(700))",
  "$p.StartVoice($v1); $p.AppendText('Great. So the decision is to launch on Friday. Priya will send the release notes by Thursday. Who will update the pricing page?'); $p.EndVoice()",
  "$p.AppendBreak([TimeSpan]::FromMilliseconds(700))",
  "$p.StartVoice($v2); $p.AppendText('I will update the pricing page tomorrow. You know, the customers are really excited about this release. Thank you all.'); $p.EndVoice()",
  `$s.SetOutputToWaveFile('${wav}'); $s.Speak($p); $s.Dispose()`,
].join("; ")]);
check("speech sample from two voices", fs.existsSync(wav) && fs.statSync(wav).size > 100_000);
check("ffmpeg-static is installed", !!R.ffmpegPath());
const dur = await R.mediaDuration(wav);
check("media length read with ffmpeg", dur !== null && dur > 25 && dur < 80, dur);
const parts = await R.splitAudio(wav, path.join(tmp, "split"), 15);
check("long files: split into chunks (15 s here, 10 min in use)", parts.length >= 2, parts.length);
check("chunks are 16 kHz mono Opus, far under 25 MB", parts.every((p: any) => p.path.endsWith(".ogg") && fs.statSync(p.path).size < 25 * 1024 * 1024));
check("chunk offsets add up to the whole length", Math.abs(parts.at(-1).offset + parts.at(-1).duration - dur!) < 1.5 && parts[1].offset > 13 && parts[1].offset < 17, parts.map((p: any) => [p.offset, p.duration]));
// A browser-style WebM for the recorder test.
const webm = path.join(tmp, "rec.webm");
execFileSync(R.ffmpegPath(), ["-hide_banner", "-y", "-i", wav, "-c:a", "libopus", "-b:a", "32k", webm], { stdio: "ignore" });

// ── Sign in ────────────────────────────────────────────────────────────────
const { MEMBER } = await setup();
const O = await signIn(OWNER, "meetings");
const M = await signIn(MEMBER, "meetings");
const X = await signIn(OUTSIDER, "meetings").catch(() => "");
const member = (await ws("/me", undefined, M)).json.me;
const memberEmail = (await db.query(`select email from users where id=$1`, [member.id]).catch(() => ({ rows: [{ email: "member@localhost" }] }))).rows[0]?.email ?? "member@localhost";

/** JSON with keys sorted (Postgres jsonb doesn't keep key order). */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
async function raw(p: string, init: RequestInit & { cookie?: string }) {
  const r = await fetch(`${WS}/api${p}`, { ...init, headers: { ...(init.headers as Record<string, string>), ...(init.cookie ? { cookie: init.cookie } : {}) } });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any, headers: r.headers };
}
async function waitReport(code: string, cookie = O, ms = 300_000) {
  const until = Date.now() + ms;
  let d: any = {};
  while (Date.now() < until) {
    d = (await ws(`/meet/${code}/report`, undefined, cookie)).json;
    if ((d.status === "ready" && !d.building) || d.status === "failed") return d;
    await sleep(3000);
  }
  return d;
}

// ── Templates and vocabulary ───────────────────────────────────────────────
const tl = await ws("/meet/templates", undefined, O);
check("templates: the six built-ins", ["general", "sales", "interview", "team", "coaching", "one-on-one"].every((id) => tl.json.templates?.some((t: any) => t.id === id && t.builtin && t.sections.length)), tl.json);
check("templates: a name and sections are required", (await ws("/meet/templates", { name: "", sections: [] }, O)).status === 400);
const tc = await ws("/meet/templates", { name: "Launch review", instructions: "A product launch review.", sections: [{ title: "Launch readiness", prompt: "Is it ready?" }, { title: "Risks", prompt: "" }] }, O);
check("templates: a workspace adds its own", tc.status === 201 && tc.json.template?.id, tc.json);
const tplId = tc.json.template?.id;
const xt = X ? await ws("/meet/templates", { name: "Other company", sections: ["a"] }, X) : null;
check("templates: another workspace's templates stay there", !xt || ((await ws("/meet/templates", undefined, O)).json.templates.every((t: any) => t.name !== "Other company")));
if (xt?.json.template?.id) await ws(`/meet/templates?id=${xt.json.template.id}`, undefined, X, "DELETE");
check("templates: someone else can't change mine", (await ws("/meet/templates", { id: tplId, name: "Hijack", sections: ["a"] }, M, "PATCH")).status >= 403);
const tp = await ws("/meet/templates", { id: tplId, name: "Launch review", instructions: "A product launch review.", sections: [{ title: "Launch readiness", prompt: "Is it ready to ship?" }, { title: "Risks", prompt: "" }] }, O, "PATCH");
check("templates: edit my own", tp.status === 200 && tp.json.template.sections[0].prompt === "Is it ready to ship?");
const vv = await ws("/meet/vocab", { term: "Zephyrix", note: "Our launch codename" }, O);
check("vocabulary: add a term", vv.status === 201 && vv.json.terms.some((t: any) => t.term === "Zephyrix"));
check("vocabulary: no duplicates", (await ws("/meet/vocab", { term: "zephyrix" }, O)).json.added === 0);
const vocabId = vv.json.terms.find((t: any) => t.term === "Zephyrix")?.id;

// ── Upload: validation and permissions ─────────────────────────────────────
check("upload: not audio or video is refused", (await raw("/meet/upload?title=x&name=a.txt", { method: "POST", body: "hello world".repeat(200), headers: { "content-type": "text/plain" }, cookie: O })).status === 415);
check("upload: an empty file is refused", (await raw("/meet/upload?title=x", { method: "POST", body: new Uint8Array(10), headers: { "content-type": "audio/wav" }, cookie: O })).status === 400);
check("upload: needs sign-in", (await raw("/meet/upload?title=x", { method: "POST", body: new Uint8Array(5000), headers: { "content-type": "audio/wav" } })).status === 401);

if (live) {
  // ── 4. Upload -> transcript -> report (end to end) ───────────────────────
  const up = await raw(`/meet/upload?title=${encodeURIComponent("Zephyrix launch sync")}&name=two.wav&date=2026-10-28T09:00:00.000Z`, { method: "POST", body: fs.readFileSync(wav), headers: { "content-type": "audio/wav" }, cookie: O });
  check("upload: 201 with a meeting code", up.status === 201 && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(up.json.code), up.json);
  const code = up.json.code as string;
  codes.push(code);
  const row = (await db.query(`select * from meetings where code=$1`, [code])).rows[0];
  check("upload: a kind 'upload' meeting with the title and date", row?.kind === "upload" && row.title === "Zephyrix launch sync" && (await ws(`/meet/${code}/report`, undefined, O)).json.startedAt === "2026-10-28T09:00:00.000Z", { kind: row?.kind, title: row?.title, at: row?.startedAt });
  const d = await waitReport(code);
  check("upload: the report is ready", d.status === "ready" && !!d.report, { status: d.status, error: d.error });
  const r = d.report ?? {};
  check("report v2: valid shape", canon(R.validateReport(r, { durationSec: d.durationSec })) === canon(r), r);
  check("report v2: summary, chapters, decisions", r.summary?.length > 40 && r.chapters?.length >= 1 && r.decisions?.length >= 1, r);
  check("report v2: action items with owners (release notes, pricing page)", r.actionItems?.some((a: any) => /release notes/i.test(a.title)) && r.actionItems?.some((a: any) => /pricing/i.test(a.title)), r.actionItems);
  check("report v2: key questions with answered flags and times", r.keyQuestions?.length >= 1 && r.keyQuestions.every((q: any) => typeof q.answered === "boolean"), r.keyQuestions);
  check("report v2: general template sections", r.template === "general" && r.sections?.map((s: any) => s.title).join("|") === "Key takeaways|Next steps", r.sections);
  check("report v2: scores 0–100", ["read", "sentiment", "engagement"].every((k) => r.scores?.[k] >= 0 && r.scores?.[k] <= 100), r.scores);
  check("report v2: a timeline across the recording", r.timeline?.length >= 4 && r.timeline.every((p: any) => p.start <= d.durationSec), r.timeline?.length);
  check("report v2: topics", r.topics?.length >= 1 && r.topics.length <= 8);
  const segs = d.segments as any[];
  check("transcript: timestamped segments in order", segs.length >= 3 && segs.every((s, i) => s.end >= s.start && (i === 0 || s.start >= segs[i - 1].start)), segs.slice(0, 3));
  check("transcript: two speakers told apart (diarized)", new Set(segs.map((s) => s.speaker)).size >= 2, [...new Set(segs.map((s) => s.speaker))]);
  check("transcript: custom vocabulary spelled right", segs.some((s) => /Zephyrix/.test(s.text)), segs.map((s) => s.text).join(" ").slice(0, 300));
  check("duration stored", d.durationSec >= 25 && d.durationSec <= 80, d.durationSec);
  check("speakers: a card per speaker with talk time and pace", d.speakers?.length >= 2 && d.speakers.every((s: any) => s.talkSec > 0 && s.wpm > 0), d.speakers);
  check("speakers: fillers found (um, basically, you know)", d.speakers.reduce((a: number, s: any) => a + s.fillers, 0) >= 2, d.speakers.map((s: any) => s.fillers));
  check("speakers: questions counted", d.speakers.reduce((a: number, s: any) => a + s.questions, 0) >= 2);
  const sp = (await db.query(`select count(*)::int n from meet_speakers where "meetingId"=$1`, [row.id])).rows[0].n;
  check("MeetSpeaker rows written", sp === d.speakers.length);
  check("old notes shape still filled", (await db.query(`select notes from meetings where id=$1`, [row.id])).rows[0].notes?.summary === r.summary);
  check("media: the uploaded file plays with the report", d.media?.length === 1 && d.media[0].kind === "audio" && d.media[0].offset === 0, d.media);
  const rng = await fetch(`${WS}/api/meet/${code}/recordings/${d.media[0].id}`, { headers: { cookie: O, range: "bytes=0-99" } });
  check("media: served with Range (206)", rng.status === 206 && !!rng.headers.get("content-range")?.startsWith("bytes 0-99/") && rng.headers.get("content-type") === "audio/wav", [rng.status, rng.headers.get("content-type")]);
  check("the room link goes to the report", (await fetch(`${WS}/meet/${code}`, { headers: { cookie: O }, redirect: "manual" })).status >= 300);

  // ── 5. Permissions ───────────────────────────────────────────────────────
  check("an outsider can't read the report", (await ws(`/meet/${code}/report`, undefined, X)).status === 404);
  check("a workspace member who wasn't there can't either", (await ws(`/meet/${code}/report`, undefined, M)).status === 404);
  check("…nor ask it, translate it or play it", (await ws(`/meet/${code}/ask`, { question: "When?" }, M)).status === 404 && (await ws(`/meet/${code}/report`, { action: "translate", lang: "French" }, M)).status === 404 && (await fetch(`${WS}/api/meet/${code}/recordings/${d.media[0].id}`, { headers: { cookie: M } })).status === 404);
  check("…nor re-generate it", (await ws(`/meet/${code}/report`, { action: "regenerate" }, X)).status === 404);
  const sh = await ws(`/meet/${code}/report`, { action: "share", emails: [memberEmail, "nobody@nowhere.test"] }, O);
  check("share: the host shares with a member by email", sh.status === 200 && sh.json.shared === 1 && sh.json.missing.includes("nobody@nowhere.test"), sh.json);
  const asM = await ws(`/meet/${code}/report`, undefined, M);
  check("share: now the member can read it, but not change it", asM.status === 200 && asM.json.report && !asM.json.host && (await ws(`/meet/${code}/report`, { action: "regenerate" }, M)).status === 403);
  check("share: still not the outsider", (await ws(`/meet/${code}/report`, undefined, X)).status === 404);

  // ── 6. Ask this meeting ──────────────────────────────────────────────────
  const ask = await ws(`/meet/${code}/ask`, { question: "When will they launch, and who updates the pricing page?" }, O);
  check("ask: answers from the meeting", ask.status === 200 && /friday/i.test(ask.json.answer), ask.json);
  check("ask: with timestamp citations inside the recording", ask.json.citations?.length >= 1 && ask.json.citations.every((t: number) => t >= 0 && t <= d.durationSec + 5), ask.json.citations);
  const off = await ws(`/meet/${code}/ask`, { question: "What is the capital of Australia?" }, O);
  check("ask: says so when the meeting doesn't cover it", off.status === 200 && off.json.found === false, off.json);
  check("ask: a question is required", (await ws(`/meet/${code}/ask`, { question: "" }, O)).status === 400);

  // ── 7. Translation ───────────────────────────────────────────────────────
  check("translate: a language is required", (await ws(`/meet/${code}/report`, { action: "translate", lang: "<script>" }, O)).status === 400);
  const fr = await ws(`/meet/${code}/report`, { action: "translate", lang: "French" }, M);
  check("translate: anyone who can read it gets it in French", fr.status === 200 && fr.json.report.language === "French" && fr.json.report.summary !== r.summary, fr.json.report?.summary?.slice(0, 120));
  check("translate: times, names and scores kept", JSON.stringify(fr.json.report.scores) === JSON.stringify(r.scores) && fr.json.report.chapters.length === r.chapters.length && fr.json.report.chapters[0].start === r.chapters[0].start);
  const gf = await ws(`/meet/${code}/report?lang=French`, undefined, O);
  check("translate: kept per language", gf.json.report?.language === "French" && gf.json.languages.includes("French") && (await ws(`/meet/${code}/report`, undefined, O)).json.report.language !== "French");

  // ── 8. Rename a speaker ──────────────────────────────────────────────────
  const first = segs[0].speaker;
  const rn = await ws(`/meet/${code}/report`, { action: "rename", from: first, to: "Asha" }, O);
  const after = (await ws(`/meet/${code}/report`, undefined, O)).json;
  check("rename: a diarized speaker gets a name everywhere", rn.status === 200 && after.segments.some((s: any) => s.speaker === "Asha") && !after.segments.some((s: any) => s.speaker === first) && after.speakers.some((s: any) => s.name === "Asha"));
  check("rename: hosts only", (await ws(`/meet/${code}/report`, { action: "rename", from: "Asha", to: "Bob" }, M)).status === 403);

  // ── 9. Template change re-generates ──────────────────────────────────────
  const tg = await ws(`/meet/${code}/report`, { action: "template", template: tplId }, O);
  check("template: picking one after the meeting re-writes the report", tg.status === 200 && !tg.json.saved, tg.json);
  check("template: unknown template refused", (await ws(`/meet/${code}/report`, { action: "template", template: "nope" }, O)).status === 400);
  const d2 = await waitReport(code);
  check("template: the new report has the custom sections", d2.status === "ready" && d2.template === tplId && d2.report?.template === tplId && d2.report.sections.map((s: any) => s.title).join("|") === "Launch readiness|Risks", d2.report?.sections);
  check("template: translations cleared when re-made", d2.languages.length === 0);

  // ── 10. In-person recorder ───────────────────────────────────────────────
  const buf = fs.readFileSync(webm);
  const cut = [0, Math.floor(buf.length / 3), Math.floor((2 * buf.length) / 3), buf.length];
  const chunk = (i: number) => buf.subarray(cut[i], cut[i + 1]);
  const st = await ws("/meet/record", { action: "start", title: "Kitchen table chat", mime: "audio/webm" }, O);
  check("recorder: start makes an in-person meeting", st.status === 201 && st.json.id && st.json.next === 0, st.json);
  codes.push(st.json.code);
  const put = (seq: number, body: Uint8Array, cookie = O) => raw(`/meet/record/${st.json.id}?seq=${seq}`, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": "application/octet-stream" }, cookie });
  check("recorder: chunk 0 stored", (await put(0, chunk(0))).json.next === 1);
  const gap = await put(2, chunk(2));
  check("recorder: a gap is refused with the chunk expected next", gap.status === 409 && gap.json.next === 1, gap.json);
  check("recorder: chunk 1 stored", (await put(1, chunk(1))).json.next === 2);
  check("recorder: a repeated chunk is ignored", (await put(1, chunk(1))).json.duplicate === true);
  check("recorder: someone else can't add to my recording", (await put(2, chunk(2), M)).status === 404);
  check("recorder: chunk 2 stored", (await put(2, chunk(2))).json.next === 3);
  const un = await ws("/meet/record", undefined, O);
  check("recorder: listed as unfinished until finished (nothing lost if the tab dies)", un.json.unfinished?.some((u: any) => u.id === st.json.id && u.chunks === 3));
  const up2 = (await db.query(`select * from meet_uploads where id=$1`, [st.json.id])).rows[0];
  check("recorder: chunks appended in order, byte for byte", fs.readFileSync(path.join(root, "storage", "meet-recordings", up2.file)).equals(buf));
  const fin = await ws("/meet/record", { action: "finish", id: st.json.id }, O);
  check("recorder: finish", fin.status === 200 && fin.json.code === st.json.code, fin.json);
  check("recorder: finishing twice is harmless", (await ws("/meet/record", { action: "finish", id: st.json.id }, O)).json.already === true);
  check("recorder: no more chunks after finishing", (await put(3, chunk(2))).status === 409);
  const d3 = await waitReport(st.json.code);
  const row3 = (await db.query(`select * from meetings where code=$1`, [st.json.code])).rows[0];
  check("recorder: a kind 'inperson' meeting with a report", row3.kind === "inperson" && d3.status === "ready" && d3.report?.summary?.length > 20, { kind: row3.kind, status: d3.status, error: d3.error });
  check("recorder: transcript with times", d3.segments.length >= 3 && d3.durationSec > 20, d3.durationSec);
  check("recorder: the recording plays with Range", d3.media?.length === 1 && (await fetch(`${WS}/api/meet/${st.json.code}/recordings/${d3.media[0].id}`, { headers: { cookie: O, range: "bytes=0-9" } })).status === 206);
  const st2 = await ws("/meet/record", { action: "start", title: "Discard me" }, O);
  await raw(`/meet/record/${st2.json.id}?seq=0`, { method: "PUT", body: new Uint8Array(chunk(0)), cookie: O });
  check("recorder: discard removes it", (await ws("/meet/record", { action: "discard", id: st2.json.id }, O)).status === 200 && !(await db.query(`select 1 from meetings where code=$1`, [st2.json.code])).rows.length);
  check("recorder: needs sign-in", (await raw("/meet/record", { method: "POST", body: JSON.stringify({ action: "start" }), headers: { "content-type": "application/json" } })).status === 401);

  // ── 11. A live Meet call: report from its captions ───────────────────────
  const mc = await ws("/meet", { title: "Caption standup", waitingRoom: false }, O);
  const lc = mc.json.meeting.code as string;
  codes.push(lc);
  const lm = (await db.query(`select * from meetings where code=$1`, [lc])).rows[0];
  const t0 = Date.now() - 120_000;
  await db.query(`update meetings set "startedAt"=$2, "endedAt"=$3, template='team' where id=$1`, [lm.id, new Date(t0), new Date(t0 + 90_000)]);
  const lines = [
    ["u_a", "Asha", "Morning all. Quick standup. Yesterday I finished the billing export.", 8],
    ["u_b", "Ravi", "Nice. I am blocked on the staging database, can someone reset it?", 18],
    ["u_a", "Asha", "I will reset staging after this call.", 26],
    ["u_b", "Ravi", "Thanks. Today I will finish the invoice emails by Friday.", 36],
  ] as const;
  for (const [identity, name, text, s] of lines) await db.query(`insert into meet_captions (id, "meetingId", identity, name, text, at) values ($1,$2,$3,$4,$5,$6)`, [crypto.randomUUID(), lm.id, identity, name, text, new Date(t0 + s * 1000)]);
  const fc = await ws(`/meet/${lc}/notes`, { action: "from_captions" }, O);
  check("live call: report from the captions", fc.status === 200, fc.json);
  const d4 = await waitReport(lc);
  check("live call: report ready with the team template chosen before", d4.status === "ready" && d4.report?.template === "team" && d4.report.sections.some((s: any) => s.title === "Blockers"), { status: d4.status, error: d4.error, s: d4.report?.sections });
  check("live call: segments carry caption speakers and times from the start", d4.segments.length === 4 && d4.segments[0].speaker === "Asha" && Math.abs(d4.segments[3].end - 36) < 0.2, d4.segments);
  check("live call: speakers named after the people", d4.speakers.map((s: any) => s.name).sort().join() === "Asha,Ravi");
  check("live call: old notes still served for old screens", (await ws(`/meet/${lc}/notes`, undefined, O)).json.notes?.summary === d4.report.summary);
} else console.log("SKIP live AI (SKIP_LIVE_AI or no OPENAI_API_KEY / ANTHROPIC_API_KEY)");

// ── Clean up ───────────────────────────────────────────────────────────────
for (const c of codes) {
  const m = (await db.query(`select id from meetings where code=$1`, [c])).rows[0];
  if (!m) continue;
  const recs = (await db.query(`select file from meet_recordings where "meetingId"=$1 and kind='upload'`, [m.id])).rows;
  for (const r of recs) fs.rmSync(path.join(root, "storage", "meet-recordings", r.file), { force: true });
  await db.query(`delete from meet_uploads where "meetingId"=$1`, [m.id]);
  await db.query(`delete from meet_report_langs where "meetingId"=$1`, [m.id]);
  await db.query(`delete from meetings where id=$1`, [m.id]);
}
if (tplId) await ws(`/meet/templates?id=${tplId}`, undefined, O, "DELETE");
if (vocabId) await ws(`/meet/vocab?id=${vocabId}`, undefined, O, "DELETE");
fs.rmSync(tmp, { recursive: true, force: true });
await db.end();
process.exit(summary("test-meet-report") ? 1 : 0);
