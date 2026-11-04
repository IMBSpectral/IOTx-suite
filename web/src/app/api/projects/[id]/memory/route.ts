import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { addProjectMemory, deleteProjectMemory, followedSummary, MemoryError, setMemoryEnabled, tidyMemories, undoTidy } from "@/lib/memory";

type Ctx = { params: Promise<{ id: string }> };

/** What's followed in every message here: instructions, project memories, your memories. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  return Response.json(await followedSummary(id, user.id));
}

/** toggle {enabled} · add {fact} · delete {fact} · tidy · undo */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const b = (await req.json().catch(() => ({}))) as { action?: string; enabled?: boolean; fact?: string };
  try {
    switch (b.action) {
      case "toggle":
        await setMemoryEnabled(id, !!b.enabled);
        break;
      case "add":
        await addProjectMemory(id, b.fact ?? "");
        break;
      case "delete":
        await deleteProjectMemory(id, b.fact ?? "");
        break;
      case "tidy":
        return Response.json(await tidyMemories(id));
      case "undo":
        await undoTidy(id);
        break;
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof MemoryError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
