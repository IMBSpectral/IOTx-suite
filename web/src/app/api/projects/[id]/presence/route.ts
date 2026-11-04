import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";

// Anyone whose heartbeat is older than this is treated as gone.
const LIVENESS_MS = 45_000;

/** Heartbeat. Called periodically by every open editor. */
async function POST_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);

  await db.presence.upsert({
    where: { projectId_userId: { projectId: id, userId: user.id } },
    update: { lastSeen: new Date(), name: user.name ?? null },
    create: { projectId: id, userId: user.id, name: user.name ?? null },
  });

  const since = new Date(Date.now() - LIVENESS_MS);
  const active = await db.presence.findMany({
    where: { projectId: id, lastSeen: { gte: since }, userId: { not: user.id } },
    select: { userId: true, name: true },
  });

  return Response.json({ active });
}

/** Who else is here right now. */
async function GET_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);

  const since = new Date(Date.now() - LIVENESS_MS);
  const active = await db.presence.findMany({
    where: { projectId: id, lastSeen: { gte: since }, userId: { not: user.id } },
    select: { userId: true, name: true },
  });

  return Response.json({ active });
}

export const GET = route(GET_);
export const POST = route(POST_);
