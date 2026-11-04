import { db } from "./db";

/**
 * Billing periods. Each workspace's monthly credits refill when its period
 * ends. On paid plans the unused part of the month's credits rolls over for
 * one more period and then expires; on the free plan it expires at once.
 * Credits bought or earned (top-ups, referrals) never expire. Rollover credits
 * are spent first, since they expire soonest.
 */

/** Days a workspace can sit at zero credits before its live backends pause. */
export const OUT_OF_CREDITS_GRACE_DAYS = 7;

export function addMonth(d: Date) {
  const n = new Date(d);
  const day = n.getUTCDate();
  n.setUTCDate(1);
  n.setUTCMonth(n.getUTCMonth() + 1);
  // 31 Jan → 28/29 Feb, not 3 Mar.
  const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
  n.setUTCDate(Math.min(day, last));
  return n;
}

/** Roll every elapsed period forward: expire, roll over, refill. Safe to call often. */
export async function refreshCredits(workspaceId: string, now = new Date()) {
  for (let i = 0; i < 24; i++) {
    const done = await db.$transaction(async (tx) => {
      const ws = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true, creditBalance: true, monthlyCredits: true, periodStart: true, rolloverCredits: true },
      });
      if (!ws) return true;
      const nextStart = addMonth(ws.periodStart);
      if (now < nextStart) return true;

      let balance = ws.creditBalance;
      const expire = async (amount: number) => {
        if (amount <= 0) return;
        balance -= amount;
        await tx.creditEntry.create({ data: { workspaceId, delta: -amount, reason: "EXPIRED", createdAt: nextStart } });
      };
      // Last period's rollover had its one extra period.
      await expire(Math.min(ws.rolloverCredits, balance));
      // This period's unused monthly credits.
      const unused = Math.min(balance, ws.monthlyCredits);
      let rollover = 0;
      if (ws.plan === "FREE") await expire(unused);
      else rollover = unused;

      balance += ws.monthlyCredits;
      await tx.creditEntry.create({ data: { workspaceId, delta: ws.monthlyCredits, reason: "MONTHLY_GRANT", createdAt: nextStart } });
      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          creditBalance: balance,
          periodStart: nextStart,
          rolloverCredits: rollover,
          rolloverExpiresAt: rollover > 0 ? addMonth(nextStart) : null,
          outOfCreditsAt: balance > 0 ? null : undefined,
        },
      });
      return false;
    });
    if (done) return;
  }
}

/** Refill every workspace whose period has ended (the hourly housekeeping pass). */
export async function refreshAllCredits(now = new Date()) {
  const due = await db.workspace.findMany({ select: { id: true, periodStart: true } });
  for (const w of due) if (now >= addMonth(w.periodStart)) await refreshCredits(w.id, now);
}

export type CreditSummary = {
  balance: number;
  rollover: number;
  rolloverExpiresAt: string | null;
  /** "today" / "in about an hour" etc. when rollover credits expire within a day. */
  expiryNudge: string | null;
  nextRefill: string;
  outOfCreditsAt: string | null;
  /** When live backends pause if no credits are added, and whether that has passed. */
  pausesAt: string | null;
  paused: boolean;
};

export function expiryNudge(amount: number, expiresAt: Date | null, now = new Date()): string | null {
  if (!expiresAt || amount <= 0) return null;
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0 || ms > 24 * 3600_000) return null;
  const n = `${amount} credit${amount === 1 ? "" : "s"}`;
  if (ms <= 90 * 60_000) return `${n} expire in about an hour`;
  return `${n} expire today`;
}

export async function creditSummary(workspaceId: string, now = new Date()): Promise<CreditSummary> {
  await refreshCredits(workspaceId, now);
  const ws = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { creditBalance: true, rolloverCredits: true, rolloverExpiresAt: true, periodStart: true, outOfCreditsAt: true },
  });
  const rollover = Math.min(ws.rolloverCredits, ws.creditBalance);
  const pausesAt = ws.creditBalance <= 0 && ws.outOfCreditsAt ? new Date(ws.outOfCreditsAt.getTime() + OUT_OF_CREDITS_GRACE_DAYS * 86_400_000) : null;
  return {
    balance: ws.creditBalance,
    rollover,
    rolloverExpiresAt: ws.rolloverExpiresAt?.toISOString() ?? null,
    expiryNudge: expiryNudge(rollover, ws.rolloverExpiresAt, now),
    nextRefill: addMonth(ws.periodStart).toISOString(),
    outOfCreditsAt: ws.outOfCreditsAt?.toISOString() ?? null,
    pausesAt: pausesAt?.toISOString() ?? null,
    paused: !!pausesAt && pausesAt <= now,
  };
}
