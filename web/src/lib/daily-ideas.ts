import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { listFiles } from "./repo";
import { consultProject } from "./kb";
import { meteredFetch } from "./ai-meter";

/**
 * Daily ideas: one build idea a day for a project, of the kind the best apps
 * of its sort have, ready to send to chat. Made with a small model on first
 * view each day, kept for the day, and free. Ideas can be hidden for a
 * project altogether.
 */

export type Idea = { title: string; why: string; prompt: string };
type Stored = { date: string; idea: Idea | null; dismissedDate?: string; off?: boolean; previous?: string[] };

const workspaceHeader = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceHeader ? { defaultHeaders: { "anthropic-workspace-id": workspaceHeader } } : {}), fetch: meteredFetch("Daily ideas") });
const MODEL = "claude-haiku-5-5";

const file = (projectId: string) => path.join(PROJECTS_ROOT, "_forge", "ideas", `${projectId.replace(/[^\w-]/g, "")}.json`);
const today = () => new Date().toISOString().slice(0, 10);

async function load(projectId: string): Promise<Stored | null> {
  const raw = await fs.readFile(file(projectId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as Stored) : null;
}
async function save(projectId: string, s: Stored) {
  await fs.mkdir(path.dirname(file(projectId)), { recursive: true });
  await fs.writeFile(file(projectId), JSON.stringify(s, null, 2));
}

/** Today's idea, made if needed; null when ideas are off or dismissed for today. */
export async function dailyIdea(projectId: string, userId?: string | null): Promise<{ idea: Idea | null; off: boolean }> {
  const s = await load(projectId);
  if (s?.off) return { idea: null, off: true };
  if (s?.dismissedDate === today()) return { idea: null, off: false };
  if (s?.date === today()) return { idea: s.idea, off: false };

  const p = await db.project.findUnique({ where: { id: projectId }, select: { name: true, description: true } });
  if (!p) return { idea: null, off: false };
  const files = (await listFiles(projectId)).filter((f) => /^src\/(pages|components|routes)\//.test(f)).slice(0, 60);
  const asks = await db.message.findMany({
    where: { projectId, role: "USER" },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { content: true },
  });
  const previous = s?.previous ?? [];
  // Knowledge first, as the person viewing; the idea is shown to everyone on the project, so only articles any member may read.
  const company = await consultProject(projectId, userId, asks.map((a) => a.content.slice(0, 100)).join(" "), { context: `${p.name} ${p.description ?? ""}`, cite: false, shared: true });
  const prompt =
    `An app called "${p.name}"${p.description ? ` (${p.description})` : ""} is being built in an AI app builder.\n` +
    `Its pages and components: ${files.join(", ") || "(just started)"}.\n` +
    `Recent requests from its builder:\n${asks.map((a) => `- ${a.content.slice(0, 200)}`).join("\n") || "(none)"}\n` +
    (previous.length ? `Ideas already suggested on earlier days (don't repeat): ${previous.join("; ")}.\n` : "") +
    `\nSuggest ONE next feature that the best apps of this kind have and this one doesn't yet. ` +
    `Make it concrete and buildable in one step. Answer with JSON only: ` +
    `{"title": "<4-8 words>", "why": "<one sentence on why users want it>", "prompt": "<the instruction to send to the builder, 1-3 sentences>"}` +
    (company.context ? `\n\n${company.context}` : "");

  let idea: Idea | null = null;
  try {
    const res = await client.messages.create({ model: MODEL, max_tokens: 2000, messages: [{ role: "user", content: prompt }] });
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<Idea>;
    if (json.title && json.prompt) {
      idea = { title: String(json.title).slice(0, 80), why: String(json.why ?? "").slice(0, 240), prompt: String(json.prompt).slice(0, 600) };
    }
  } catch {
    // No idea today rather than a broken one; tomorrow tries again.
  }
  // A failed attempt isn't kept, so the next view tries again.
  if (idea) await save(projectId, { date: today(), idea, previous: [...(idea ? [idea.title] : []), ...previous].slice(0, 20) });
  return { idea, off: false };
}

/** Hide today's idea, or turn ideas off (or back on) for the project. */
export async function setIdeas(projectId: string, action: "dismiss" | "off" | "on") {
  const s = (await load(projectId)) ?? { date: "", idea: null };
  if (action === "dismiss") s.dismissedDate = today();
  if (action === "off") s.off = true;
  if (action === "on") s.off = false;
  await save(projectId, s);
}
