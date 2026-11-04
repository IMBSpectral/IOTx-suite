import fs from "node:fs";
import { consultKnowledge } from "../kb";
import Anthropic from "@anthropic-ai/sdk";
import type { Meeting } from "@prisma/client";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad } from "../http";
import { createTask, loadProject } from "../tasks";
import { postMessage } from "../chat";
import { notify } from "../notify";
import { recordingPath, requireRecorder } from "./recording";
import { isMember } from "./meetings";
import { meteredFetch } from "../ai-meter";

/**
 * AI notes: the audio-only recording is transcribed with OpenAI's audio
 * transcription API, then Claude Sonnet 5.5 writes a summary, the decisions
 * and the action items. The host turns action items into Tasks with one
 * click and posts the notes to the meeting's chat thread.
 */

export type MeetingNotes = { summary: string; decisions: string[]; actionItems: { title: string; owner: string; due: string }[] };

const OPENAI_URL = (process.env.MEET_OPENAI_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const TRANSCRIBE_MODEL = process.env.MEET_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe";
const SUMMARY_MODEL = "claude-sonnet-5-5";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Who may read a meeting's notes: the host, members who joined, and invitees. */
export async function canSeeNotes(me: Me | null, m: Meeting) {
  if (!isMember(me, m)) return false;
  if (me.userId === m.hostId || m.invitees.includes(me.userId)) return true;
  const p = await db.meetParticipant.findFirst({ where: { meetingId: m.id, userId: me.userId, status: "admitted" } });
  return !!p;
}

async function transcribeFile(file: string, model = TRANSCRIBE_MODEL): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new HttpError(503, "Transcription isn't set up on this server (OPENAI_API_KEY is missing).");
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_AUDIO_BYTES) throw new HttpError(413, "The notes recording is longer than the transcription limit (about two hours).");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/ogg" }), "meeting.ogg");
  form.append("model", model);
  form.append("response_format", "json");
  if (model !== "whisper-1") form.append("chunking_strategy", "auto");
  const r = await fetch(`${OPENAI_URL}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(10 * 60_000) });
  const d = (await r.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
  if (!r.ok) {
    // Older or limited accounts: fall back to Whisper once.
    if (model !== "whisper-1" && (r.status === 400 || r.status === 404)) return transcribeFile(file, "whisper-1");
    throw new HttpError(502, `Transcription failed (${r.status}): ${String(d.error?.message ?? "").slice(0, 200)}`);
  }
  return String(d.text ?? "").trim();
}

let anthropicClient: Anthropic | null = null;
const anthropic = () => (anthropicClient ??= new Anthropic({ fetch: meteredFetch("Meet: notes") }));

const NOTES_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What the meeting covered, in a short paragraph." },
    decisions: { type: "array", items: { type: "string" } },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "The task, starting with a verb." },
          owner: { type: "string", description: "Who will do it, exactly as named in the meeting, or empty." },
          due: { type: "string", description: "YYYY-MM-DD if a date was agreed, else empty." },
        },
        required: ["title", "owner", "due"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "decisions", "actionItems"],
  additionalProperties: false,
} as const;

export async function summarize(transcript: string, ctx: { title: string; date: string; people: string[]; company?: string }): Promise<MeetingNotes> {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "AI notes aren't set up on this server (ANTHROPIC_API_KEY is missing).");
  try {
    const params = {
      model: SUMMARY_MODEL,
      max_tokens: 16000,
      system:
        "You write meeting notes for a business team. From the transcript, write a short summary, the decisions that were made, and the action items with an owner and a due date when they were stated. Use only what is in the transcript; leave owner or due empty when they weren't said. Write in the language of the meeting.",
      messages: [
        {
          role: "user" as const,
          content: `Meeting: ${ctx.title}\nDate: ${ctx.date}\nPeople in the meeting: ${ctx.people.join(", ") || "unknown"}${ctx.company ? `\n\n${ctx.company}\nIn these notes, use the company knowledge to spell names, products and terms correctly and to word decisions in the company's terms; never report it as something said in the meeting.` : ""}\n\nTranscript:\n${transcript}`,
        },
      ],
      output_config: { format: { type: "json_schema" as const, schema: NOTES_SCHEMA } },
      // On a policy decline the API re-runs the request on Anthropic's recommended fallback model.
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    };
    const r = await anthropic().beta.messages.create(params as never);
    const msg = r as unknown as Anthropic.Message;
    if (msg.stop_reason === "refusal") throw new HttpError(422, "The AI declined to write notes for this meeting.");
    if (msg.stop_reason === "max_tokens") throw new HttpError(502, "The notes were too long to finish. Try again.");
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const d = JSON.parse(text) as MeetingNotes;
    return {
      summary: String(d.summary ?? "").slice(0, 8000),
      decisions: (d.decisions ?? []).map((x) => String(x).slice(0, 500)).slice(0, 50),
      actionItems: (d.actionItems ?? []).slice(0, 50).map((a) => ({ title: String(a.title ?? "").slice(0, 300), owner: String(a.owner ?? "").slice(0, 120), due: /^\d{4}-\d{2}-\d{2}$/.test(a.due ?? "") ? a.due : "" })).filter((a) => a.title),
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof SyntaxError) throw new HttpError(502, "The AI's notes couldn't be read. Try again.");
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The AI key on this server isn't valid.");
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service answered ${e.status ?? "an error"}: ${String(e.message).slice(0, 200)}`);
    throw e;
  }
}

const running = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Transcribe every finished audio recording of a meeting and write the notes.
 * Waits (up to 3 minutes) for Egress to finish writing the file.
 */
export async function generateNotes(meetingId: string) {
  if (running.has(meetingId)) return;
  running.add(meetingId);
  try {
    await db.meeting.update({ where: { id: meetingId }, data: { notesStatus: "processing", notesError: "" } });
    const { refreshRecordings } = await import("./recording");
    let recs = await db.meetRecording.findMany({ where: { meetingId, kind: "audio" }, orderBy: { startedAt: "asc" } });
    for (let i = 0; i < 36 && recs.some((r) => ["starting", "active", "ending"].includes(r.status)); i++) {
      const m = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
      await refreshRecordings(m);
      await sleep(5000);
      recs = await db.meetRecording.findMany({ where: { meetingId, kind: "audio" }, orderBy: { startedAt: "asc" } });
    }
    const done = recs.filter((r) => r.status === "complete" && fs.existsSync(recordingPath(r)));
    if (!done.length) throw new HttpError(409, recs.length ? "The notes recording didn't finish. Check that the recorder is running." : "Nothing was recorded for notes.");
    // Timestamped, diarized transcript (speakers named from the captions) and the Read-style report.
    const { ingestLive } = await import("./report");
    await ingestLive(meetingId, done);
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "Something went wrong while writing the notes.";
    if (!(e instanceof HttpError)) console.error("[meet] notes", e);
    await db.meeting.update({ where: { id: meetingId }, data: { notesStatus: "failed", notesError: msg } }).catch(() => null);
  } finally {
    running.delete(meetingId);
  }
}

/**
 * Write the meeting's report (and the notes inside it) and tell the host.
 * With timestamped segments or caption lines this is the Read-style report;
 * the plain-text path below is kept for a transcript with neither.
 */
export async function writeNotes(meetingId: string, transcript: string) {
  const { buildReport } = await import("./report");
  const [segs, caps] = await Promise.all([db.meetSegment.count({ where: { meetingId } }), db.meetCaption.count({ where: { meetingId } })]);
  if (!segs && !caps && !transcript.trim()) throw new HttpError(422, "There's no transcript to write notes from.");
  const r = await buildReport(meetingId);
  return { summary: r.summary, decisions: r.decisions, actionItems: r.actionItems.map((a) => ({ title: a.title, owner: a.owner, due: a.due })) } satisfies MeetingNotes;
}

/** The host asks for notes again (e.g. after a failure). */
export async function regenerate(me: Me | null, m: Meeting) {
  requireRecorder(me, m, "audio");
  if (m.transcript) {
    await db.meeting.update({ where: { id: m.id }, data: { notesStatus: "processing", notesError: "" } });
    void writeNotes(m.id, m.transcript).catch(async (e) => {
      await db.meeting.update({ where: { id: m.id }, data: { notesStatus: "failed", notesError: e instanceof HttpError ? e.message : "Something went wrong." } });
    });
  } else void generateNotes(m.id);
  return { ok: true };
}

function notesOf(m: Meeting): MeetingNotes {
  if (m.notesStatus !== "ready" || !m.notes) bad("The notes aren't ready yet.");
  return m.notes as unknown as MeetingNotes;
}

/** One click: action items become tasks (in a project I pick, or "Meeting follow-ups"). */
export async function notesToTasks(me: Me | null, m: Meeting, input: { projectId?: string; items?: number[] }) {
  const host = requireRecorder(me, m, "audio");
  if (!can(host, "tasks.open") || !can(host, "tasks.create")) throw new HttpError(403, "Your role can't create tasks.", { key: "tasks.create" });
  const notes = notesOf(m);
  const picked = (input.items?.length ? input.items : notes.actionItems.map((_, i) => i)).filter((i) => notes.actionItems[i]);
  if (!picked.length) bad("There are no action items to turn into tasks.");
  let projectId = input.projectId;
  if (!projectId) {
    const existing = await db.project.findFirst({ where: { ws: host.ws, name: "Meeting follow-ups", archived: false, members: { some: { userId: host.userId } } } });
    if (existing) projectId = existing.id;
    else {
      if (!can(host, "tasks.project.create")) bad("Pick a project for the tasks.");
      const memberIds = (await db.meetParticipant.findMany({ where: { meetingId: m.id, kind: "member", status: "admitted" } })).map((p) => p.userId!).filter(Boolean);
      const p = await db.project.create({
        data: { ws: host.ws, name: "Meeting follow-ups", color: "#0284c7", createdBy: host.userId, members: { create: [...new Set([host.userId, ...memberIds])].map((userId) => ({ userId })) } },
      });
      projectId = p.id;
    }
  }
  const project = await loadProject(host, projectId);
  const memberUsers = await db.user.findMany({ where: { id: { in: project.members.map((x) => x.userId) } } });
  const findOwner = (owner: string) => {
    const o = owner.trim().toLowerCase();
    if (!o) return null;
    const hit = memberUsers.find((u) => (u.name ?? "").toLowerCase() === o) ?? memberUsers.find((u) => (u.name ?? "").toLowerCase().split(/\s+/)[0] === o.split(/\s+/)[0]) ?? memberUsers.find((u) => u.email.toLowerCase().startsWith(o));
    if (!hit) return null;
    if (hit.id !== host.userId && !can(host, "tasks.assign")) return null;
    return hit.id;
  };
  const ids: string[] = [];
  for (const i of picked) {
    const a = notes.actionItems[i];
    const t = await createTask(host, {
      projectId: project.id,
      title: a.title,
      description: `From the meeting "${m.title}"${a.owner ? `\nOwner named in the meeting: ${a.owner}` : ""}`,
      assigneeId: findOwner(a.owner),
      due: a.due || null,
      labels: ["meeting"],
    });
    ids.push(t.id);
  }
  await db.meeting.update({ where: { id: m.id }, data: { notesTaskIds: [...m.notesTaskIds, ...ids] } });
  return { projectId: project.id, taskIds: ids };
}

export function notesText(m: Meeting, notes: MeetingNotes) {
  const lines = [`📝 Notes from "${m.title}"`, "", notes.summary];
  if (notes.decisions.length) lines.push("", "Decisions:", ...notes.decisions.map((d) => `• ${d}`));
  if (notes.actionItems.length)
    lines.push("", "Action items:", ...notes.actionItems.map((a) => `• ${a.title}${a.owner ? ` (${a.owner}` : ""}${a.owner && a.due ? `, by ${a.due})` : a.owner ? ")" : a.due ? ` (by ${a.due})` : ""}`));
  return lines.join("\n");
}

/** Post the notes in the meeting's chat thread (or a channel I pick). */
export async function postNotes(me: Me | null, m: Meeting, input: { channelId?: string }) {
  const host = requireRecorder(me, m, "audio");
  if (!can(host, "teamchat.open")) throw new HttpError(403, "Your role can't use Team Chat.", { key: "teamchat.open" });
  const notes = notesOf(m);
  const channelId = input.channelId || m.channelId;
  if (!channelId) bad("Pick a channel to post the notes in.");
  const inThread = channelId === m.channelId && m.messageId ? m.messageId : undefined;
  const msg = await postMessage(host, channelId, { body: notesText(m, notes), parentId: inThread });
  await db.meeting.update({ where: { id: m.id }, data: { notesPostedAt: new Date() } });
  return { messageId: msg.id, channelId, thread: inThread ?? null };
}
