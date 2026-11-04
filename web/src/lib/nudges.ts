import { db } from "./db";
import { rewardsFor } from "./rewards";
import { getBrand } from "./brand";
import type { ProjectCard } from "./projects";

export type Nudge = { text: string; href?: string; cta?: string };

/**
 * One personal line under the dashboard greeting, picked from what's going on
 * for this person right now: a welcome-back gift, work that isn't live yet, a
 * build that failed, credits running out, today's reward. The most useful one
 * wins; nothing to say means no line.
 */
export async function dashboardNudge(
  userId: string,
  workspaceId: string,
  recent: ProjectCard[],
  now = new Date(),
): Promise<Nudge | null> {
  const [rewards, ws, failed] = await Promise.all([
    rewardsFor(userId, now),
    db.workspace.findUnique({
      where: { id: workspaceId },
      select: { creditBalance: true },
    }),
    db.build.findFirst({
      where: {
        status: "FAILED",
        createdAt: { gt: new Date(now.getTime() - 3 * 86_400_000) },
        project: { workspaceId, deletedAt: null, visits: { some: { userId } } },
      },
      orderBy: { createdAt: "desc" },
      select: {
        projectId: true,
        project: {
          select: {
            name: true,
            builds: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { status: true },
            },
          },
        },
      },
    }),
  ]);

  if (rewards.welcomeBack && !rewards.welcomeBack.claimed) {
    return {
      text: `Welcome back! You have ${rewards.welcomeBack.credits} free credits waiting.`,
      href: "/rewards",
      cta: "Claim them",
    };
  }
  // Only when that failed build is still the project's latest.
  if (failed && failed.project.builds[0]?.status === "FAILED") {
    return {
      text: `Your last change to “${failed.project.name}” didn't finish building.`,
      href: `/projects/${failed.projectId}`,
      cta: "Open it to fix",
    };
  }
  const pending = recent.find(
    (p) =>
      p.unpublishedChanges &&
      now.getTime() - new Date(p.updatedAt).getTime() < 7 * 86_400_000,
  );
  if (pending)
    return {
      text: `“${pending.name}” has changes that aren't live yet.`,
      href: `/projects/${pending.id}`,
      cta: "Review and publish",
    };
  if (ws && ws.creditBalance > 0 && ws.creditBalance < 5) {
    return {
      text: `You're down to ${ws.creditBalance} credit${ws.creditBalance === 1 ? "" : "s"}.`,
      href: "/settings/billing",
      cta: "Get more",
    };
  }
  if (!rewards.daily.claimed)
    return {
      text: "Your daily free credit is ready.",
      href: "/rewards",
      cta: "Claim it",
    };
  if (!recent.length)
    return {
      text: `Describe the app you want below and ${getBrand().shortName} builds the first version.`,
    };
  return null;
}
