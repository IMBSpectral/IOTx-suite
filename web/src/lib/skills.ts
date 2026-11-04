import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";

/**
 * Skills: reusable workflows for the agent, shared across a workspace, or
 * personal ones that follow a user into every project ("owner" is then
 * "user:<id>"). A
 * skill is a name and a set of instructions; starting a message with
 * /skill-name hands those instructions to the agent for that turn ("Reuse
 * workflows with skills"). They apply to building turns, not Ask mode.
 */

export type Skill = {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  createdBy: string;
  updatedAt: string;
};

export class SkillError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Built-in slash commands take precedence, so skills can't shadow them.
const RESERVED = new Set(["build", "plan", "ask", "design", "goal", "clear", "help", "skills"]);
const file = (owner: string) => path.join(PROJECTS_ROOT, "_forge", "skills", `${owner.replace(/[^w-]/g, "-")}.json`);
export const personalOwner = (userId: string) => `user:${userId}`;

export async function listSkills(workspaceId: string): Promise<Skill[]> {
  const raw = await fs.readFile(file(workspaceId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as Skill[]) : [];
}

async function save(workspaceId: string, skills: Skill[]) {
  await fs.mkdir(path.dirname(file(workspaceId)), { recursive: true });
  await fs.writeFile(file(workspaceId), JSON.stringify(skills, null, 2));
}

function clean(input: Partial<Skill>) {
  const name = (input.name ?? "").trim().toLowerCase();
  if (!NAME.test(name)) throw new SkillError("Use 2–40 lowercase letters, numbers or dashes for the name, like seo-pass.");
  if (RESERVED.has(name)) throw new SkillError(`/${name} is already a command.`);
  const instructions = (input.instructions ?? "").trim();
  if (instructions.length < 10) throw new SkillError("Write the instructions the agent should follow.");
  if (instructions.length > 8000) throw new SkillError("Keep instructions under 8,000 characters.");
  return {
    name,
    title: (input.title ?? "").trim().slice(0, 80) || name,
    description: (input.description ?? "").trim().slice(0, 200),
    instructions,
  };
}

export async function saveSkill(workspaceId: string, userId: string, input: Partial<Skill>) {
  const skills = await listSkills(workspaceId);
  const c = clean(input);
  const existing = input.id ? skills.find((s) => s.id === input.id) : undefined;
  if (input.id && !existing) throw new SkillError("Skill not found.");
  if (skills.some((s) => s.name === c.name && s.id !== existing?.id)) throw new SkillError(`There is already a /${c.name} skill.`);
  if (!existing && skills.length >= 100) throw new SkillError("A workspace can have up to 100 skills.");
  const skill: Skill = { id: existing?.id ?? crypto.randomUUID(), createdBy: existing?.createdBy ?? userId, ...c, updatedAt: new Date().toISOString() };
  await save(workspaceId, existing ? skills.map((s) => (s.id === skill.id ? skill : s)) : [...skills, skill]);
  return skill;
}

export async function deleteSkill(workspaceId: string, id: string) {
  const skills = await listSkills(workspaceId);
  if (!skills.some((s) => s.id === id)) throw new SkillError("Skill not found.");
  await save(workspaceId, skills.filter((s) => s.id !== id));
}

/**
 * If a message starts with /skill-name, the skill and the rest of the
 * message; otherwise null. "/seo-pass for the pricing page" → seo-pass.
 */
export async function matchSkill(workspaceId: string, message: string, userId?: string | null) {
  const m = /^\/([a-z0-9][a-z0-9-]{1,39})(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (!m) return null;
  // The workspace's skill wins over a personal one of the same name.
  const skill =
    (await listSkills(workspaceId)).find((s) => s.name === m[1]) ??
    (userId ? (await listSkills(personalOwner(userId))).find((s) => s.name === m[1]) : undefined);
  return skill ? { skill, rest: (m[2] ?? "").trim() } : null;
}

/** The instruction the agent sees for a skill turn. */
export function skillInstruction(skill: Skill, rest: string) {
  return (
    `Follow the skill "${skill.title}" (/${skill.name}).\n\n<skill>\n${skill.instructions}\n</skill>\n\n` +
    (rest ? `The user added: ${rest}` : "Apply it to this project.")
  );
}
