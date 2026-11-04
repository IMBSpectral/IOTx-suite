import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma, type Meeting, type MeetRecording } from "@prisma/client";
import { db } from "../db";
import { HttpError, type Me } from "../auth";
import { bad } from "../http";
import { notify } from "../notify";
import { companyKnowledge, consultKnowledge } from "../kb";
import { RECORDINGS_DIR, recordingPath } from "./recording";
import { meteredFetch, withAiContext } from "../ai-meter";

/**
 * Read-style meeting reports (version 2, docs/readai-contract.md).
 *
 * A meeting gets a timestamped transcript (MeetSegment rows) from one of:
 *   - an uploaded or in-person recording, or a call the extension captured:
 *     ffmpeg transcodes it to 16 kHz mono Opus in 10-minute chunks, each
 *     chunk goes to OpenAI gpt-4o-transcribe-diarize (speakers + segments) or,
 *     when that model isn't available, whisper-1 verbose_json (segments only),
 *     and the chunk's start is added to its times;
 *   - a live Meet call: the caption lines (speaker and time), or the notes
 *     recording with speakers named from the captions.
 * Then one Claude call writes the report (summary, chapters, action items,
 * key questions, decisions, topics, highlights, template sections and a
 * sentiment reading per window). Engagement and the Read score are computed
 * here from the transcript itself: turn-taking, balance, questions,
 * interruptions, structure and an on-time start. Nothing looks at faces.
 */

export type Seg = { start: number; end: number; speaker: string; identity?: string | null; text: string };

export type Report = {
  version: 2;
  template: string;
  language: string;
  summary: string;
  chapters: { title: string; start: number; end: number; summary: string }[];
  actionItems: { title: string; owner: string; due: string; start: number | null }[];
  keyQuestions: { question: string; askedBy: string; answered: boolean; start: number | null }[];
  decisions: string[];
  topics: string[];
  highlights: { start: number; end: number; text: string; by: string }[];
  sections: { title: string; body: string }[];
  scores: { read: number; sentiment: number; engagement: number };
  timeline: { start: number; sentiment: number; engagement: number }[];
};

export type SpeakerStat = {
  name: string;
  identity: string | null;
  talkSec: number;
  words: number;
  wpm: number;
  fillers: number;
  questions: number;
  nonInclusive: number;
  longestMonologueSec: number;
  firstStart: number;
};

const OPENAI_URL = (process.env.MEET_OPENAI_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const DIARIZE_MODEL = process.env.MEET_DIARIZE_MODEL ?? "gpt-4o-transcribe-diarize";
const REPORT_MODEL = "claude-sonnet-5-5";
const CHUNK_SEC = 600;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TMP_DIR = path.resolve(RECORDINGS_DIR, "..", "meet-tmp");

// ── Speaker numbers (pure) ─────────────────────────────────────────────────

/** Filler words and phrases. "like" counts only as a filler (set off by commas or opening a sentence). */
export const FILLERS: { name: string; re: RegExp }[] = [
  { name: "um", re: /\b(?:u+m+|u+h+m+|e+r+m+)\b/gi },
  { name: "uh", re: /\bu+h+\b/gi },
  { name: "like", re: /(?:^|[.!?]\s+|,\s*)like\b(?=\s*,|\s)|\blike,/gi },
  { name: "you know", re: /(?<!\b(?:do|did|don't|if|would|will|should|you'd)\s)\byou know\b(?!\s+(?:what|that|how|why|where|who|when|whether|if|the|a|an|it|him|her|them|me|us|about)\b)/gi },
  { name: "I mean", re: /\bI mean\b(?!\s+(?:it|that|to|what|this)\b)/gi },
  { name: "sort of", re: /(?<!\b(?:what|this|that|a|any|some|which|the|every|same|one|my|your|our|their|his|her|its|different|new|other|right|wrong)\s)\bsort of\b/gi },
  { name: "kind of", re: /(?<!\b(?:what|this|that|a|any|some|which|the|every|same|one|my|your|our|their|his|her|its|different|new|other|right|wrong)\s)\bkind of\b/gi },
  { name: "basically", re: /\bbasically\b/gi },
  { name: "actually", re: /\bactually\b/gi },
  { name: "literally", re: /\bliterally\b/gi },
];

/** Non-inclusive terms: a short, conservative list (with a plainer word to suggest). */
export const NON_INCLUSIVE: { term: string; re: RegExp; instead: string }[] = [
  { term: "guys (addressing a group)", re: /\b(?:you|hey|hi|thanks|thank you|okay|ok|morning|alright)\s+guys\b/gi, instead: "everyone, folks, team" },
  { term: "whitelist / blacklist", re: /\b(?:white|black)[- ]?list(?:s|ed|ing)?\b/gi, instead: "allowlist, blocklist" },
  { term: "master / slave", re: /\bslaves?\b/gi, instead: "primary, replica" },
  { term: "manpower", re: /\bmanpower\b/gi, instead: "staffing, people" },
  { term: "man-hours", re: /\bman[- ]hours?\b/gi, instead: "person-hours" },
  { term: "chairman", re: /\bchairman\b/gi, instead: "chair, chairperson" },
  { term: "grandfathered", re: /\bgrandfather(?:ed|ing)?\b/gi, instead: "exempted, legacy" },
];

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
export const wordCount = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
export const fillerCount = (text: string) => FILLERS.reduce((n, f) => n + count(text, f.re), 0);
export const nonInclusiveCount = (text: string) => NON_INCLUSIVE.reduce((n, f) => n + count(text, f.re), 0);
/** Sentences ending in "?". */
export const questionCount = (text: string) => (text.match(/[^.!?]*\?+/g) ?? []).filter((s) => /[\p{L}\p{N}]/u.test(s)).length;

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Per speaker: talk seconds, words, words per minute, fillers, questions,
 * non-inclusive terms and the longest monologue (one speaker's consecutive
 * segments, gaps under 2 s, nobody else in between). Pure.
 */
export function speakerStats(segments: Seg[]): SpeakerStat[] {
  const segs = [...segments].filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)).sort((a, b) => a.start - b.start);
  const by = new Map<string, SpeakerStat>();
  for (const s of segs) {
    const name = s.speaker || "Unknown";
    const st = by.get(name) ?? { name, identity: s.identity ?? null, talkSec: 0, words: 0, wpm: 0, fillers: 0, questions: 0, nonInclusive: 0, longestMonologueSec: 0, firstStart: s.start };
    st.talkSec += Math.max(0, s.end - s.start);
    st.words += wordCount(s.text);
    st.fillers += fillerCount(s.text);
    st.questions += questionCount(s.text);
    st.nonInclusive += nonInclusiveCount(s.text);
    if (!st.identity && s.identity) st.identity = s.identity;
    by.set(name, st);
  }
  // Monologues: runs of one speaker.
  let run: { name: string; start: number; end: number } | null = null;
  const close = () => {
    if (!run) return;
    const st = by.get(run.name)!;
    st.longestMonologueSec = Math.max(st.longestMonologueSec, run.end - run.start);
  };
  for (const s of segs) {
    const name = s.speaker || "Unknown";
    if (run && run.name === name && s.start - run.end < 2) run.end = Math.max(run.end, s.end);
    else {
      close();
      run = { name, start: s.start, end: s.end };
    }
  }
  close();
  return [...by.values()]
    .map((s) => ({ ...s, talkSec: r1(s.talkSec), longestMonologueSec: r1(s.longestMonologueSec), wpm: s.talkSec >= 1 ? r1(s.words / (s.talkSec / 60)) : 0 }))
    .sort((a, b) => b.talkSec - a.talkSec);
}

// ── Engagement and scores (pure) ───────────────────────────────────────────

/**
 * Engagement in [from, to): turn-taking (3+ speaker changes a minute is
 * full), balance (how evenly the talk is shared), questions (one a minute
 * is full) and interruptions (a few are lively, many are not). 0–100.
 */
export function engagementOf(segments: Seg[], from: number, to: number) {
  const inW = segments.filter((s) => s.start < to && s.end > from).sort((a, b) => a.start - b.start);
  if (!inW.length) return 0;
  const minutes = Math.max((to - from) / 60, 0.25);
  const talk = new Map<string, number>();
  let turns = 0, questions = 0, interruptions = 0;
  inW.forEach((s, i) => {
    talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + Math.max(0.1, Math.min(s.end, to) - Math.max(s.start, from)));
    questions += questionCount(s.text);
    if (i > 0 && inW[i - 1].speaker !== s.speaker) {
      turns++;
      if (s.start < inW[i - 1].end - 0.3) interruptions++;
    }
  });
  const n = talk.size;
  const total = [...talk.values()].reduce((a, b) => a + b, 0);
  const maxShare = Math.max(...talk.values()) / total;
  const balance = n < 2 ? 0 : 1 - (maxShare - 1 / n) / (1 - 1 / n);
  const turnScore = Math.min(1, turns / minutes / 3);
  const qScore = Math.min(1, questions / minutes);
  const rate = interruptions / minutes;
  const lively = rate <= 2 ? rate / 2 : Math.max(0, 1 - (rate - 2) / 4);
  return Math.round(100 * (0.35 * turnScore + 0.3 * balance + 0.2 * qScore + 0.15 * lively));
}

/** Window starts for the timeline: about a minute each (about 10 windows for short meetings, at most about 60). */
export function timelineWindows(durationSec: number) {
  const d = Math.max(1, durationSec);
  const step = d < 600 ? Math.max(10, Math.ceil(d / 10)) : Math.max(60, Math.ceil(d / 60 / 60) * 60);
  const out: number[] = [];
  for (let t = 0; t < d; t += step) out.push(t);
  return { step, starts: out };
}

/** On time: full marks up to 2 minutes late, nothing from 15 minutes. null when there was no scheduled start. */
export function onTimeScore(scheduled: Date | null, started: Date | null) {
  if (!scheduled || !started) return null;
  const late = (started.getTime() - scheduled.getTime()) / 60000;
  if (late <= 2) return 100;
  if (late >= 15) return 0;
  return Math.round(100 * (1 - (late - 2) / 13));
}

/** Read score: sentiment and engagement (35% each), structure (agenda, decisions, action items; 20%) and on-time start (10%, left out when unknown). */
export function readScore(p: { sentiment: number; engagement: number; agenda: boolean; decisions: number; actionItems: number; onTime: number | null }) {
  const structure = 40 * (p.agenda ? 1 : 0) + 30 * Math.min(1, p.decisions / 2) + 30 * Math.min(1, p.actionItems / 2);
  const base = 0.35 * clamp100(p.sentiment) + 0.35 * clamp100(p.engagement) + 0.2 * structure;
  return clamp100(p.onTime === null ? base / 0.9 : base + 0.1 * p.onTime);
}

export const clamp100 = (n: unknown) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : 50;
};

// ── Report shape (pure validation and repair) ──────────────────────────────

const str = (v: unknown, max: number) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)).trim().slice(0, max);
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Coerce anything into a valid version-2 report: strings trimmed and capped,
 * times clamped into [0, duration], end >= start, scores clamped to 0–100,
 * empty items dropped, chapters and the timeline in time order. Pure.
 */
export function validateReport(x: unknown, ctx: { template?: string; language?: string; durationSec?: number } = {}): Report {
  const o = obj(x);
  const dur = ctx.durationSec && ctx.durationSec > 0 ? ctx.durationSec : Infinity;
  const t = (v: unknown) => {
    const n = Number(v);
    if (v === null || v === undefined || v === "" || !Number.isFinite(n) || n < 0) return null;
    return Math.round(Math.min(n, dur === Infinity ? n : dur) * 10) / 10;
  };
  const t0 = (v: unknown) => t(v) ?? 0;
  const span = (a: unknown, b: unknown) => {
    const s = t0(a);
    const e = t(b);
    return { start: s, end: e === null || e < s ? Math.min(s + 30, dur === Infinity ? s + 30 : dur) : e };
  };
  const scores = obj(o.scores);
  return {
    version: 2,
    template: str(o.template, 60) || ctx.template || "general",
    language: str(o.language, 40) || ctx.language || "",
    summary: str(o.summary, 6000),
    chapters: arr(o.chapters, 40)
      .map(obj)
      .map((c) => ({ title: str(c.title, 200), ...span(c.start, c.end), summary: str(c.summary, 1500) }))
      .filter((c) => c.title)
      .sort((a, b) => a.start - b.start),
    actionItems: arr(o.actionItems, 60)
      .map(obj)
      .map((a) => ({ title: str(a.title, 300), owner: str(a.owner, 120), due: /^\d{4}-\d{2}-\d{2}$/.test(str(a.due, 10)) ? str(a.due, 10) : "", start: t(a.start) }))
      .filter((a) => a.title),
    keyQuestions: arr(o.keyQuestions, 40)
      .map(obj)
      .map((q) => ({ question: str(q.question, 500), askedBy: str(q.askedBy, 120), answered: q.answered === true || q.answered === "true", start: t(q.start) }))
      .filter((q) => q.question),
    decisions: arr(o.decisions, 40).map((d) => str(typeof d === "object" ? obj(d).text ?? obj(d).title : d, 500)).filter(Boolean),
    topics: [...new Set(arr(o.topics, 20).map((d) => str(d, 60)).filter(Boolean))].slice(0, 8),
    highlights: arr(o.highlights, 30)
      .map(obj)
      .map((h) => ({ ...span(h.start, h.end), text: str(h.text, 500), by: str(h.by, 120) }))
      .filter((h) => h.text),
    sections: arr(o.sections, 20)
      .map(obj)
      .map((s) => ({ title: str(s.title, 120), body: str(s.body, 4000) }))
      .filter((s) => s.title),
    scores: { read: clamp100(scores.read), sentiment: clamp100(scores.sentiment), engagement: clamp100(scores.engagement) },
    timeline: arr(o.timeline, 200)
      .map(obj)
      .map((p) => ({ start: t0(p.start), sentiment: clamp100(p.sentiment), engagement: clamp100(p.engagement) }))
      .sort((a, b) => a.start - b.start),
  };
}

// ── Custom vocabulary (pure correction) ────────────────────────────────────

function lev(a: string, b: string) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * Respell near-misses of custom vocabulary ("Zephyriax" -> "Zephyrix",
 * "Pria" -> "Priya"). Single words of 4+ letters; one edit for short terms,
 * two for 8+ letters; words that are already common English are left alone
 * by requiring the first letter to match. Pure.
 */
export function applyVocab(text: string, terms: string[]) {
  const singles = [...new Set(terms.map((t) => t.trim()).filter((t) => /^[\p{L}\p{N}][\p{L}\p{N}'-]{3,}$/u.test(t)))];
  if (!singles.length) return text;
  return text.replace(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu, (whole) => {
    // "Zephyrec's" is checked as "Zephyrec" and keeps its "'s".
    const [, w, poss = ""] = /^(.*?)(['’]s)?$/u.exec(whole)!;
    if (w.length < 3) return whole;
    const lw = w.toLowerCase();
    for (const t of singles) {
      const lt = t.toLowerCase();
      if (lw === lt) return t + poss;
      if (lw[0] !== lt[0]) continue;
      const allowed = lt.length >= 8 ? 2 : 1;
      if (lev(lw, lt) <= allowed) return t + poss;
      // Long made-up names heard with a different ending ("Zephyreeks"): same first ~70%, similar length.
      const head = Math.ceil(lt.length * 0.7);
      if (lt.length >= 7 && Math.abs(lw.length - lt.length) <= 3 && lw.slice(0, head) === lt.slice(0, head)) return t + poss;
    }
    return whole;
  });
}

/** Custom vocabulary: the workspace's MeetVocab terms plus glossary terms from the company knowledge base. */
export async function vocabTerms(ws: string, asUserId: string, topic = "") {
  const own = await db.meetVocab.findMany({ where: { ws }, orderBy: { term: "asc" }, take: 300 });
  const kb = await companyKnowledge({ userId: asUserId, ws }, `glossary terms names products ${topic}`.trim(), 5).catch(() => ({ hits: [] as { kind: string; title: string; text: string }[] }));
  const gloss: string[] = [];
  for (const h of kb.hits.filter((h) => h.kind === "glossary")) {
    for (const line of h.text.split(/\n+/)) {
      const m = /^\s*(?:[-*•]\s*)?\**([\p{L}\p{N}][\p{L}\p{N} .&'-]{1,40}?)\**\s*(?:[:—–=]|\s-\s)/u.exec(line);
      if (m) gloss.push(m[1].trim());
    }
  }
  return { terms: [...new Set([...own.map((v) => v.term), ...gloss])].slice(0, 300), notes: own.filter((v) => v.note).map((v) => `${v.term}: ${v.note}`) };
}

// ── Transcription ──────────────────────────────────────────────────────────

/** ffmpeg from the ffmpeg-static package (or FFMPEG_PATH). */
export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const p = path.join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return fs.existsSync(p) ? p : null;
}

function ffmpeg(args: string[], timeoutMs = 30 * 60_000): Promise<{ code: number; err: string }> {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new HttpError(503, "ffmpeg isn't installed on this server."));
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-20000);
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, err });
    });
  });
}

/** Length of a media file in seconds (ffmpeg's "Duration:" line), or null. */
export async function mediaDuration(file: string) {
  if (!ffmpegPath()) return null;
  const { err } = await ffmpeg(["-i", file], 60_000);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  // MediaRecorder WebM has no duration in its header: decode to find the end.
  const r = await ffmpeg(["-i", file, "-vn", "-f", "null", "-"], 10 * 60_000);
  const times = [...r.err.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times.at(-1);
  return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null;
}

/** Rewrite a browser recording so players can seek it (adds duration and cues; no re-encode). */
export async function remux(file: string) {
  if (!ffmpegPath()) return false;
  const ext = path.extname(file);
  const out = `${file}.fixed${ext}`;
  const r = await ffmpeg(["-y", "-i", file, "-c", "copy", ...(ext === ".mp4" || ext === ".m4a" ? ["-movflags", "+faststart"] : []), out]);
  if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
    fs.renameSync(out, file);
    return true;
  }
  fs.rmSync(out, { force: true });
  return false;
}

/** Transcode to 16 kHz mono Opus and split into chunks; each chunk with its offset in the original. */
export async function splitAudio(file: string, dir: string, chunkSec = CHUNK_SEC) {
  fs.mkdirSync(dir, { recursive: true });
  const r = await ffmpeg(["-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "segment", "-segment_time", String(chunkSec), "-reset_timestamps", "1", path.join(dir, "part-%04d.ogg")]);
  const parts = fs.readdirSync(dir).filter((f) => /^part-\d+\.ogg$/.test(f)).sort();
  if (r.code !== 0 || !parts.length) {
    if (/does not contain any stream|Output file #0 does not contain|matches no streams/i.test(r.err)) throw new HttpError(422, "The file has no audio.");
    throw new HttpError(422, "The file couldn't be read as audio or video.");
  }
  const out: { path: string; offset: number; duration: number }[] = [];
  let offset = 0;
  for (const f of parts) {
    const p = path.join(dir, f);
    const d = (await mediaDuration(p)) ?? chunkSec;
    out.push({ path: p, offset, duration: d });
    offset += d;
  }
  return out;
}

let diarizeOff = process.env.MEET_DIARIZE === "off";

type RawSeg = { start: number; end: number; speaker: string | null; text: string };

async function openaiTranscribe(file: string, model: string, prompt: string): Promise<{ segs: RawSeg[]; duration: number | null }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new HttpError(503, "Transcription isn't set up on this server (OPENAI_API_KEY is missing).");
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_AUDIO_BYTES) throw new HttpError(413, "This audio chunk is over the transcription limit.");
  const diarize = model !== "whisper-1";
  const form = new FormData();
  const ext = path.extname(file).slice(1) || "ogg";
  form.append("file", new Blob([new Uint8Array(buf)], { type: ext === "wav" ? "audio/wav" : ext === "webm" ? "audio/webm" : ext === "mp3" ? "audio/mpeg" : "audio/ogg" }), `chunk.${ext}`);
  form.append("model", model);
  form.append("response_format", diarize ? "diarized_json" : "verbose_json");
  if (diarize) form.append("chunking_strategy", "auto");
  // Diarization models refuse a prompt; vocabulary is applied to their text afterwards.
  if (!diarize && prompt) form.append("prompt", prompt.slice(0, 800));
  const r = await fetch(`${OPENAI_URL}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(10 * 60_000) });
  const d = (await r.json().catch(() => ({}))) as { text?: string; duration?: number; segments?: { start?: number; end?: number; speaker?: string; text?: string }[]; error?: { message?: string } };
  if (!r.ok) {
    const e = new HttpError(r.status === 429 ? 429 : 502, `Transcription failed (${r.status}): ${String(d.error?.message ?? "").slice(0, 200)}`);
    (e as HttpError & { upstream?: number }).upstream = r.status;
    throw e;
  }
  const segs = (d.segments ?? []).map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || Number(s.start) || 0, speaker: diarize ? String(s.speaker ?? "") || null : null, text: String(s.text ?? "").trim() })).filter((s) => s.text);
  if (!segs.length && d.text?.trim()) segs.push({ start: 0, end: Number(d.duration) || 0, speaker: null, text: d.text.trim() });
  return { segs, duration: Number(d.duration) || null };
}

/** One chunk: diarized when the account has the model, else Whisper with segments. */
async function transcribeChunk(file: string, prompt: string) {
  if (!diarizeOff) {
    try {
      return { ...(await openaiTranscribe(file, DIARIZE_MODEL, prompt)), diarized: true };
    } catch (e) {
      const up = (e as { upstream?: number }).upstream;
      if (up !== 400 && up !== 403 && up !== 404) throw e;
      // The model isn't available to this key (or refused the file): Whisper from now on.
      if (up !== 400) diarizeOff = true;
    }
  }
  return { ...(await openaiTranscribe(file, "whisper-1", prompt)), diarized: false };
}

/** Phrase segments into readable lines: one speaker, gaps under 1.2 s, at most ~25 s a line. */
export function mergeSegments(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && last.speaker === s.speaker && s.start - last.end < 1.2 && s.end - last.start <= 25 && !/[?]$/.test(last.text)) {
      last.end = Math.max(last.end, s.end);
      last.text = `${last.text} ${s.text}`.replace(/\s+/g, " ").trim();
    } else out.push({ ...s, text: s.text.replace(/\s+/g, " ").trim() });
  }
  return out;
}

/**
 * Timestamped transcript of a media file (audio or video, any length):
 * transcoded and split with ffmpeg, each chunk transcribed, times offset.
 * Speakers are "Speaker A", "Speaker B"… (labels are per chunk), or the
 * single name given when only one person speaks.
 */
export async function transcribeMedia(file: string, o: { vocab?: string[]; speakers?: string[] } = {}) {
  const vocab = o.vocab ?? [];
  const prompt = vocab.length ? `Names and terms: ${vocab.slice(0, 80).join(", ")}.` : "";
  const work = path.join(TMP_DIR, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    let chunks: { path: string; offset: number; duration: number }[];
    if (ffmpegPath()) chunks = await splitAudio(file, work);
    else {
      if (fs.statSync(file).size > MAX_AUDIO_BYTES) throw new HttpError(413, "This file is too large to transcribe without ffmpeg on the server.");
      chunks = [{ path: file, offset: 0, duration: 0 }];
    }
    const all: Seg[] = [];
    let diarized = false;
    let total = 0;
    for (const [i, c] of chunks.entries()) {
      const r = await transcribeChunk(c.path, prompt);
      diarized ||= r.diarized;
      const multi = chunks.length > 1;
      for (const s of r.segs) {
        const label = s.speaker ? `Speaker ${s.speaker}${multi ? ` (part ${i + 1})` : ""}` : "Speaker";
        all.push({ start: c.offset + s.start, end: c.offset + Math.max(s.start, s.end), speaker: label, identity: null, text: applyVocab(s.text, vocab) });
      }
      total = c.offset + (c.duration || r.duration || 0);
    }
    let segs = mergeSegments(all);
    const names = [...new Set(segs.map((s) => s.speaker))];
    const given = (o.speakers ?? []).map((s) => s.trim()).filter(Boolean);
    if (given.length === 1 && names.length === 1) segs = segs.map((s) => ({ ...s, speaker: given[0] }));
    return { segments: segs, durationSec: total || (segs.at(-1)?.end ?? 0), diarized };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ── Segments for live calls ────────────────────────────────────────────────

/** Caption lines (saved when each line finished) as segments, timed from the meeting start. Pure. */
export function captionSegments(lines: { identity: string; name: string; text: string; at: Date }[], base: Date): Seg[] {
  return [...lines]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((l) => {
      const end = Math.max(0, (l.at.getTime() - base.getTime()) / 1000);
      const dur = Math.min(30, Math.max(1, wordCount(l.text) * 0.4));
      return { start: Math.round(Math.max(0, end - dur) * 10) / 10, end: Math.round(end * 10) / 10, speaker: l.name, identity: l.identity, text: l.text };
    });
}

/** Name diarized speakers from the captions: each label takes the caption speaker heard most often at the same moments. Pure. */
export function nameFromCaptions(segs: Seg[], caps: Seg[]): Seg[] {
  if (!caps.length) return segs;
  const votes = new Map<string, Map<string, number>>();
  for (const s of segs) {
    const near = caps.filter((c) => c.end >= s.start - 1 && c.end <= s.end + 6);
    for (const c of near) {
      const v = votes.get(s.speaker) ?? new Map<string, number>();
      v.set(`${c.speaker}\u0000${c.identity ?? ""}`, (v.get(`${c.speaker}\u0000${c.identity ?? ""}`) ?? 0) + 1);
      votes.set(s.speaker, v);
    }
  }
  const pick = new Map<string, { name: string; identity: string | null }>();
  for (const [label, v] of votes) {
    const [best] = [...v.entries()].sort((a, b) => b[1] - a[1]);
    if (best) {
      const [name, identity] = best[0].split("\u0000");
      pick.set(label, { name, identity: identity || null });
    }
  }
  return segs.map((s) => (pick.has(s.speaker) ? { ...s, speaker: pick.get(s.speaker)!.name, identity: pick.get(s.speaker)!.identity } : s));
}

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
};
export const transcriptOf = (segs: Seg[]) => segs.map((s) => `[${fmt(s.start)}] ${s.speaker}: ${s.text}`).join("\n");

async function saveSegments(meetingId: string, segs: Seg[]) {
  await db.$transaction([
    db.meetSegment.deleteMany({ where: { meetingId } }),
    db.meetSegment.createMany({
      data: segs.map((s, seq) => ({ meetingId, seq, start: s.start, end: s.end, speaker: s.speaker.slice(0, 120), identity: s.identity ?? null, text: s.text.slice(0, 5000) })),
    }),
  ]);
}

const segsOf = (rows: { start: number; end: number; speaker: string; identity: string | null; text: string }[]): Seg[] => rows.map((r) => ({ start: r.start, end: r.end, speaker: r.speaker, identity: r.identity, text: r.text }));

// ── Ways in ────────────────────────────────────────────────────────────────

export const MEDIA_EXT: Record<string, string> = {
  "audio/webm": "webm", "video/webm": "webm", "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/flac": "flac", "audio/x-flac": "flac", "video/mp4": "mp4", "video/quicktime": "mov", "video/x-matroska": "mkv", "video/x-msvideo": "avi", "video/mpeg": "mpeg",
};
export const isVideoMime = (mime: string) => /^video\//.test(mime);

/** Keep a media file with the meeting as a playable recording (kind "upload"). Moves it when asked, else copies. */
export async function attachMedia(meetingId: string, filePath: string, o: { mime?: string; move?: boolean; startedBy: string }) {
  const m = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
  const mime = o.mime ?? "audio/webm";
  const ext = MEDIA_EXT[mime.split(";")[0].trim().toLowerCase()] ?? (path.extname(filePath).slice(1).toLowerCase() || "webm");
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${m.code}-upload-${isVideoMime(mime) ? "video" : "audio"}-${stamp}.${ext}`;
  const dest = path.join(RECORDINGS_DIR, file);
  if (path.resolve(filePath) !== dest) {
    if (o.move) {
      try {
        fs.renameSync(filePath, dest);
      } catch {
        fs.copyFileSync(filePath, dest);
        fs.rmSync(filePath, { force: true });
      }
    } else fs.copyFileSync(filePath, dest);
  }
  return db.meetRecording.create({
    data: { meetingId, kind: "upload", egressId: `upload_${m.id}_${stamp}`, file, status: "complete", size: Math.min(2 ** 31 - 1, fs.statSync(dest).size), startedBy: o.startedBy, startedAt: m.startedAt ?? new Date(), endedAt: new Date() },
  });
}

const running = new Set<string>();

async function fail(meetingId: string, e: unknown) {
  const msg = e instanceof HttpError ? e.message : "Something went wrong while writing the report.";
  if (!(e instanceof HttpError)) console.error("[meet] report", e);
  await db.meeting.update({ where: { id: meetingId }, data: { notesStatus: "failed", notesError: msg } }).catch(() => null);
}

/**
 * Transcribe a media file into the meeting's timestamped transcript, then
 * write the report. The file is kept as the meeting's playable recording
 * (copied in unless it is already one). Throws after marking the meeting
 * failed, so callers can run it in the background with .catch().
 */
export async function ingestAudio(meetingId: string, filePath: string, opts: { mime?: string; speakers?: string[] } = {}) {
  const m = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
  await db.meeting.update({ where: { id: meetingId }, data: { notesStatus: "processing", notesError: "" } });
  try {
    if (!fs.existsSync(filePath)) throw new HttpError(404, "The recording file is missing.");
    const kept = await db.meetRecording.findMany({ where: { meetingId, kind: "upload", deletedAt: null } });
    if (!kept.some((r) => recordingPath(r) === path.resolve(filePath))) await attachMedia(meetingId, filePath, { mime: opts.mime, startedBy: m.hostId });
    const { terms } = await vocabTerms(m.ws, m.hostId, m.title);
    const t = await transcribeMedia(filePath, { vocab: terms, speakers: opts.speakers });
    if (!t.segments.length) throw new HttpError(422, "Nobody could be heard in the recording.");
    await saveSegments(meetingId, t.segments);
    await db.meeting.update({ where: { id: meetingId }, data: { durationSec: Math.round(t.durationSec), transcript: transcriptOf(t.segments) } });
    return await buildReport(meetingId);
  } catch (e) {
    await fail(meetingId, e);
    throw e;
  }
}

/**
 * Live Meet call with notes recordings: each finished audio recording is
 * transcribed with times (offset by when it started), and diarized speakers
 * are named from the caption lines when there are any.
 */
export async function ingestLive(meetingId: string, recs: MeetRecording[]) {
  const m = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
  const base = m.startedAt ?? recs[0]?.startedAt ?? m.createdAt;
  const { terms } = await vocabTerms(m.ws, m.hostId, m.title);
  let segs: Seg[] = [];
  let end = 0;
  for (const r of recs) {
    const off = Math.max(0, (r.startedAt.getTime() - base.getTime()) / 1000);
    const t = await transcribeMedia(recordingPath(r), { vocab: terms });
    segs.push(...t.segments.map((s) => ({ ...s, start: s.start + off, end: s.end + off })));
    end = Math.max(end, off + t.durationSec);
  }
  if (!segs.length) throw new HttpError(422, "Nobody could be heard in the recording.");
  const caps = await db.meetCaption.findMany({ where: { meetingId }, orderBy: { at: "asc" }, take: 20000 });
  segs = nameFromCaptions(segs, captionSegments(caps, base));
  // Speakers named after the people who joined when only one person was there.
  const ps = await db.meetParticipant.findMany({ where: { meetingId, status: "admitted" } });
  if (ps.length === 1 && new Set(segs.map((s) => s.speaker)).size === 1) segs = segs.map((s) => ({ ...s, speaker: ps[0].name, identity: ps[0].identity }));
  await saveSegments(meetingId, segs);
  const dur = m.endedAt && m.startedAt ? (m.endedAt.getTime() - m.startedAt.getTime()) / 1000 : end;
  await db.meeting.update({ where: { id: meetingId }, data: { durationSec: Math.round(Math.max(dur, end)), transcript: transcriptOf(segs) } });
  return buildReport(meetingId);
}

// ── Templates ──────────────────────────────────────────────────────────────

export type TemplateSection = { title: string; prompt: string };
export type Template = { id: string; name: string; instructions: string; sections: TemplateSection[]; builtin: boolean };

export const BUILTIN_TEMPLATES: Template[] = [
  { id: "general", name: "General", builtin: true, instructions: "A general business meeting.", sections: [{ title: "Key takeaways", prompt: "The 3–5 most important points." }, { title: "Next steps", prompt: "What happens next, and who does it." }] },
  {
    id: "sales", name: "Sales call", builtin: true, instructions: "A sales or discovery call with a prospect or customer. Focus on the buyer's needs and the path to a deal.",
    sections: [
      { title: "Pain points", prompt: "The problems the customer described, in their words where possible." },
      { title: "Budget", prompt: "Budget, pricing or spend mentioned; say if it wasn't discussed." },
      { title: "Decision process", prompt: "Who decides, who else is involved, and the timeline." },
      { title: "Objections", prompt: "Concerns or objections raised, and how they were handled." },
      { title: "Next steps", prompt: "Agreed next steps with dates." },
    ],
  },
  {
    id: "interview", name: "Recruiting interview", builtin: true, instructions: "A job interview. Be factual and fair; report only what the candidate said and did, no guesses about personal traits.",
    sections: [
      { title: "Candidate background", prompt: "Experience and skills the candidate described." },
      { title: "Strengths", prompt: "Evidence of strengths from their answers." },
      { title: "Concerns", prompt: "Gaps or open questions, based on their answers." },
      { title: "Questions the candidate asked", prompt: "What the candidate asked the interviewers." },
      { title: "Recommendation and next steps", prompt: "What the interviewers said about next steps; don't decide for them." },
    ],
  },
  {
    id: "team", name: "Team meeting", builtin: true, instructions: "A recurring team meeting or stand-up.",
    sections: [{ title: "Progress updates", prompt: "What each person or workstream reported." }, { title: "Blockers", prompt: "What is stuck and what is needed." }, { title: "Priorities", prompt: "What the team will focus on next." }],
  },
  {
    id: "coaching", name: "Coaching session", builtin: true, instructions: "A coaching or mentoring session.",
    sections: [{ title: "Goals", prompt: "What the person wants to achieve." }, { title: "Challenges discussed", prompt: "Obstacles they described." }, { title: "Advice given", prompt: "Guidance and ideas offered." }, { title: "Commitments", prompt: "What the person committed to try, by when." }],
  },
  {
    id: "one-on-one", name: "One-on-one", builtin: true, instructions: "A one-on-one between a manager and a report, or two peers.",
    sections: [{ title: "Wins", prompt: "What went well." }, { title: "Concerns", prompt: "Worries or problems raised." }, { title: "Feedback", prompt: "Feedback given in either direction." }, { title: "Follow-ups", prompt: "What each person will do before next time." }],
  },
];

export async function listTemplates(ws: string): Promise<Template[]> {
  const own = await db.meetTemplate.findMany({ where: { ws }, orderBy: { createdAt: "asc" } });
  return [...BUILTIN_TEMPLATES, ...own.map((t) => ({ id: t.id, name: t.name, instructions: t.instructions, sections: (t.sections as TemplateSection[]) ?? [], builtin: false }))];
}

export async function resolveTemplate(ws: string, id: string): Promise<Template> {
  const b = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (b) return b;
  const t = await db.meetTemplate.findFirst({ where: { id, ws } });
  if (t) return { id: t.id, name: t.name, instructions: t.instructions, sections: (t.sections as TemplateSection[]) ?? [], builtin: false };
  return BUILTIN_TEMPLATES[0];
}

export function cleanTemplate(input: { name?: unknown; instructions?: unknown; sections?: unknown }) {
  const name = str(input.name, 80);
  if (!name) bad("Give the template a name.");
  const sections = arr(input.sections, 12)
    .map((s) => (typeof s === "string" ? { title: s, prompt: "" } : obj(s)))
    .map((s) => ({ title: str(s.title, 80), prompt: str(s.prompt, 400) }))
    .filter((s) => s.title);
  if (!sections.length) bad("Add at least one section.");
  return { name, instructions: str(input.instructions, 2000), sections };
}

// ── The report ─────────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;
const anthropic = () => (anthropicClient ??= new Anthropic({ fetch: meteredFetch("Meet: report") }));

async function claudeJson<T>(system: string, user: string, schema: Record<string, unknown>, maxTokens = 16000): Promise<T> {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "AI reports aren't set up on this server (ANTHROPIC_API_KEY is missing).");
  try {
    const params = {
      model: REPORT_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user" as const, content: user }],
      output_config: { format: { type: "json_schema" as const, schema } },
      // On a policy decline the API re-runs the request on Anthropic's recommended fallback model.
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    };
    const msg = (await anthropic().beta.messages.create(params as never)) as unknown as Anthropic.Message;
    if (msg.stop_reason === "refusal") throw new HttpError(422, "The AI declined to write this.");
    if (msg.stop_reason === "max_tokens") throw new HttpError(502, "The answer was too long to finish. Try again.");
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return JSON.parse(text) as T;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof SyntaxError) throw new HttpError(502, "The AI's answer couldn't be read. Try again.");
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The AI key on this server isn't valid.");
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service answered ${e.status ?? "an error"}: ${String(e.message).slice(0, 200)}`);
    throw e;
  }
}

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const o = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: unknown) => ({ type: "array", items });

/** What Claude writes; scores other than sentiment are computed here. Times are seconds; -1 = unknown. */
const AI_SCHEMA = o({
  language: { type: "string", description: "The language this report is written in, e.g. English." },
  summary: { type: "string", description: "3–6 sentences." },
  agenda: { type: "boolean", description: "True if the meeting stated an agenda or a clear purpose near the start." },
  chapters: list(o({ title: S, start: N, end: N, summary: S })),
  actionItems: list(o({ title: { type: "string", description: "Starts with a verb." }, owner: S, due: { type: "string", description: "YYYY-MM-DD or empty." }, start: N })),
  keyQuestions: list(o({ question: S, askedBy: S, answered: { type: "boolean" }, start: N })),
  decisions: list(S),
  topics: list(S),
  highlights: list(o({ start: N, end: N, text: S, by: S })),
  sections: list(o({ title: S, body: S })),
  sentiment: { type: "number", description: "0 (very negative) to 100 (very positive), from the language used." },
  sentimentTimeline: list(o({ start: N, sentiment: N })),
});

type AiReport = {
  language: string; summary: string; agenda: boolean; chapters: unknown[]; actionItems: { start: number }[]; keyQuestions: { start: number }[]; decisions: string[]; topics: string[];
  highlights: unknown[]; sections: unknown[]; sentiment: number; sentimentTimeline: { start: number; sentiment: number }[];
};

const MAX_TRANSCRIPT_CHARS = 600_000;
const linesForAi = (segs: Seg[]) => {
  const t = segs.map((s) => `[${Math.round(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
  return t.length > MAX_TRANSCRIPT_CHARS ? `${t.slice(0, MAX_TRANSCRIPT_CHARS)}\n[… transcript cut here]` : t;
};

/** Where the scheduled start comes from: the calendar event, or a webinar's start. */
async function scheduledStart(m: Meeting) {
  if (m.startsAt) return m.startsAt;
  if (!m.eventId) return null;
  const ev = await db.event.findUnique({ where: { id: m.eventId }, select: { start: true } }).catch(() => null);
  return ev?.start ?? null;
}

/**
 * Write the meeting's report from its MeetSegment rows (or, for a live call
 * without them, from the caption lines; or from a plain transcript). Fills
 * Meeting.report, notes (the old shape), MeetSpeaker rows and notesStatus,
 * clears translations and tells the host.
 */
/** Written in the background after a call too, so the usage log is told whose meeting it was. */
export async function buildReport(meetingId: string, opts: { template?: string; lang?: string } = {}): Promise<Report> {
  const owner = await db.meeting.findUnique({ where: { id: meetingId }, select: { ws: true, hostId: true } });
  return withAiContext({ workspaceId: owner?.ws, userId: owner?.hostId }, () => writeReport(meetingId, opts));
}

async function writeReport(meetingId: string, opts: { template?: string; lang?: string }): Promise<Report> {
  if (running.has(meetingId)) throw new HttpError(409, "The report is already being written.");
  running.add(meetingId);
  try {
    let m = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    await db.meeting.update({ where: { id: meetingId }, data: { notesStatus: "processing", notesError: "" } });
    let segs = segsOf(await db.meetSegment.findMany({ where: { meetingId }, orderBy: { seq: "asc" } }));
    if (!segs.length) {
      const caps = await db.meetCaption.findMany({ where: { meetingId }, orderBy: { at: "asc" }, take: 20000 });
      if (caps.length) segs = captionSegments(caps, m.startedAt ?? caps[0].at);
      else if (m.transcript.trim())
        // An old plain transcript: one segment per line, no real times.
        segs = m.transcript.split(/\n+/).filter((l) => l.trim()).map((l, i) => {
          const mm = /^(?:\[[^\]]*\]\s*)?([^:]{1,60}):\s*(.+)$/.exec(l.trim());
          return { start: i * 10, end: i * 10 + 9, speaker: mm ? mm[1] : "Speaker", identity: null, text: mm ? mm[2] : l.trim() };
        });
      if (!segs.length) throw new HttpError(422, "There's no transcript to write a report from.");
      await saveSegments(meetingId, segs);
    }
    // People who opted out of being summarised (helper B's read.ts): their lines go before the model sees anything.
    const { applyOptOuts } = await import("./read");
    if ((await applyOptOuts(meetingId)).length) {
      segs = segsOf(await db.meetSegment.findMany({ where: { meetingId }, orderBy: { seq: "asc" } }));
      m = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
      if (!segs.length) throw new HttpError(422, "Everyone in this recording opted out of being summarised.");
    }
    const template = await resolveTemplate(m.ws, opts.template ?? m.template);
    const lang = (opts.lang ?? m.reportLang ?? "").trim().slice(0, 40);
    const lastEnd = Math.max(...segs.map((s) => s.end));
    const duration = Math.max(m.durationSec ?? 0, lastEnd);
    const stats = speakerStats(segs);
    const { terms, notes: vocabNotes } = await vocabTerms(m.ws, m.hostId, m.title);
    const transcript = linesForAi(segs);
    // Knowledge first, as the host; the report goes to everyone who attended, so only articles any member may read.
    const kb = await consultKnowledge({ userId: m.hostId, ws: m.ws }, `${m.title}\n${transcript.slice(0, 600)}`, { context: m.title, cite: false, shared: true });
    const { step, starts } = timelineWindows(duration);
    const date = (m.startedAt ?? m.createdAt).toISOString().slice(0, 10);
    const system = [
      "You write Read-style meeting reports for a business team, from a timestamped transcript. Each line starts with [seconds from the start].",
      "Use only what is in the transcript. Times you give are seconds, taken from the line where the thing was said; use -1 when there is no such moment.",
      "chapters: 2–10 consecutive parts that cover the whole meeting, each with a title, start, end and a 1–2 sentence summary (fewer for very short meetings).",
      "actionItems: tasks someone agreed to do; owner exactly as named in the meeting (or empty); due as YYYY-MM-DD only when a date was stated (the meeting date is given); start = when it was agreed.",
      "keyQuestions: the important questions asked, who asked, whether they were answered in the meeting, and when.",
      "decisions: what was decided. topics: 3–8 short reusable topic names (2–4 words, Title Case).",
      "highlights: 2–6 moments worth replaying (a key statement or decision), each 10–60 s long, with who said it.",
      "sentiment: how positive the language is overall, 0–100 (50 = neutral). sentimentTimeline: one value per window start given, from the words spoken in that window.",
      "agenda: whether an agenda or clear purpose was stated near the start.",
      `Template: ${template.name}. ${template.instructions}`,
      `sections: exactly these, in this order, each a short paragraph or bullet list ("- "): ${template.sections.map((s) => `"${s.title}" (${s.prompt || "as the title says"})`).join("; ")}. If a section wasn't discussed, say so in one line.`,
      lang ? `Write every text field in ${lang}; keep people's names as they are.` : "Write in the language of the meeting.",
    ].join("\n");
    const user = [
      `Meeting: ${m.title}`,
      `Date: ${date}`,
      `Length: ${Math.round(duration)} seconds`,
      `Speakers: ${stats.map((s) => s.name).join(", ") || "unknown"}`,
      terms.length ? `Custom vocabulary (spell these exactly): ${terms.slice(0, 150).join(", ")}${vocabNotes.length ? `\n${vocabNotes.slice(0, 40).join("\n")}` : ""}` : "",
      kb.context ? `${kb.context}\nIn this report, use the company knowledge to spell names, products and terms correctly and to word things in the company's terms; never report it as something said in the meeting.` : "",
      `Timeline window starts (seconds, each ${step} s long): ${starts.join(", ")}`,
      "",
      "Transcript:",
      transcript,
    ].filter(Boolean).join("\n");
    const ai = await claudeJson<AiReport>(system, user, AI_SCHEMA);
    const fixT = (n: unknown) => (typeof n === "number" && n >= 0 ? n : null);
    const sentAt = (t: number) => {
      const hit = (ai.sentimentTimeline ?? []).filter((p) => Math.abs(p.start - t) <= step / 2 + 0.01).sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))[0];
      return hit ? hit.sentiment : ai.sentiment;
    };
    const engagement = engagementOf(segs, 0, Math.max(duration, 1));
    const report = validateReport(
      {
        ...ai,
        template: template.id,
        language: lang || ai.language,
        actionItems: (ai.actionItems ?? []).map((a) => ({ ...a, start: fixT(a.start) })),
        keyQuestions: (ai.keyQuestions ?? []).map((q) => ({ ...q, start: fixT(q.start) })),
        scores: {
          sentiment: ai.sentiment,
          engagement,
          read: readScore({ sentiment: clamp100(ai.sentiment), engagement, agenda: !!ai.agenda, decisions: ai.decisions?.length ?? 0, actionItems: ai.actionItems?.length ?? 0, onTime: onTimeScore(await scheduledStart(m), m.startedAt) }),
        },
        timeline: starts.map((t) => ({ start: t, sentiment: sentAt(t), engagement: engagementOf(segs, t, Math.min(t + step, duration)) })),
      },
      { template: template.id, language: lang, durationSec: duration },
    );
    const notes = { summary: report.summary, decisions: report.decisions, actionItems: report.actionItems.map((a) => ({ title: a.title, owner: a.owner, due: a.due })) };
    // Late joiners: when a member joined after the meeting started.
    const ps = await db.meetParticipant.findMany({ where: { meetingId, status: "admitted" } });
    m = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    await db.$transaction([
      db.meetSpeaker.deleteMany({ where: { meetingId } }),
      db.meetSpeaker.createMany({
        data: stats.map((s) => {
          const p = ps.find((x) => (s.identity && x.identity === s.identity) || x.name === s.name);
          const late = p?.joinedAt && m.startedAt ? Math.round((p.joinedAt.getTime() - m.startedAt.getTime()) / 1000) : null;
          return {
            meetingId, userId: p?.userId ?? (s.identity?.startsWith("u_") ? s.identity.slice(2) : null), name: s.name.slice(0, 120), talkSec: s.talkSec, words: s.words, wpm: s.wpm, fillers: s.fillers, questions: s.questions,
            nonInclusive: s.nonInclusive, longestMonologueSec: s.longestMonologueSec, joinedLateSec: late !== null && late > 60 ? late : null,
          };
        }),
      }),
      db.meetReportLang.deleteMany({ where: { meetingId } }),
      db.meeting.update({
        where: { id: meetingId },
        data: {
          report: report as unknown as Prisma.InputJsonValue, notes, notesStatus: "ready", notesError: "", notesAt: new Date(), template: template.id, reportLang: lang,
          durationSec: Math.round(duration), ...(m.transcript.trim() ? {} : { transcript: transcriptOf(segs) }),
        },
      }),
    ]);
    await notify({ ws: m.ws, userId: m.hostId, kind: "meet.notes", title: `Report ready: ${m.title}`, body: report.summary.slice(0, 200), link: `/meet/${m.code}/notes`, key: `meet-report:${m.id}:${Date.now()}` });
    return report;
  } catch (e) {
    await fail(meetingId, e);
    throw e;
  } finally {
    running.delete(meetingId);
  }
}

/** Re-make the report in the background (another template or language). */
export function rebuildLater(meetingId: string, opts: { template?: string; lang?: string }) {
  if (running.has(meetingId)) throw new HttpError(409, "The report is already being written.");
  void buildReport(meetingId, opts).catch(() => null);
}
export const isBuilding = (meetingId: string) => running.has(meetingId);

// ── Translation ────────────────────────────────────────────────────────────

const LANG_RE = /^[\p{L}][\p{L} ()-]{1,39}$/u;

/** All the report's prose, in order (names, times and scores stay as they are). */
function proseOf(r: Report) {
  return [
    r.summary,
    ...r.chapters.flatMap((c) => [c.title, c.summary]),
    ...r.actionItems.map((a) => a.title),
    ...r.keyQuestions.map((q) => q.question),
    ...r.decisions,
    ...r.topics,
    ...r.highlights.map((h) => h.text),
    ...r.sections.flatMap((s) => [s.title, s.body]),
  ];
}
function withProse(r: Report, t: string[]): Report {
  let i = 0;
  const next = () => {
    const v = t[i++];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const x: Report = JSON.parse(JSON.stringify(r));
  x.summary = next() ?? x.summary;
  for (const c of x.chapters) {
    c.title = next() ?? c.title;
    c.summary = next() ?? c.summary;
  }
  for (const a of x.actionItems) a.title = next() ?? a.title;
  for (const q of x.keyQuestions) q.question = next() ?? q.question;
  x.decisions = x.decisions.map((d) => next() ?? d);
  x.topics = x.topics.map((d) => next() ?? d);
  for (const h of x.highlights) h.text = next() ?? h.text;
  for (const s of x.sections) {
    s.title = next() ?? s.title;
    s.body = next() ?? s.body;
  }
  return x;
}

/** The report in another language, made once and kept until the report is re-made. */
export async function translateReport(m: Meeting, lang: string, asUserId: string): Promise<Report> {
  const l = String(lang ?? "").trim();
  if (!LANG_RE.test(l)) bad("Pick a language.");
  const base = m.report as unknown as Report | null;
  if (!base || m.notesStatus !== "ready") bad("The report isn't ready yet.");
  if (base.language.toLowerCase() === l.toLowerCase()) return base;
  const have = await db.meetReportLang.findUnique({ where: { meetingId_lang: { meetingId: m.id, lang: l } } });
  if (have) return have.report as unknown as Report;
  const prose = proseOf(base);
  const kb = await consultKnowledge({ userId: asUserId, ws: m.ws }, `${m.title} ${base.summary.slice(0, 300)}`, { context: m.title, cite: false, shared: true });
  const out = await claudeJson<{ lines: string[] }>(
    `You translate a meeting report into ${l}. You get a JSON array of texts; reply with { "lines": [...] }: one translation per input text, same order, same count. Keep people's names, product names and "- " bullets as they are.`,
    `${kb.context ? `${kb.context}\nUse the company knowledge only to keep company terms right.\n\n` : ""}${JSON.stringify(prose)}`,
    o({ lines: list(S) }),
  );
  const report = { ...withProse(base, out.lines ?? []), language: l };
  await db.meetReportLang.upsert({ where: { meetingId_lang: { meetingId: m.id, lang: l } }, create: { meetingId: m.id, lang: l, report: report as unknown as Prisma.InputJsonValue }, update: { report: report as unknown as Prisma.InputJsonValue } });
  return report;
}

// ── Ask this meeting ───────────────────────────────────────────────────────

/** Timestamp citations in an answer: [t=123] -> 123. Pure. */
export const citationsOf = (answer: string) => [...answer.matchAll(/\[t=(\d+(?:\.\d+)?)\]/g)].map((x) => Number(x[1]));

/** An answer from this meeting only (transcript and report), citing moments as [t=seconds]. */
export async function askMeeting(me: Me, m: Meeting, question: string) {
  const q = String(question ?? "").trim().slice(0, 1000);
  if (q.length < 2) bad("Ask a question.");
  const segs = segsOf(await db.meetSegment.findMany({ where: { meetingId: m.id }, orderBy: { seq: "asc" } }));
  if (!segs.length) bad("This meeting has no transcript yet.");
  const report = m.report as unknown as Report | null;
  const kb = await consultKnowledge({ userId: me.userId, ws: me.ws }, q, { context: m.title, cite: false });
  const out = await claudeJson<{ answer: string; found: boolean }>(
    [
      "You answer questions about one meeting, using only its transcript and report below. Each transcript line starts with [seconds from the start].",
      "Cite the moments you rely on as [t=SECONDS] right after the sentence they support, using the line's seconds. Cite at least one moment when the answer comes from the transcript.",
      "If the meeting doesn't contain the answer, say so plainly and set found to false; don't fill gaps from general knowledge. Keep it short (under 150 words). Answer in the language of the question.",
    ].join("\n"),
    [
      `Meeting: ${m.title} (${(m.startedAt ?? m.createdAt).toISOString().slice(0, 10)})`,
      kb.context ? `${kb.context}\nUse the company knowledge only to understand names and terms; the answer must come from the meeting.` : "",
      report ? `Report:\n${JSON.stringify({ summary: report.summary, decisions: report.decisions, actionItems: report.actionItems, keyQuestions: report.keyQuestions, sections: report.sections })}` : "",
      `Transcript:\n${linesForAi(segs)}`,
      `Question: ${q}`,
    ].filter(Boolean).join("\n\n"),
    o({ answer: S, found: { type: "boolean" } }),
    4000,
  );
  const last = segs.at(-1)!.end;
  const cites = [...new Set(citationsOf(out.answer).filter((t) => t >= 0 && t <= last + 5))];
  return { answer: String(out.answer ?? "").slice(0, 4000), found: out.found !== false, citations: cites };
}

// ── What the report page reads ─────────────────────────────────────────────

/** Who may read a report: canSeeReport (canSeeNotes plus calendar invitees, shares and folders; helper B's read.ts). */
export async function canSeeMeetingReport(me: Me | null, m: Meeting) {
  const { canSeeReport } = await import("./read");
  return canSeeReport(me, m);
}

/** Media to play with the report: video recording first, then an uploaded file, then the notes audio. offset = its start on the transcript's clock. */
export async function mediaFor(m: Meeting) {
  const recs = await db.meetRecording.findMany({ where: { meetingId: m.id, status: "complete", deletedAt: null }, orderBy: { startedAt: "asc" } });
  const base = m.startedAt ?? recs[0]?.startedAt ?? m.createdAt;
  const rank = (k: string) => (k === "upload" ? 0 : k === "video" ? 1 : 2);
  return recs
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map((r) => ({
      id: r.id,
      kind: r.kind === "upload" ? (/-upload-video-/.test(r.file) ? "video" : "audio") : r.kind === "video" ? "video" : "audio",
      offset: r.kind === "upload" ? 0 : Math.max(0, Math.round((r.startedAt.getTime() - base.getTime()) / 100) / 10),
      file: r.file,
    }));
}

export async function reportDto(m: Meeting, lang?: string | null) {
  const [segments, speakers, langs, media, templates] = await Promise.all([
    db.meetSegment.findMany({ where: { meetingId: m.id }, orderBy: { seq: "asc" }, take: 20000 }),
    db.meetSpeaker.findMany({ where: { meetingId: m.id }, orderBy: { talkSec: "desc" } }),
    db.meetReportLang.findMany({ where: { meetingId: m.id }, select: { lang: true } }),
    mediaFor(m),
    listTemplates(m.ws),
  ]);
  let report = m.notesStatus === "ready" ? ((m.report as unknown as Report | null) ?? null) : null;
  if (report && lang && lang.toLowerCase() !== report.language.toLowerCase()) {
    const t = await db.meetReportLang.findUnique({ where: { meetingId_lang: { meetingId: m.id, lang } } });
    if (t) report = t.report as unknown as Report;
  }
  return {
    kind: m.kind,
    template: m.template,
    reportLang: m.reportLang,
    durationSec: m.durationSec,
    building: running.has(m.id),
    report,
    languages: langs.map((l) => l.lang),
    templates: templates.map((t) => ({ id: t.id, name: t.name, builtin: t.builtin })),
    speakers: speakers.map((s) => ({ name: s.name, userId: s.userId, talkSec: s.talkSec, words: s.words, wpm: s.wpm, fillers: s.fillers, questions: s.questions, nonInclusive: s.nonInclusive, longestMonologueSec: s.longestMonologueSec, joinedLateSec: s.joinedLateSec })),
    segments: segments.map((s) => ({ seq: s.seq, start: s.start, end: s.end, speaker: s.speaker, text: s.text })),
    media,
  };
}

/** Rename a speaker everywhere in this meeting's transcript ("Speaker A" -> "Asha"), then refresh the numbers. */
export async function renameSpeaker(m: Meeting, from: string, to: string) {
  const a = str(from, 120), b = str(to, 120);
  if (!a || !b) bad("Give the new name.");
  const n = await db.meetSegment.updateMany({ where: { meetingId: m.id, speaker: a }, data: { speaker: b } });
  if (!n.count) bad("No one by that name in the transcript.");
  const segs = segsOf(await db.meetSegment.findMany({ where: { meetingId: m.id }, orderBy: { seq: "asc" } }));
  const stats = speakerStats(segs);
  const old = await db.meetSpeaker.findMany({ where: { meetingId: m.id } });
  await db.$transaction([
    db.meetSpeaker.deleteMany({ where: { meetingId: m.id } }),
    db.meetSpeaker.createMany({
      data: stats.map((s) => ({
        meetingId: m.id, userId: old.find((x) => x.name === s.name)?.userId ?? null, name: s.name, talkSec: s.talkSec, words: s.words, wpm: s.wpm, fillers: s.fillers, questions: s.questions,
        nonInclusive: s.nonInclusive, longestMonologueSec: s.longestMonologueSec, joinedLateSec: old.find((x) => x.name === s.name)?.joinedLateSec ?? null,
      })),
    }),
    db.meeting.update({ where: { id: m.id }, data: { transcript: transcriptOf(segs) } }),
  ]);
  // Names in the report itself (owners, askers, highlights).
  const r = m.report as unknown as Report | null;
  if (r) {
    const fix = (x: string) => (x === a ? b : x);
    const nr: Report = { ...r, actionItems: r.actionItems.map((x) => ({ ...x, owner: fix(x.owner) })), keyQuestions: r.keyQuestions.map((x) => ({ ...x, askedBy: fix(x.askedBy) })), highlights: r.highlights.map((x) => ({ ...x, by: fix(x.by) })) };
    await db.meeting.update({ where: { id: m.id }, data: { report: nr as unknown as Prisma.InputJsonValue } });
    await db.meetReportLang.deleteMany({ where: { meetingId: m.id } });
  }
  return { ok: true, renamed: n.count };
}
