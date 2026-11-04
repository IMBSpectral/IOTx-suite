import { db } from "./db";
import { grant } from "./credits";

export const REFERRAL_BONUS = 10;
export const REFERRAL_COOKIE = "forge_ref";

/**
 * Credit both sides of a referral, once, when the referred person's account
 * is created. Self-referral and unknown referrers are ignored.
 */
export async function creditReferral(referrerId: string, newUserId: string, newWorkspaceId: string) {
  if (!referrerId || referrerId === newUserId) return false;
  const referrer = await db.membership.findFirst({
    where: { userId: referrerId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
  });
  if (!referrer) return false;
  await grant(referrer.workspaceId, REFERRAL_BONUS, "REFERRAL");
  await grant(newWorkspaceId, REFERRAL_BONUS, "REFERRAL");
  await db.notification.create({
    data: {
      userId: referrerId,
      kind: "referral",
      title: `Someone joined with your link: +${REFERRAL_BONUS} credits`,
      href: "/settings/billing",
    },
  });
  return true;
}
