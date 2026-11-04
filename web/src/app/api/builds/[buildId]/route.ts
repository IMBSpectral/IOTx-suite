import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { ensureWorker } from "@/lib/worker";
import { route } from "@/lib/route";

type Ctx = { params: Promise<{ buildId: string }> };

async function load(buildId: string) {
  const user = await requireUser();
  const build = await db.build.findUnique({ where: { id: buildId } });
  if (!build) throw new Response("Not found", { status: 404 });
  // Stopping, reordering and editing queued work are edits.
  await requireProject(user.id, build.projectId, "edit");
  return build;
}

/** The user message a build answers: the one written just before its reply. */
async function userMessageFor(build: { projectId: string; messageId: string | null }) {
  if (!build.messageId) return null;
  const reply = await db.message.findUnique({
    where: { id: build.messageId },
    select: { createdAt: true },
  });
  if (!reply) return null;
  return db.message.findFirst({
    where: { projectId: build.projectId, role: "USER", createdAt: { lte: reply.createdAt } },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Queue and turn controls.
 *  - stop:    end the running turn (or a queued one before it starts)
 *  - remove:  drop a queued message and its pending reply
 *  - run_now: move a queued message to the front and interrupt the running turn
 */
async function POST_(req: Request, { params }: Ctx) {
  const { buildId } = await params;
  const build = await load(buildId);
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };

  if (action === "stop") {
    if (build.status !== "QUEUED" && build.status !== "RUNNING") {
      return Response.json({ error: "This turn already finished." }, { status: 409 });
    }
    await db.build.update({ where: { id: buildId }, data: { cancelRequested: true } });
    return Response.json({ ok: true });
  }

  if (action === "remove") {
    if (build.status !== "QUEUED") {
      return Response.json({ error: "Only queued messages can be removed." }, { status: 409 });
    }
    const userMsg = await userMessageFor(build);
    await db.$transaction([
      db.build.delete({ where: { id: buildId } }),
      ...(build.messageId ? [db.message.delete({ where: { id: build.messageId } })] : []),
      ...(userMsg ? [db.message.delete({ where: { id: userMsg.id } })] : []),
    ]);
    return Response.json({ ok: true });
  }

  if (action === "run_now") {
    if (build.status !== "QUEUED") {
      return Response.json({ error: "Only queued messages can be run now." }, { status: 409 });
    }
    const first = await db.build.aggregate({
      where: { projectId: build.projectId, status: "QUEUED" },
      _min: { queuePos: true },
    });
    await db.$transaction([
      db.build.update({
        where: { id: buildId },
        data: { queuePos: (first._min.queuePos ?? 0) - 1 },
      }),
      // Interjection: the running turn stops so this one starts next.
      db.build.updateMany({
        where: { projectId: build.projectId, status: "RUNNING" },
        data: { cancelRequested: true },
      }),
    ]);
    ensureWorker();
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

/** Edit a queued message before it runs. */
async function PATCH_(req: Request, { params }: Ctx) {
  const { buildId } = await params;
  const build = await load(buildId);
  if (build.status !== "QUEUED") {
    return Response.json({ error: "Only queued messages can be edited." }, { status: 409 });
  }
  const { content } = (await req.json().catch(() => ({}))) as { content?: string };
  if (!content?.trim()) return Response.json({ error: "Message is empty" }, { status: 400 });
  const userMsg = await userMessageFor(build);
  if (!userMsg) return Response.json({ error: "Message not found" }, { status: 404 });
  await db.message.update({ where: { id: userMsg.id }, data: { content: content.trim() } });
  return Response.json({ ok: true });
}

export const POST = route(POST_);
export const PATCH = route(PATCH_);
