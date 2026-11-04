import { requireUser, requireProject } from "@/lib/workspace";
import {
  ensureSandbox,
  checkAlive,
  touchSandbox,
  stopSandbox,
  sandboxLogs,
  ensureReaper,
  dockerAvailable,
  IDLE_MS,
} from "@/lib/sandbox";
import { route } from "@/lib/route";
import { ensurePreviewProxy, previewUrl } from "@/lib/sandbox-proxy";

ensurePreviewProxy();

export const maxDuration = 300;

/** Current state without booting anything. */
async function GET_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);

  if (new URL(req.url).searchParams.get("logs")) {
    return Response.json({ logs: await sandboxLogs(id, 200).catch(() => "") });
  }
  // ?active=0: an editor tab that's hidden or unused checks in without
  // keeping the container alive, so an abandoned preview can be paused.
  if (new URL(req.url).searchParams.get("active") !== "0") touchSandbox(id);
  const state = await checkAlive(id);
  return Response.json({
    ...state,
    idleMs: IDLE_MS,
    url: state.status === "ready" ? previewUrl(id, state.port) : null,
  });
}

/** Boot the dev container (idempotent) and return where to point the frame. */
async function POST_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);

  if (!(await dockerAvailable())) {
    return Response.json(
      { status: "failed", error: "Docker is not running.", url: null },
      { status: 503 },
    );
  }

  ensureReaper();
  const state = await ensureSandbox(id);

  return Response.json({
    ...state,
    url: state.status === "ready" ? previewUrl(id, state.port) : null,
    logs: state.status === "failed" ? await sandboxLogs(id).catch(() => "") : undefined,
  });
}

async function DELETE_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  await stopSandbox(id);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
