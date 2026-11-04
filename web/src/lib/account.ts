import { db } from "./db";
import { purgeProjectData } from "./purge";

/**
 * Account deletion runs on a schedule: asking starts a grace period during
 * which it can be cancelled; then housekeeping deletes the account.
 * Workspaces the person owns alone go with it (projects and their data);
 * shared ones pass to an admin, or else the longest-standing member.
 */
export const DELETION_GRACE_DAYS = 14;

export async function scheduleDeletion(userId: string, now = new Date()) {
  const at = new Date(now.getTime() + DELETION_GRACE_DAYS * 86_400_000);
  await db.user.update({ where: { id: userId }, data: { deletionScheduledAt: at } });
  return at;
}

export async function cancelDeletion(userId: string) {
  await db.user.update({ where: { id: userId }, data: { deletionScheduledAt: null } });
}

/** What deleting this account would remove or hand over, for the confirmation. */
export async function deletionImpact(userId: string) {
  const owned = await db.membership.findMany({ where: { userId, role: "OWNER" }, select: { workspaceId: true, workspace: { select: { name: true } } } });
  const out = { deleted: [] as { name: string; projects: number }[], handedOver: [] as string[] };
  for (const m of owned) {
    const others = await db.membership.count({ where: { workspaceId: m.workspaceId, userId: { not: userId } } });
    if (others) out.handedOver.push(m.workspace.name);
    else out.deleted.push({ name: m.workspace.name, projects: await db.project.count({ where: { workspaceId: m.workspaceId } }) });
  }
  return out;
}

export async function deleteAccount(userId: string) {
  const owned = await db.membership.findMany({ where: { userId, role: "OWNER" }, select: { workspaceId: true } });
  for (const { workspaceId } of owned) {
    const heir =
      (await db.membership.findFirst({ where: { workspaceId, userId: { not: userId }, role: "ADMIN" }, orderBy: { createdAt: "asc" } })) ??
      (await db.membership.findFirst({ where: { workspaceId, userId: { not: userId } }, orderBy: { createdAt: "asc" } }));
    if (heir) {
      await db.membership.update({ where: { id: heir.id }, data: { role: "OWNER" } });
      continue;
    }
    const projects = await db.project.findMany({ where: { workspaceId }, select: { id: true } });
    await db.workspace.delete({ where: { id: workspaceId } });
    for (const p of projects) await purgeProjectData(p.id).catch((e) => console.error("[account] purge", p.id, e));
  }
  await db.user.delete({ where: { id: userId } });
}

export async function runDueDeletions(now = new Date(), onlyUserId?: string) {
  const due = await db.user.findMany({
    where: { deletionScheduledAt: { lte: now }, ...(onlyUserId ? { id: onlyUserId } : {}) },
    select: { id: true },
  });
  for (const u of due) await deleteAccount(u.id).catch((e) => console.error("[account] delete", u.id, e));
  return due.length;
}
