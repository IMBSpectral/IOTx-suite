import { db } from "./db";
import { ensureWorker } from "./worker";

/** Most turns a goal run takes, counting the first. */
export const GOAL_TURNS = 5;

/**
 * Queue an agent turn in a project, as if the user had sent the message:
 * the user's message, an empty reply for the agent to fill, and its build.
 * Used by automations, the workspace assistant and goal runs.
 */
export async function enqueueTurn(opts: {
  projectId: string;
  userId: string;
  content: string;
  mode?: "build" | "ask" | "plan" | "design";
  /** Label on the user message, e.g. "goal_run" for a goal's follow-up turn. */
  messageMode?: string;
  goalRemaining?: number | null;
}) {
  const mode = opts.mode ?? "build";
  const label = opts.messageMode ?? mode;
  const userMessage = await db.message.create({
    data: { projectId: opts.projectId, userId: opts.userId, role: "USER", content: opts.content, mode: label },
  });
  const reply = await db.message.create({ data: { projectId: opts.projectId, role: "ASSISTANT", content: "", mode: label } });
  const build = await db.build.create({
    data: { projectId: opts.projectId, messageId: reply.id, status: "QUEUED", mode, goalRemaining: opts.goalRemaining ?? null },
  });
  ensureWorker();
  return { buildId: build.id, userMessageId: userMessage.id, messageId: reply.id };
}
