import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "./auth";
import { consultKnowledge } from "./kb";
import { meteredFetch } from "./ai-meter";

/** "Summarize this thread" with Claude Haiku 5.5, after checking the company knowledge base (as the reader). */
let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ fetch: meteredFetch("Chat summaries") }));

export async function summarizeThread(me: { userId: string; ws: string }, lines: { who: string; when: string; text: string }[], channel: string, mode: "thread" | "channel" = "thread") {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "AI summaries aren't set up on this server.");
  const transcript = lines.map((l) => `[${l.when}] ${l.who}: ${l.text}`).join("\n");
  // Knowledge first: the thread's opening (or, for a catch-up, the latest messages) looked up in the company's articles.
  const about = (mode === "channel" ? lines.slice(-6) : lines.slice(0, 2)).map((l) => l.text.slice(0, 200)).join(" ");
  const company = await consultKnowledge(me, about, { context: channel.replace(/^#/, ""), cite: false });
  const rules = company.context
    ? `\n\n${company.context}\nUse it only to name company terms, processes and policies correctly and to point out where the chat goes against them; the summary itself is of what was said.`
    : "";
  try {
    const r = await anthropic().messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 2000,
      system:
        (mode === "channel"
          ? "You help someone catch up on a team chat channel they missed. Group the conversation by topic. For each topic give one line, then brief bullet points for decisions, open questions and action items with owners if named. Put anything that asks for the reader's attention first. Use only what is in the messages."
          : "You summarize team chat threads for busy colleagues. Write a short summary: the topic in one sentence, then the key points, decisions and open questions as brief bullet points, and any action items with owners if named. Use only what is in the thread.") + rules,
      messages: [{ role: "user", content: `${mode === "channel" ? "Recent messages" : "Thread"} in ${channel}:\n\n${transcript}` }],
    });
    if (r.stop_reason === "refusal") throw new HttpError(422, "The AI declined to summarize this thread.");
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    if (!text) throw new HttpError(502, "The AI returned an empty summary. Try again.");
    return text;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The AI key on this server isn't valid.");
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service answered ${e.status ?? "an error"}.`);
    throw e;
  }
}
