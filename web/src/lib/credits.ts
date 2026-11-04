import { db } from "./db";
import { CreditReason } from "@prisma/client";
import { refreshCredits } from "./billing-cycle";
import { platformSettings } from "./platform-settings";

/**
 * Free build hour: for an hour from the start a platform admin sets in
 * Settings → Platform (or FORGE_FREE_BUILD_HOUR, an ISO time), builds cost no
 * credits and run even on an empty balance.
 */
export function freeBuildHour(now = new Date()): { endsAt: Date } | null {
  const set = platformSettings().freeBuildHourStart;
  const raw = set === undefined ? process.env.FORGE_FREE_BUILD_HOUR : set;
  if (!raw) return null;
  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 60 * 60_000);
  return now >= start && now < end ? { endsAt: end } : null;
}

/**
 * Weighted tokens per credit. Output costs 5x input, so a credit is about
 * $0.12 of model cost at Opus 5.5 prices ($4 / $20 per MTok). That makes a
 * simple change 1 credit and a big build several, on Lovable's scale (about
 * $0.25 a credit retail). FORGE_TOKENS_PER_CREDIT overrides it.
 */
const TOKENS_PER_CREDIT = Number(process.env.FORGE_TOKENS_PER_CREDIT) || 30_000;

/** A build costs credits. Charged on completion against measured tokens. */
export function creditsForUsage(inputTokens: number, outputTokens: number) {
  // Floor of 1 so every build costs something.
  return Math.max(1, Math.ceil((inputTokens + outputTokens * 5) / TOKENS_PER_CREDIT));
}

export class InsufficientCredits extends Error {
  constructor(public readonly balance: number) {
    super("Insufficient credits");
    this.name = "InsufficientCredits";
  }
}

export type Category = "build" | "chat" | "media" | "cloud";

export class SpendLimitReached extends Error {
  constructor(
    public readonly scope: "workspace" | "user" | "project",
    public readonly limit: number,
    public readonly spent: number,
  ) {
    super("Spending limit reached");
    this.name = "SpendLimitReached";
  }
}

export const monthStart = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1);

/** Credits spent this calendar month, optionally by one member or one project. */
export async function spentThisMonth(workspaceId: string, by: { userId?: string; projectId?: string } = {}) {
  const r = await db.creditEntry.aggregate({
    where: { workspaceId, delta: { lt: 0 }, reason: { not: "EXPIRED" }, createdAt: { gte: monthStart() }, ...by },
    _sum: { delta: true },
  });
  return Math.abs(r._sum.delta ?? 0);
}

/**
 * Check before starting a build; cheap guard, not a reservation. Besides the
 * balance, the workspace, the member and the project may each have a monthly
 * spending limit.
 */
export async function assertCredits(workspaceId: string, who: { userId?: string; projectId?: string } = {}) {
  await refreshCredits(workspaceId);
  const ws = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { creditBalance: true, monthlySpendLimit: true },
  });
  if (ws.creditBalance <= 0 && !freeBuildHour()) throw new InsufficientCredits(ws.creditBalance);

  if (ws.monthlySpendLimit != null) {
    const spent = await spentThisMonth(workspaceId);
    if (spent >= ws.monthlySpendLimit) throw new SpendLimitReached("workspace", ws.monthlySpendLimit, spent);
  }
  const limits = await db.spendLimit.findMany({
    where: {
      workspaceId,
      OR: [
        ...(who.userId ? [{ scope: "user", targetId: who.userId }] : []),
        ...(who.projectId ? [{ scope: "project", targetId: who.projectId }] : []),
      ],
    },
  });
  for (const l of limits) {
    const spent = await spentThisMonth(workspaceId, l.scope === "user" ? { userId: l.targetId } : { projectId: l.targetId });
    if (spent >= l.monthly) throw new SpendLimitReached(l.scope as "user" | "project", l.monthly, spent);
  }
  return ws.creditBalance;
}

/**
 * Debit atomically, once per message.
 *
 * Two properties matter here. The charge is **idempotent**: a build that is
 * retried after its worker died must not bill twice, so an existing ledger
 * row for the same message short-circuits. And the balance is **floored at
 * zero**: a single build can cost more than the balance it started with, and
 * a negative balance is meaningless as a quantity of prepaid credit. The
 * ledger still records the full amount, so usage reporting stays truthful
 * even when the charge is clamped.
 */
export async function charge(
  workspaceId: string,
  amount: number,
  reason: CreditReason,
  messageId?: string,
  meta: { category?: Category; userId?: string | null; projectId?: string } = {},
) {
  if (amount <= 0) return;

  if (messageId) {
    // One row per message and category: a turn's build cost and its media cost are separate.
    const already = await db.creditEntry.findFirst({
      where: { messageId, reason, category: meta.category ?? null },
      select: { id: true },
    });
    if (already) return;
  }

  // Free build hour: builds still appear in usage, at no cost.
  const free = meta.category === "build" && freeBuildHour();

  await db.$transaction(async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { creditBalance: true, rolloverCredits: true, outOfCreditsAt: true },
    });
    const debit = free ? 0 : Math.min(amount, Math.max(0, ws.creditBalance));
    const empty = ws.creditBalance - debit <= 0;
    await tx.workspace.update({
      where: { id: workspaceId },
      data: {
        creditBalance: { decrement: debit },
        // Rollover credits expire soonest, so they're spent first.
        rolloverCredits: { decrement: Math.min(debit, ws.rolloverCredits) },
        outOfCreditsAt: empty ? (ws.outOfCreditsAt ?? new Date()) : null,
      },
    });
    await tx.creditEntry.create({
      data: {
        workspaceId,
        delta: free ? 0 : -amount,
        reason,
        messageId,
        category: free ? "build_free" : meta.category,
        userId: meta.userId ?? undefined,
        projectId: meta.projectId,
      },
    });
  });
  await autoTopUp(workspaceId);
}

/** Auto top-up: when the balance falls below a floor, add the configured amount. */
const AUTO_TOPUP_FLOOR = 10;
async function autoTopUp(workspaceId: string) {
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { autoTopupOn: true, autoTopupLimit: true, creditBalance: true },
  });
  if (!ws?.autoTopupOn || ws.autoTopupLimit <= 0 || ws.creditBalance >= AUTO_TOPUP_FLOOR) return;
  await grant(workspaceId, ws.autoTopupLimit, "TOPUP");
}

export async function grant(
  workspaceId: string,
  amount: number,
  reason: CreditReason,
) {
  await db.$transaction([
    db.workspace.update({
      where: { id: workspaceId },
      data: { creditBalance: { increment: amount }, outOfCreditsAt: null },
    }),
    db.creditEntry.create({ data: { workspaceId, delta: amount, reason } }),
  ]);
}

/** Ask/Plan turns a person gets free each day, counted from midnight UTC. */
export const FREE_DAILY_CHATS = 10;

const utcMidnight = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

export async function freeChatsUsedToday(workspaceId: string, userId: string) {
  return db.creditEntry.count({ where: { workspaceId, userId, category: "chat_free", createdAt: { gte: utcMidnight() } } });
}

/**
 * Spend one free chat if any are left today. Recorded as a zero-credit
 * ledger row, once per message, so the allowance is counted exactly.
 */
export async function spendFreeChat(workspaceId: string, userId: string, projectId?: string | null, messageId?: string | null) {
  if (messageId && (await db.creditEntry.findFirst({ where: { messageId, category: "chat_free" } }))) return true;
  if ((await freeChatsUsedToday(workspaceId, userId)) >= FREE_DAILY_CHATS) return false;
  await db.creditEntry.create({
    data: { workspaceId, delta: 0, reason: "GENERATION", messageId: messageId ?? undefined, category: "chat_free", userId, projectId: projectId || undefined },
  });
  return true;
}
