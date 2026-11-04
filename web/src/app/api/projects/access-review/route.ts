import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { visibleTo } from "@/lib/projects";

/**
 * Permission review for selected projects: who can see each one (workspace or
 * restricted), its collaborators and their roles, the invite link, live
 * preview links, and who can open the published site.
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .filter(Boolean)
    .slice(0, 50);
  const projects = await db.project.findMany({
    where: {
      id: { in: ids },
      workspaceId: ws.id,
      ...(await visibleTo(user.id, ws.id)),
    },
    select: {
      id: true,
      name: true,
      restricted: true,
      folderId: true,
      linkAccess: true,
      publishedSha: true,
      publishAudience: true,
    },
  });
  const now = new Date();
  // A restricted folder at or above a project limits who sees it.
  const folders = new Map(
    (
      await db.folder.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, name: true, parentId: true, restricted: true },
      })
    ).map((f) => [f.id, f]),
  );
  const rulingFolder = (id: string | null) => {
    for (
      let f = id ? folders.get(id) : undefined, n = 0;
      f && n < 50;
      f = f.parentId ? folders.get(f.parentId) : undefined, n++
    )
      if (f.restricted) return f.name;
    return null;
  };
  const out = [];
  for (const p of projects) {
    const collaborators = await db.collaborator.findMany({
      where: { projectId: p.id },
      select: { userId: true, role: true },
    });
    const people = await db.user.findMany({
      where: { id: { in: collaborators.map((c) => c.userId) } },
      select: { id: true, email: true, name: true },
    });
    const links = await db.previewLink.count({
      where: {
        projectId: p.id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    const siteViewers = await db.siteViewer.count({
      where: { projectId: p.id },
    });
    out.push({
      id: p.id,
      name: p.name,
      visibility: p.restricted
        ? "Restricted: invited people and workspace admins"
        : rulingFolder(p.folderId)
          ? `Restricted by the folder “${rulingFolder(p.folderId)}”: its members, invited people and workspace admins`
          : "Everyone in the workspace",
      collaborators: collaborators.map((c) => {
        const u = people.find((x) => x.id === c.userId);
        return {
          email: u?.email ?? "Unknown",
          name: u?.name ?? null,
          role: c.role,
        };
      }),
      inviteLink: p.linkAccess ? `On (${p.linkAccess})` : "Off",
      previewLinks: links,
      site: p.publishedSha
        ? p.publishAudience === "public"
          ? "Published: anyone"
          : p.publishAudience === "workspace"
            ? "Published: workspace"
            : `Published: invited only${siteViewers ? ` + ${siteViewers} site viewer(s)` : ""}`
        : "Not published",
    });
  }
  return Response.json({ projects: out });
}

export const GET = route(GET_);
