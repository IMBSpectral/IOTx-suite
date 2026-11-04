import { db } from "./db";
import { creditReferral } from "./referrals";

/**
 * What happens when someone's account is created (Auth.js createUser): every
 * user gets a workspace before they can own anything, and a "Share Forge"
 * referral (the forge_ref cookie) credits both sides.
 */
export async function onNewUser(
  user: { id: string; name?: string | null; email?: string | null },
  referrerId?: string | null,
) {
  const base =
    (user.name ?? user.email?.split("@")[0] ?? "workspace")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "workspace";
  const slug = `${base}-${Math.random().toString(36).slice(2, 7)}`;
  const ws = await db.workspace.create({
    data: {
      name: user.name ? `${user.name}'s workspace` : "My workspace",
      slug,
      memberships: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  const referred = referrerId
    ? await creditReferral(referrerId, user.id, ws.id).catch(() => false)
    : false;
  return { workspaceId: ws.id, referred };
}
