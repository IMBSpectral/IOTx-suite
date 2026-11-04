import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { ensureWorker } from "@/lib/worker";
import { route } from "@/lib/route";

type Ctx = { params: Promise<{ id: string }> };

/** The project's message queue: what is running, what waits, whether paused. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  const builds = await db.build.findMany({
    where: { projectId: id, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: [{ queuePos: "asc" }, { createdAt: "asc" }],
    select: { id: true, status: true, messageId: true, createdAt: true },
  });
  return Response.json({ paused: project.queuePaused, builds });
}

/** pause | resume | reorder (order: build ids, first runs first) | clear */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const { action, order } = (await req.json().catch(() => ({}))) as {
    action?: string;
    order?: string[];
  };

  if (action === "pause" || action === "resume") {
    await db.project.update({ where: { id }, data: { queuePaused: action === "pause" } });
    if (action === "resume") ensureWorker();
    return Response.json({ ok: true });
  }

  if (action === "reorder" && Array.isArray(order)) {
    const queued = await db.build.findMany({
      where: { projectId: id, status: "QUEUED", id: { in: order } },
      select: { id: true },
    });
    const valid = new Set(queued.map((b) => b.id));
    await db.$transaction(
      order
        .filter((b) => valid.has(b))
        .map((b, i) => db.build.update({ where: { id: b }, data: { queuePos: i } })),
    );
    return Response.json({ ok: true });
  }

  if (action === "clear") {
    // Queued turns are cancelled rather than deleted, so the chat keeps a
    // record of what was asked.
    const res = await db.build.updateMany({
      where: { projectId: id, status: "QUEUED" },
      data: { cancelRequested: true },
    });
    return Response.json({ ok: true, cleared: res.count });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export const GET = route(GET_);
export const POST = route(POST_);
