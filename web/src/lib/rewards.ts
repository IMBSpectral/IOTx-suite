import { db } from "./db";
import { getBrand } from "./brand";

/**
 * Bonuses: "Explore Forge. Earn bonuses." Each reward is earned by doing
 * something (checked against what actually happened), then claimed once into
 * a workspace the person belongs to. There's a daily reward too, and a
 * welcome-back gift for people returning after a long break.
 */
export type Reward = { id: string; title: string; detail: string; credits: number; href?: string };

export const REWARDS: Reward[] = [
  { id: "first-project", title: "Create your first project", detail: "Describe an app and let {brand} build it.", credits: 5, href: "/dashboard" },
  { id: "first-publish", title: "Publish a project", detail: "Put something online for others to see.", credits: 10 },
  { id: "use-plan", title: "Plan before you build", detail: "Use Plan mode once to draft a plan.", credits: 3 },
  { id: "invite-teammate", title: "Invite a teammate", detail: "Add someone to your workspace.", credits: 10, href: "/settings/members" },
  { id: "connect-service", title: "Connect a service", detail: "Add a connector such as Stripe or Resend.", credits: 5, href: "/settings/connectors" },
  { id: "security-scan", title: "Run a security scan", detail: "Check a project for security issues.", credits: 3 },
  { id: "automation", title: "Automate something", detail: "Create an automation that runs on a schedule.", credits: 5, href: "/automations" },
];
export const DAILY_CREDITS = 1;
export const WELCOME_BACK_CREDITS = 10;
export const AWAY_DAYS = 30;

const today = (now: Date) => now.toISOString().slice(0, 10);

/** Which rewards this person has earned, from what they've actually done. */
async function earned(userId: string): Promise<Set<string>> {
  const workspaces = (await db.membership.findMany({ where: { userId }, select: { workspaceId: true } })).map((m) => m.workspaceId);
  const inMine = { workspaceId: { in: workspaces } };
  const [projects, published, plans, invites, connectors, scans, automations] = await Promise.all([
    db.project.count({ where: { createdById: userId } }),
    db.project.count({ where: { createdById: userId, publishedSha: { not: null } } }),
    db.message.count({ where: { userId, mode: "plan" } }),
    db.membership.count({ where: { ...inMine, userId: { not: userId } } }),
    db.connector.count({ where: inMine }),
    db.project
      .findMany({ where: { createdById: userId }, select: { securityConfig: true } })
      .then((ps) => ps.filter((p) => (p.securityConfig as { lastScanAt?: string } | null)?.lastScanAt).length),
    db.automation.count({ where: { createdById: userId } }),
  ]);
  const done = new Set<string>();
  if (projects) done.add("first-project");
  if (published) done.add("first-publish");
  if (plans) done.add("use-plan");
  if (invites) done.add("invite-teammate");
  if (connectors) done.add("connect-service");
  if (scans) done.add("security-scan");
  if (automations) done.add("automation");
  return done;
}

/** Back after a long break: the last message before today was over AWAY_DAYS ago. */
async function returning(userId: string, now: Date) {
  const startOfDay = new Date(`${today(now)}T00:00:00Z`);
  const last = await db.message.findFirst({ where: { userId, createdAt: { lt: startOfDay } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return !!last && now.getTime() - last.createdAt.getTime() > AWAY_DAYS * 86_400_000;
}

export async function rewardsFor(userId: string, now = new Date()) {
  const [done, claims, back] = await Promise.all([earned(userId), db.rewardClaim.findMany({ where: { userId } }), returning(userId, now)]);
  const claimed = new Set(claims.map((c) => c.rewardId));
  const dailyId = `daily:${today(now)}`;
  const welcomeId = `welcome-back:${today(now).slice(0, 7)}`;
  return {
    rewards: REWARDS.map((r) => ({ ...r, detail: r.detail.replace("{brand}", getBrand().shortName), earned: done.has(r.id), claimed: claimed.has(r.id) })),
    daily: { id: dailyId, credits: DAILY_CREDITS, claimed: claimed.has(dailyId) },
    welcomeBack: back ? { id: welcomeId, credits: WELCOME_BACK_CREDITS, claimed: claimed.has(welcomeId) } : null,
    totalEarned: claims.reduce((n, c) => n + c.credits, 0),
  };
}

export class RewardError extends Error {}

/** Claim a reward into one of the person's workspaces. */
export async function claimReward(userId: string, rewardId: string, workspaceId: string, now = new Date()) {
  const member = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  if (!member) throw new RewardError("Choose a workspace you belong to.");
  const state = await rewardsFor(userId, now);
  let credits = 0;
  if (rewardId === state.daily.id) credits = state.daily.credits;
  else if (state.welcomeBack && rewardId === state.welcomeBack.id) credits = state.welcomeBack.credits;
  else {
    const r = state.rewards.find((x) => x.id === rewardId);
    if (!r) throw new RewardError("Unknown reward.");
    if (!r.earned) throw new RewardError("Finish it first, then claim.");
    credits = r.credits;
  }
  try {
    await db.$transaction([
      db.rewardClaim.create({ data: { userId, rewardId, workspaceId, credits } }),
      db.workspace.update({ where: { id: workspaceId }, data: { creditBalance: { increment: credits }, outOfCreditsAt: null } }),
      db.creditEntry.create({ data: { workspaceId, delta: credits, reason: "BONUS", userId } }),
    ]);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new RewardError("Already claimed.");
    throw e;
  }
  return { credits };
}
