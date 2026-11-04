import { db } from "@/lib/db";
import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";

/** Leave a project you were invited to. Workspace membership is untouched. */
async function POST_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const row = await db.collaborator.findUnique({ where: { projectId_userId: { projectId: id, userId: user.id } } });
  if (!row) return Response.json({ error: "You aren't a collaborator on this project." }, { status: 404 });
  await db.collaborator.delete({ where: { id: row.id } });
  await db.star.deleteMany({ where: { projectId: id, userId: user.id } });
  return Response.json({ ok: true });
}

export const POST = route(POST_);
