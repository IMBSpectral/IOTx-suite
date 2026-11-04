/**
 * Message rate limits by plan: how many chat messages one person can send in
 * a workspace per window. Hitting it answers 429 with when to retry and, on
 * the free plan, an upgrade nudge. Counters live in memory and reset on their
 * own (FORGE_MSG_LIMIT_FREE / FORGE_MSG_LIMIT_PAID override the limits).
 */
const WINDOW_MS = 10 * 60_000;
const limitFor = (plan: string) =>
  plan === "FREE"
    ? Number(process.env.FORGE_MSG_LIMIT_FREE) || 30
    : Number(process.env.FORGE_MSG_LIMIT_PAID) || 200;

const g = globalThis as unknown as { __forgeMsgHits?: Map<string, number[]> };
const hits = (g.__forgeMsgHits ??= new Map());

export type RateLimited = {
  error: string;
  retryAfter: number;
  limit: number;
  upgrade: boolean;
};

/** The 429 body when this person is at the plan's limit, else null. Doesn't count anything. */
export function messageLimit(
  userId: string,
  workspaceId: string,
  plan: string,
  now = Date.now(),
): RateLimited | null {
  const key = `${workspaceId}:${userId}`;
  const list = (hits.get(key) ?? []).filter((t: number) => now - t < WINDOW_MS);
  const limit = limitFor(plan);
  if (list.length >= limit) {
    hits.set(key, list);
    const retryAfter = Math.max(
      1,
      Math.ceil((list[0] + WINDOW_MS - now) / 1000),
    );
    const free = plan === "FREE";
    return {
      error: free
        ? `You've sent ${limit} messages in 10 minutes, the most the Free plan allows. Wait a moment, or upgrade for higher limits.`
        : `You've sent ${limit} messages in 10 minutes. Wait a moment before sending more.`,
      retryAfter,
      limit,
      upgrade: free,
    };
  }
  hits.set(key, list);
  return null;
}

/** Count a message that was accepted (refused ones don't use up the limit). */
export function countMessage(userId: string, workspaceId: string, now = Date.now()) {
  const key = `${workspaceId}:${userId}`;
  hits.set(key, [...(hits.get(key) ?? []), now]);
}
