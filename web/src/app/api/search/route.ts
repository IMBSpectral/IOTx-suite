import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { visibleTo } from "@/lib/projects";
import { effectiveForRequest } from "@/lib/iotx/permissions";
import { listDocs, viewer } from "@/lib/kb";

/**
 * GET ?q= -> { projects } (the command palette), and with &all=1 also
 * { chats, knowledge, people } for the start page's "search everything".
 * Only what the person can already open.
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const sp = new URL(req.url).searchParams;
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  const all = sp.get("all") === "1";

  if (!q) return Response.json(all ? { projects: [], chats: [], knowledge: [], people: [] } : { projects: [] });

  const e = all ? await effectiveForRequest(user.id, ws.id) : null;
  const opens = (app: string) => !e || e.apps.includes(app);
  const has = (key: string) => !e || e.keys.includes(key);

  const [projects, chats, knowledge, people] = await Promise.all([
    !all || opens("builder")
      ? db.project.findMany({
          where: {
            workspaceId: ws.id,
            deletedAt: null,
            ...(await visibleTo(user.id, ws.id)),
            name: { contains: q, mode: "insensitive" },
          },
          orderBy: { updatedAt: "desc" },
          take: 8,
          select: { id: true, name: true },
        })
      : [],
    all && has("home.ask")
      ? db.workspaceChat.findMany({
          where: { userId: user.id, workspaceId: ws.id, title: { contains: q, mode: "insensitive" } },
          orderBy: { updatedAt: "desc" },
          take: 6,
          select: { id: true, title: true },
        })
      : [],
    all && opens("read")
      ? viewer(user.id, ws.id)
          .then((v) => listDocs(v, { text: q }))
          .then((ds) => ds.filter((d) => d.status === "published").slice(0, 6).map((d) => ({ id: d.id, title: d.title, kind: d.kind })))
          .catch(() => [])
      : [],
    all
      ? db.membership.findMany({
          where: {
            workspaceId: ws.id,
            user: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] },
          },
          take: 6,
          select: { user: { select: { id: true, name: true, email: true } } },
        })
      : [],
  ]);

  if (!all) return Response.json({ projects });
  return Response.json({
    projects,
    chats,
    knowledge,
    people: people.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email })),
  });
}

export const GET = route(GET_);
