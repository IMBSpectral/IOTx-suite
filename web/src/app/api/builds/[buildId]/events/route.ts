import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { subscribe, replay } from "@/lib/events";
import { ensureWorker } from "@/lib/worker";
import { route } from "@/lib/route";
import { can } from "@/lib/iotx/permissions";

export const maxDuration = 300;

/**
 * Follow a build. Replays everything already recorded, then tails live.
 *
 * `?after=<seq>` resumes from where a dropped connection left off, which is
 * the whole point of persisting events rather than streaming them once.
 */
async function GET_(
  req: Request,
  { params }: { params: Promise<{ buildId: string }> },
) {
  const { buildId } = await params;
  const user = await requireUser();

  const build = await db.build.findUnique({
    where: { id: buildId },
    select: { id: true, projectId: true, status: true },
  });
  if (!build) return new Response("Not found", { status: 404 });
  await requireProject(user.id, build.projectId);
  // Code streamed as it is written is shown only to people who may see the code.
  const ws = await db.project.findUnique({ where: { id: build.projectId }, select: { workspaceId: true } });
  const codeView = ws ? await can(user.id, ws.workspaceId, "builder.code.view").catch(() => false) : false;

  ensureWorker();

  const after = Number(new URL(req.url).searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (seq: number, event: unknown) => {
        if (closed) return;
        if (!codeView && (event as { type?: string }).type === "file_stream") return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ seq, ...(event as object) })}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      // Live first so nothing emitted during replay is missed; duplicates are
      // filtered by seq on the client.
      const unsubscribe = subscribe(buildId, send);

      for (const { seq, event } of await replay(buildId, after)) send(seq, event);

      const finish = async () => {
        const current = await db.build.findUnique({
          where: { id: buildId },
          select: { status: true },
        });
        if (
          current &&
          current.status !== "QUEUED" &&
          current.status !== "RUNNING"
        ) {
          send(-1, { type: "closed", status: current.status });
          clearInterval(poll);
          unsubscribe();
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by the client disconnecting.
          }
        }
      };

      // A terminal state reached while nobody was listening still has to end
      // the stream, so poll as a backstop.
      const poll = setInterval(() => void finish(), 2000);
      void finish();

      req.signal.addEventListener("abort", () => {
        clearInterval(poll);
        unsubscribe();
        closed = true;
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

export const GET = route(GET_);
