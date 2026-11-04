import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { meteredFetch } from "./ai-meter";

/**
 * Memory management. A project's memories are the "- fact" lines in its
 * Knowledge (the rest is standing instructions); memory can be switched off
 * per project. Each person also has a memory that follows them across
 * projects. "Tidy up" consolidates a project's memories with a small model,
 * keeping the previous version for undo.
 */

type ProjectMem = { enabled: boolean; undo?: string | null; tidiedAt?: string | null };
const dir = path.join(PROJECTS_ROOT, "_forge", "memory");
const projectFile = (id: string) => path.join(dir, `p-${id.replace(/[^\w-]/g, "")}.json`);
const userFile = (id: string) => path.join(dir, `u-${id.replace(/[^\w-]/g, "")}.json`);
const isFact = (l: string) => l.trim().startsWith("- ");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
}
async function writeJson(file: string, v: unknown) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(v, null, 2));
}

export class MemoryError extends Error {}

export const projectMemory = (projectId: string) => readJson<ProjectMem>(projectFile(projectId), { enabled: true });

export async function setMemoryEnabled(projectId: string, enabled: boolean) {
  await writeJson(projectFile(projectId), { ...(await projectMemory(projectId)), enabled });
}

export async function userMemories(userId: string) {
  return (await readJson<{ facts: string[] }>(userFile(userId), { facts: [] })).facts;
}

export async function addUserMemory(userId: string, fact: string) {
  const f = fact.trim().replace(/^- /, "").slice(0, 300);
  if (f.length < 3) throw new MemoryError("Write the memory as a short sentence.");
  const facts = await userMemories(userId);
  if (facts.includes(f)) return facts;
  if (facts.length >= 50) throw new MemoryError("Up to 50 personal memories. Delete some first.");
  const next = [...facts, f];
  await writeJson(userFile(userId), { facts: next });
  return next;
}

export async function deleteUserMemory(userId: string, fact: string) {
  const next = (await userMemories(userId)).filter((f) => f !== fact);
  await writeJson(userFile(userId), { facts: next });
  return next;
}

/** Project memories (the fact lines of Knowledge). */
export async function projectFacts(projectId: string) {
  const k = await db.knowledge.findUnique({ where: { projectId } });
  return (k?.content ?? "").split("\n").filter(isFact).map((l) => l.trim().slice(2));
}

async function writeFacts(projectId: string, facts: string[]) {
  const k = await db.knowledge.findUnique({ where: { projectId } });
  const instructions = (k?.content ?? "").split("\n").filter((l) => !isFact(l)).join("\n").trim();
  const content = [instructions, facts.map((f) => `- ${f}`).join("\n")].filter(Boolean).join("\n\n");
  await db.knowledge.upsert({ where: { projectId }, create: { projectId, content }, update: { content } });
}

export async function addProjectMemory(projectId: string, fact: string) {
  const f = fact.trim().replace(/^- /, "").slice(0, 300);
  if (f.length < 3) throw new MemoryError("Write the memory as a short sentence.");
  const facts = await projectFacts(projectId);
  if (!facts.includes(f)) await writeFacts(projectId, [...facts, f]);
}

export async function deleteProjectMemory(projectId: string, fact: string) {
  await writeFacts(projectId, (await projectFacts(projectId)).filter((f) => f !== fact));
}

/** The knowledge the agent gets each turn: memories only while on, plus the person's own memory. */
export async function effectiveKnowledge(projectId: string, knowledge: string | null, userId: string | null | undefined) {
  const mem = await projectMemory(projectId);
  let text = knowledge ?? "";
  if (!mem.enabled) text = text.split("\n").filter((l) => !isFact(l)).join("\n").trim();
  const mine = userId ? await userMemories(userId) : [];
  if (mine.length) {
    text = `${text.trim()}\n\nAbout the person you're working with (their own memory, from all their projects):\n${mine.map((f) => `- ${f}`).join("\n")}`.trim();
  }
  return text || null;
}

/** What's followed in every message for this person in this project. */
export async function followedSummary(projectId: string, userId: string) {
  const k = await db.knowledge.findUnique({ where: { projectId } });
  const mem = await projectMemory(projectId);
  const instructions = (k?.content ?? "").split("\n").filter((l) => !isFact(l)).join("\n").trim();
  return {
    instructions,
    projectMemories: mem.enabled ? await projectFacts(projectId) : [],
    memoryEnabled: mem.enabled,
    personalMemories: await userMemories(userId),
    canUndoTidy: !!mem.undo,
    tidiedAt: mem.tidiedAt ?? null,
  };
}

const workspaceHeader = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceHeader ? { defaultHeaders: { "anthropic-workspace-id": workspaceHeader } } : {}), fetch: meteredFetch("Builder memory") });

/** Consolidate a project's memories: merge duplicates, drop ones later facts replaced. Undo keeps the old list. */
export async function tidyMemories(projectId: string) {
  const facts = await projectFacts(projectId);
  if (facts.length < 2) throw new MemoryError("There's nothing to tidy yet.");
  const res = await client.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 3000,
    messages: [
      {
        role: "user",
        content:
          `These are remembered facts about a software project, oldest first. Merge duplicates, drop facts that later ones ` +
          `replace or contradict, keep every distinct fact, and keep each one a short sentence. Don't add anything new.\n\n` +
          facts.map((f) => `- ${f}`).join("\n") +
          `\n\nAnswer with the consolidated list only, one "- " line per fact.`,
      },
    ],
  });
  const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const next = text.split("\n").filter(isFact).map((l) => l.trim().slice(2).slice(0, 300)).filter(Boolean);
  if (!next.length || next.length > facts.length) throw new MemoryError("Tidying didn't produce a usable list; nothing changed.");
  const k = await db.knowledge.findUnique({ where: { projectId } });
  await writeJson(projectFile(projectId), { ...(await projectMemory(projectId)), undo: k?.content ?? "", tidiedAt: new Date().toISOString() });
  await writeFacts(projectId, next);
  return { before: facts.length, after: next.length };
}

export async function undoTidy(projectId: string) {
  const mem = await projectMemory(projectId);
  if (mem.undo == null) throw new MemoryError("There's no tidy-up to undo.");
  await db.knowledge.upsert({ where: { projectId }, create: { projectId, content: mem.undo }, update: { content: mem.undo } });
  await writeJson(projectFile(projectId), { ...mem, undo: null });
}
