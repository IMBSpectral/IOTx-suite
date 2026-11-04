import { db } from "./db";
import { refreshAllCredits } from "./billing-cycle";
import { sendDueDigests } from "./workspace-security";
import { runDueDeletions } from "./account";

/**
 * Hourly housekeeping: refill credits whose billing period ended, and clean
 * up abandoned projects.
 *
 * A project is abandoned when it sits on the free plan, isn't published,
 * isn't protected, and nobody has touched it for ABANDONED_DAYS. Its owner
 * gets a notice with "Keep it" and "Protect it"; if they do neither within
 * GRACE_DAYS it moves to Recently deleted, where it can still be restored.
 */
export const ABANDONED_DAYS = Number(process.env.FORGE_ABANDONED_DAYS ?? 365);
export const GRACE_DAYS = Number(process.env.FORGE_ABANDONED_GRACE_DAYS ?? 30);
const DAY = 86_400_000;

/**
 * Last sign of life: an edit, a message, or "Keep it". Once the notice is
 * out, writing it moved updatedAt, so only messages and "Keep it" count.
 */
async function lastActivity(p: { id: string; updatedAt: Date; keptAt: Date | null; abandonedNoticeAt: Date | null }) {
  const msg = await db.message.findFirst({ where: { projectId: p.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const edited = p.abandonedNoticeAt ? 0 : p.updatedAt.getTime();
  return Math.max(edited, p.keptAt?.getTime() ?? 0, msg?.createdAt.getTime() ?? 0);
}

/** `workspaceId` limits the sweep to one workspace (used by tests). */
export async function sweepAbandoned(now = new Date(), workspaceId?: string) {
  const stale = new Date(now.getTime() - ABANDONED_DAYS * DAY);
  const candidates = await db.project.findMany({
    where: {
      deletedAt: null,
      cleanupProtected: false,
      publishedAt: null,
      isTemplate: false,
      workspace: { plan: "FREE" },
      ...(workspaceId ? { workspaceId } : {}),
      OR: [{ updatedAt: { lt: stale } }, { abandonedNoticeAt: { not: null } }],
    },
    select: { id: true, name: true, updatedAt: true, keptAt: true, abandonedNoticeAt: true, createdById: true, workspaceId: true },
  });
  const result = { noticed: [] as string[], removed: [] as string[] };
  for (const p of candidates) {
    if ((await lastActivity(p)) >= stale.getTime()) {
      if (p.abandonedNoticeAt) await db.project.update({ where: { id: p.id }, data: { abandonedNoticeAt: null } });
      continue;
    }
    if (!p.abandonedNoticeAt) {
      // updatedAt would move with this write, so the notice date is what counts from here on.
      await db.project.update({ where: { id: p.id }, data: { abandonedNoticeAt: now } });
      const owners = await db.membership.findMany({ where: { workspaceId: p.workspaceId, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } });
      const to = new Set([...(p.createdById ? [p.createdById] : []), ...owners.map((o) => o.userId)]);
      await db.notification.createMany({
        data: [...to].map((userId) => ({
          userId,
          projectId: p.id,
          kind: "abandoned",
          title: `"${p.name}" will be deleted in ${GRACE_DAYS} days`,
          body: `Nobody has worked on it for over ${ABANDONED_DAYS} days. Keep it, or protect it from clean-up.`,
          href: `/projects/${p.id}?cleanup=1`,
        })),
      });
      result.noticed.push(p.id);
    } else if (now.getTime() - p.abandonedNoticeAt.getTime() >= GRACE_DAYS * DAY) {
      await db.project.update({ where: { id: p.id }, data: { deletedAt: now } });
      result.removed.push(p.id);
    }
  }
  return result;
}

/** "Keep it" restarts the clock; "Protect it" exempts the project from clean-up for good. */
export async function answerCleanup(projectId: string, choice: "keep" | "protect") {
  await db.project.update({
    where: { id: projectId },
    data: choice === "keep" ? { keptAt: new Date(), abandonedNoticeAt: null } : { cleanupProtected: true, abandonedNoticeAt: null },
  });
  await db.notification.updateMany({ where: { projectId, kind: "abandoned", readAt: null }, data: { readAt: new Date() } });
}

export async function housekeeping(now = new Date()) {
  await refreshAllCredits(now);
  await sendDueDigests(now);
  await runDueDeletions(now);
  return sweepAbandoned(now);
}

const state = globalThis as { __forgeHousekeeping?: ReturnType<typeof setInterval> };

export function ensureHousekeeping() {
  if (state.__forgeHousekeeping) return;
  const tick = () => void housekeeping().catch((e) => console.error("[housekeeping]", e));
  state.__forgeHousekeeping = setInterval(tick, 60 * 60_000);
  setTimeout(tick, 60_000);
}
