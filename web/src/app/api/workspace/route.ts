import { db } from "@/lib/db";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";

async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  // Every workspace this person belongs to, for "Move to workspace".
  const all = await db.membership.findMany({
    where: { userId: user.id },
    include: { workspace: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return Response.json({
    workspace: ws,
    workspaces: all.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })),
  });
}

async function PATCH_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);

  const { name } = (await req.json()) as { name?: string };
  const next = name?.trim().slice(0, 60);
  if (!next) return Response.json({ error: "Name is required" }, { status: 400 });

  const workspace = await db.workspace.update({
    where: { id: ws.id },
    data: { name: next },
  });
  return Response.json({ workspace });
}

export const GET = route(GET_);
export const PATCH = route(PATCH_);
