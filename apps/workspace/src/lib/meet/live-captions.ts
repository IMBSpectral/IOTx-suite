import type { Meeting } from "@prisma/client";
import { db } from "../db";
import { HttpError, type Me } from "../auth";
import { bad } from "../http";
import { requireIn } from "./meetings";

/**
 * Server captions for browsers without speech recognition (Firefox, Safari
 * on some systems). The speaker's browser records short chunks of its own
 * microphone (only while captions are on, the mic is on and someone is
 * talking) and posts each one here; OpenAI's transcription API turns it into
 * text, which is saved to the transcript like any other caption line. The
 * browser then shows it and sends it to the room the usual way.
 *
 * Not available in end-to-end encrypted meetings. The audio isn't kept.
 */

const OPENAI_URL = (process.env.MEET_OPENAI_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.MEET_CAPTION_MODEL ?? "gpt-4o-mini-transcribe";
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|wave|m4a|x-m4a|aac)(;|$)/i;
const EXT: Record<string, string> = { webm: "webm", ogg: "ogg", mp4: "mp4", m4a: "m4a", "x-m4a": "m4a", aac: "m4a", mpeg: "mp3", mp3: "mp3", wav: "wav", "x-wav": "wav", wave: "wav" };

const g = globalThis as unknown as { __meetSttRate?: Map<string, number[]> };
const rate: Map<string, number[]> = (g.__meetSttRate ??= new Map());

// Words the model tends to "hear" in near-silence; a chunk with only these is dropped.
const NOISE = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|…)$/i;

export const serverCaptionsAvailable = () => !!process.env.OPENAI_API_KEY;

async function transcribe(file: File, language: string, model = MODEL): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new HttpError(503, "Server captions aren't set up on this server (OPENAI_API_KEY is missing).");
  const sub = (/^audio\/([\w-]+)/i.exec(file.type)?.[1] ?? "webm").toLowerCase();
  const form = new FormData();
  form.append("file", new Blob([await file.arrayBuffer()], { type: file.type.split(";")[0] }), `chunk.${EXT[sub] ?? "webm"}`);
  form.append("model", model);
  form.append("response_format", "json");
  if (language) form.append("language", language);
  const r = await fetch(`${OPENAI_URL}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!r) throw new HttpError(504, "Captions took too long.");
  if (!r.ok) {
    const why = r.status === 400 || r.status === 404 ? await r.text().catch(() => "") : "";
    // A model this account can't use: fall back to whisper-1.
    if (model !== "whisper-1" && (r.status === 404 || /model/i.test(why))) return transcribe(file, language, "whisper-1");
    if (r.status === 400) return ""; // An unreadable or empty chunk: skip it.
    throw new HttpError(502, `Captions failed (${r.status}).`);
  }
  const d = (await r.json().catch(() => ({}))) as { text?: string };
  return String(d.text ?? "").replace(/\s+/g, " ").trim();
}

/** POST /transcribe: one chunk of the caller's own microphone -> a saved caption line. */
export async function transcribeChunk(me: Me | null, m: Meeting, guestKey: string | null, file: File | null) {
  const c = await requireIn(me, m, guestKey);
  if (m.e2ee) throw new HttpError(409, "Captions are off in end-to-end encrypted meetings.");
  if (!m.captions) throw new HttpError(409, "Captions are off in this meeting.");
  if (m.endedAt) bad("This meeting has ended.");
  if (!file || !file.size) bad("Send an audio chunk.");
  if (file.size > MAX_BYTES) bad("Audio chunks can be up to 2 MB.");
  if (!TYPES.test(file.type || "")) bad("Send audio (webm, ogg, mp4 or wav).");
  const now = Date.now();
  const hits = (rate.get(c.identity) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= 30) throw new HttpError(429, "Captions are busy. Wait a moment.");
  rate.set(c.identity, [...hits, now]);
  const text = (await transcribe(file, m.captionLang.split("-")[0])).slice(0, 500);
  if (!text || NOISE.test(text)) return { text: "", id: null };
  const row = await db.meetCaption.create({ data: { meetingId: m.id, identity: c.identity, name: c.name, text } });
  return { text, id: row.id, at: row.at };
}
