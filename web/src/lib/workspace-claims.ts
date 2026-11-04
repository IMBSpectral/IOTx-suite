import { db } from "./db";
import { audit, domainsOf } from "./workspace-security";
import { assertSeat } from "./members-extra";

/**
 * Workspace claims: a workspace that verified its email domain can let people
 * with that domain find it and ask to join, or join straight away.
 */
export class ClaimError extends Error {}

export async function claimableWorkspaces(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const domain = user?.email.split("@")[1]?.toLowerCase();
  if (!domain) return [];
  const mine = new Set((await db.membership.findMany({ where: { userId }, select: { workspaceId: true } })).map((m) => m.workspaceId));
  const candidates = await db.workspace.findMany({
    where: { domainJoin: { in: ["request", "auto"] } },
    select: { id: true, name: true, domainJoin: true, verifiedDomains: true },
  });
  return candidates
    .filter((w) => !mine.has(w.id) && domainsOf(w).some((d) => d.verifiedAt && d.domain === domain))
    .map((w) => ({ id: w.id, name: w.name, mode: w.domainJoin as "request" | "auto" }));
}

export async function claimWorkspace(userId: string, workspaceId: string) {
  const match = (await claimableWorkspaces(userId)).find((w) => w.id === workspaceId);
  if (!match) throw new ClaimError("You can't join that workspace with your email.");
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  if (match.mode === "auto") {
    await assertSeat(workspaceId).catch((e: Error) => {
      throw new ClaimError(e.message);
    });
    await db.membership.create({ data: { userId, workspaceId, role: "MEMBER" } });
    await audit(workspaceId, userId, "member.invited", `${user.email} joined with a verified-domain email`);
    return { joined: true };
  }
  const admins = await db.membership.findMany({ where: { workspaceId, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } });
  await db.notification.createMany({
    data: admins.map((a) => ({
      userId: a.userId,
      kind: "join_request",
      title: `${user.email} asks to join ${match.name}`,
      body: "Their email is on your verified domain. Invite them from Members.",
      href: `/settings/members?invite=${encodeURIComponent(user.email)}`,
    })),
  });
  return { joined: false, requested: true };
}
