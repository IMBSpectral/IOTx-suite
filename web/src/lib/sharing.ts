import crypto from "node:crypto";
import { db } from "./db";

/** Lowercase alphanumerics only: the token is also a DNS label (preview--<token>). */
export function newToken(length = 20) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export { hashPassword, verifyPassword } from "./passwords";

import { siteOrigin } from "./site-host";
const EDITOR = process.env.EDITOR_ORIGIN ?? "http://localhost:3000";

/** Preview links get their own host so guest pages never see editor cookies. */
export const previewLinkUrl = (token: string) => siteOrigin(`preview--${token}`);
export const inviteLinkUrl = (token: string) => `${EDITOR}/join/${token}`;

export const EXPIRY = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, never: 0 } as const;
export type Expiry = keyof typeof EXPIRY;

export function linkStatus(link: { revokedAt: Date | null; expiresAt: Date | null }) {
  if (link.revokedAt) return "revoked" as const;
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return "expired" as const;
  return "active" as const;
}

/** Everyone who manages a project: workspace owners/admins and admin collaborators. */
export async function projectAdmins(project: { id: string; workspaceId: string }) {
  const [members, collabs] = await Promise.all([
    db.membership.findMany({
      where: { workspaceId: project.workspaceId, role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
    }),
    db.collaborator.findMany({
      where: { projectId: project.id, role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
    }),
  ]);
  return [...new Set([...members, ...collabs].map((r) => r.userId))];
}

export async function notify(
  userIds: string[],
  n: { projectId?: string; kind: string; title: string; body?: string; href?: string },
) {
  if (!userIds.length) return;
  await db.notification.createMany({ data: userIds.map((userId) => ({ userId, ...n })) });
}

/** Collaborator role for a granted access level. */
export const ROLE_FOR = { view: "VIEWER", edit: "MEMBER", admin: "ADMIN" } as const;
