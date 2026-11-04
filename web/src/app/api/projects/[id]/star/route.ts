import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";

async function POST_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);

  const existing = await db.star.findUnique({
    where: { userId_projectId: { userId: user.id, projectId: id } },
  });

  if (existing) {
    await db.star.delete({ where: { id: existing.id } });
    return Response.json({ starred: false });
  }
  await db.star.create({ data: { userId: user.id, projectId: id } });
  return Response.json({ starred: true });
}

export const POST = route(POST_);
