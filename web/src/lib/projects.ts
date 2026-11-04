import { db } from "./db";
import type { Prisma } from "@prisma/client";
import { blockedFolderIds } from "./folders";
import type { Listing } from "./listing";

/**
 * Project listings for the dashboard. One place decides what each view
 * contains, so the grid, the sidebar and search can't disagree — and deleted
 * projects stay out of everything except "Recently deleted".
 */

export type View =
  | "all"
  | "mine"
  | "recent"
  | "starred"
  | "shared"
  | "published"
  | "popular"
  | "design_systems"
  | "templates"
  | "hidden"
  | "deleted";

export type ProjectCard = {
  id: string;
  name: string;
  emoji: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  url: string | null;
  folderId: string | null;
  isTemplate: boolean;
  /** Gallery profile for a workspace template (R.6). */
  listing: Listing | null;
  starred: boolean;
  createdByMe: boolean;
  visits7d: number;
  deletedAt: string | null;
  viewedAt: string | null;
  kind: string;
  /** Open critical/high security findings: "Open findings need attention". */
  openFindings: number;
  /** Published, but the latest version isn't live yet. */
  unpublishedChanges: boolean;
};

import { siteOrigin } from "./site-host";

function lastDays(n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    out.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/**
 * Restricted projects show up only for workspace owners/admins and the
 * people invited to them. Spread into any workspace-scoped project query.
 */
export async function visibleTo(
  userId: string,
  workspaceId: string,
): Promise<Prisma.ProjectWhereInput> {
  const m = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (m?.role === "OWNER" || m?.role === "ADMIN") return {};
  const invited = { collaborators: { some: { userId } } };
  const blocked = await blockedFolderIds(userId, workspaceId);
  return {
    AND: [
      { OR: [{ restricted: false }, invited] },
      // Projects in restricted folders the person isn't a member of.
      ...(blocked.length
        ? [
            {
              OR: [
                { folderId: null },
                { folderId: { notIn: blocked } },
                invited,
              ],
            },
          ]
        : []),
    ],
  };
}

export async function listProjects(opts: {
  userId: string;
  workspaceId: string;
  view?: View;
  folderId?: string | null;
  q?: string;
  take?: number;
}): Promise<ProjectCard[]> {
  const view = opts.view ?? "all";
  const live: Prisma.ProjectWhereInput =
    view === "deleted" ? { deletedAt: { not: null } } : { deletedAt: null };

  let where: Prisma.ProjectWhereInput;
  if (view === "shared") {
    // Projects in other workspaces that this user was invited to.
    where = {
      ...live,
      collaborators: { some: { userId: opts.userId } },
      workspaceId: { not: opts.workspaceId },
    };
  } else {
    where = { ...live, workspaceId: opts.workspaceId };
    if (view === "mine") where.createdById = opts.userId;
    if (view === "starred") where.stars = { some: { userId: opts.userId } };
    if (view === "published") where.publishedSha = { not: null };
    if (view === "templates") where.isTemplate = true;
    if (view === "recent") where.visits = { some: { userId: opts.userId } };
    if (view === "popular") where.publishedSha = { not: null };
    if (view === "design_systems") where.kind = "design_system";
    // Projects you hid, and projects in folders you hid, show only under "Hidden".
    const [hidden, hiddenFolders] = await Promise.all([
      db.projectHide
        .findMany({
          where: { userId: opts.userId },
          select: { projectId: true },
        })
        .then((r) => r.map((h) => h.projectId)),
      db.folderHide
        .findMany({
          where: {
            userId: opts.userId,
            folder: { workspaceId: opts.workspaceId },
          },
          select: { folderId: true },
        })
        .then((r) => r.map((h) => h.folderId)),
    ]);
    const and: Prisma.ProjectWhereInput[] = [
      await visibleTo(opts.userId, opts.workspaceId),
    ];
    if (view === "hidden")
      and.push({
        OR: [{ id: { in: hidden } }, { folderId: { in: hiddenFolders } }],
      });
    else {
      if (hidden.length) and.push({ id: { notIn: hidden } });
      // Inside a hidden folder you opened on purpose, its projects still show.
      if (
        hiddenFolders.length &&
        !(opts.folderId && hiddenFolders.includes(opts.folderId))
      ) {
        and.push({
          OR: [{ folderId: null }, { folderId: { notIn: hiddenFolders } }],
        });
      }
    }
    where.AND = and;
  }
  // Folders scope the main views; filtered views search across folders.
  if (opts.folderId !== undefined && (view === "all" || view === "mine"))
    where.folderId = opts.folderId;
  if (opts.q?.trim())
    where.name = { contains: opts.q.trim(), mode: "insensitive" };

  const days = lastDays(7);
  const rows = await db.project.findMany({
    where,
    orderBy: view === "deleted" ? { deletedAt: "desc" } : { updatedAt: "desc" },
    take: opts.take ?? 200,
    select: {
      id: true,
      name: true,
      emoji: true,
      kind: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
      publishedSha: true,
      headSha: true,
      subdomain: true,
      folderId: true,
      isTemplate: true,
      listing: true,
      createdById: true,
      deletedAt: true,
      stars: { where: { userId: opts.userId }, select: { userId: true } },
      visits: { where: { userId: opts.userId }, select: { at: true } },
      siteVisits: { where: { day: { in: days } }, select: { count: true } },
      _count: {
        select: {
          findings: {
            where: {
              resolved: false,
              ignored: false,
              severity: { in: ["CRITICAL", "HIGH"] },
            },
          },
        },
      },
    },
  });

  const cards = rows.map((p) => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    publishedAt: p.publishedSha ? (p.publishedAt?.toISOString() ?? null) : null,
    url: p.publishedSha ? siteOrigin(p.subdomain) : null,
    folderId: p.folderId,
    isTemplate: p.isTemplate,
    listing: (p.listing as Listing | null) ?? null,
    kind: p.kind,
    openFindings: p._count.findings,
    unpublishedChanges:
      !!p.publishedSha && !!p.headSha && p.headSha !== p.publishedSha,
    starred: p.stars.length > 0,
    createdByMe: p.createdById === opts.userId,
    visits7d: p.siteVisits.reduce((n, v) => n + v.count, 0),
    deletedAt: p.deletedAt?.toISOString() ?? null,
    viewedAt: p.visits[0]?.at.toISOString() ?? null,
  }));
  // "Recently viewed" is ordered by when *you* last opened it.
  if (view === "recent")
    cards.sort((a, b) => (b.viewedAt ?? "").localeCompare(a.viewedAt ?? ""));
  // "Most visits": published sites by page views over the last 7 days.
  if (view === "popular") cards.sort((a, b) => b.visits7d - a.visits7d);
  return cards;
}

/** Count a page view of a published site; analytics are per day. */
export async function recordSiteVisit(projectId: string) {
  const day = new Date().toISOString().slice(0, 10);
  await db.siteVisit.upsert({
    where: { projectId_day: { projectId, day } },
    create: { projectId, day, count: 1 },
    update: { count: { increment: 1 } },
  });
}

export async function siteAnalytics(projectId: string, days = 30) {
  const keys = lastDays(days).reverse();
  const rows = await db.siteVisit.findMany({
    where: { projectId, day: { in: keys } },
  });
  const byDay = new Map(rows.map((r) => [r.day, r.count]));
  const series = keys.map((day) => ({ day, visits: byDay.get(day) ?? 0 }));
  return {
    series,
    total: series.reduce((n, d) => n + d.visits, 0),
    last7: series.slice(-7).reduce((n, d) => n + d.visits, 0),
  };
}
