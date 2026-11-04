import { SignJWT, jwtVerify } from "jose";
import { db } from "./db";

/**
 * Access to non-public published sites.
 *
 * A site lives on its own host (<sub>.localhost), and the editor's session
 * cookie is host-only, so the site cannot see it. Instead the editor's origin
 * checks access and hands the site a short-lived token, which the site turns
 * into its own cookie — the same shape as Lovable's /api/preview-auth.
 */

export const SITE_COOKIE = "forge_site";

function key() {
  const s = process.env.PREVIEW_TOKEN_SECRET;
  if (!s) throw new Error("PREVIEW_TOKEN_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function signSiteToken(subdomain: string, userId: string, ttl: "2m" | "1d") {
  return new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subdomain)
    .setAudience("site")
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key());
}

export async function verifySiteToken(token: string, subdomain: string) {
  try {
    const { payload } = await jwtVerify(token, key(), { audience: "site", subject: subdomain });
    return typeof payload.uid === "string" ? payload.uid : null;
  } catch {
    return null;
  }
}

/** Whether a user may open a site with the given audience. */
export async function canView(
  project: { id: string; workspaceId: string; publishAudience: string },
  userId: string | null,
) {
  if (project.publishAudience === "public") return true;
  if (!userId) return false;
  const member = await db.membership.findFirst({
    where: { userId, workspaceId: project.workspaceId },
    select: { role: true },
  });
  if (project.publishAudience === "workspace" && member) return true;
  // private: invited collaborators, plus the workspace's owners and admins.
  if (project.publishAudience !== "workspace") {
    if (member && (member.role === "OWNER" || member.role === "ADMIN")) return true;
    if ((await db.collaborator.count({ where: { projectId: project.id, userId } })) > 0) return true;
  }
  // Either way, people added to the site itself.
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  return !!user && (await db.siteViewer.count({ where: { projectId: project.id, email: user.email.toLowerCase() } })) > 0;
}
