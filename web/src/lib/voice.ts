import fs from "node:fs/promises";
import { getBrand } from "./brand";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";

/**
 * Voice mode: a live, two-way conversation with Forge through OpenAI's
 * Realtime API. The server only mints a short-lived client secret, so the
 * real API key never reaches the browser; audio flows browser ↔ OpenAI over
 * WebRTC. Usage is capped per person per day.
 *
 * Knowledge first: the session doesn't answer on its own when someone stops
 * talking. The browser waits for the transcript, has the suite look it up in
 * the company knowledge base (action "kb" on the voice route), adds the
 * passages to the conversation, and only then asks for the reply.
 */

export const VOICE_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
export const VOICE_DAILY_SECONDS = Number(process.env.VOICE_DAILY_SECONDS ?? 15 * 60);

export class VoiceError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

const usageFile = (userId: string) => path.join(PROJECTS_ROOT, "_voice", `${userId.replace(/[^\w-]/g, "")}.json`);
const today = () => new Date().toISOString().slice(0, 10);

export async function voiceUsedToday(userId: string) {
  const raw = await fs.readFile(usageFile(userId), "utf8").catch(() => null);
  const u = raw ? (JSON.parse(raw) as { day: string; seconds: number }) : null;
  return u && u.day === today() ? u.seconds : 0;
}

export async function addVoiceSeconds(userId: string, seconds: number) {
  const used = await voiceUsedToday(userId);
  const next = used + Math.max(0, Math.min(seconds, 3 * 60 * 60));
  await fs.mkdir(path.dirname(usageFile(userId)), { recursive: true });
  await fs.writeFile(usageFile(userId), JSON.stringify({ day: today(), seconds: Math.round(next) }));
  return next;
}

const INSTRUCTIONS = (projectName: string, b = getBrand().shortName) =>
  `You are ${b}'s voice assistant for the project "${projectName}", an app being built with ${b}, an AI app builder.
Talk naturally and keep answers short — this is a spoken conversation.
When the user asks for a change to the app, call send_to_chat with a clear, complete instruction for ${b}'s build agent (mode "build"), then say briefly that you've sent it. For questions about the app that need looking at the code, use mode "ask". If they ask to tweak the element they have selected, use mode "quick_edit".
Before each reply you get a "Company knowledge" note looked up for what they just said: follow it over general knowledge, and call search_company_knowledge when you need more. Never guess the company's own facts (prices, policies, processes).
Don't read code aloud.`;

/** Mint a short-lived client secret for one voice session. */
export async function createVoiceSession(opts: { userId: string; projectName: string }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new VoiceError("Voice needs an OpenAI API key on the server.", 503);
  const used = await voiceUsedToday(opts.userId);
  if (used >= VOICE_DAILY_SECONDS) {
    throw new VoiceError("You've reached your voice time limit for today. It resets at midnight UTC. Buying credits does not remove the limit.", 429);
  }
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 120 },
      session: {
        type: "realtime",
        model: VOICE_MODEL,
        instructions: INSTRUCTIONS(opts.projectName),
        audio: {
          // The browser asks for each reply itself, after the knowledge base lookup.
          input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad", create_response: false } },
          output: { voice: "marin" },
        },
        tools: [
          {
            type: "function",
            name: "send_to_chat",
            description: `Send an instruction to ${getBrand().shortName}'s build agent in this project's chat.`,
            parameters: {
              type: "object",
              properties: {
                text: { type: "string", description: "The complete instruction" },
                mode: { type: "string", enum: ["build", "ask", "quick_edit"] },
              },
              required: ["text", "mode"],
            },
          },
          {
            type: "function",
            name: "search_company_knowledge",
            description: "Search the company's knowledge base (SOPs, policies, processes, products and prices, customers, glossary) for more than the note you were given.",
            parameters: {
              type: "object",
              properties: { query: { type: "string", description: "What you need to know, in plain words" } },
              required: ["query"],
            },
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { value?: string; error?: { message?: string } };
  if (!res.ok || !body.value) {
    throw new VoiceError(`Couldn't start voice: ${body.error?.message ?? `OpenAI answered HTTP ${res.status}`}`, 502);
  }
  return {
    clientSecret: body.value,
    model: VOICE_MODEL,
    secondsLeft: Math.max(0, VOICE_DAILY_SECONDS - used),
  };
}
