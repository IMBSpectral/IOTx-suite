import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { StressError, stressTest } from "@/lib/stress";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const running = new Set<string>();

/** Run a capped stress test against this project's own published site. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  if (running.has(id)) return Response.json({ error: "A stress test is already running for this app." }, { status: 409 });
  const body = (await req.json().catch(() => ({}))) as { path?: string; concurrency?: number; seconds?: number };
  running.add(id);
  try {
    return Response.json({ result: await stressTest(id, body) });
  } catch (e) {
    if (e instanceof StressError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  } finally {
    running.delete(id);
  }
}

export const POST = route(POST_);
