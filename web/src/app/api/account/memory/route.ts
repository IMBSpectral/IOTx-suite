import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { addUserMemory, deleteUserMemory, MemoryError, userMemories } from "@/lib/memory";

/** Your memory: what the agent knows about you in every project. */
async function GET_() {
  const user = await requireUser();
  return Response.json({ facts: await userMemories(user.id) });
}

/** add {fact} · delete {fact} */
async function POST_(req: Request) {
  const user = await requireUser();
  const b = (await req.json().catch(() => ({}))) as { action?: string; fact?: string };
  try {
    if (b.action === "add") return Response.json({ facts: await addUserMemory(user.id, b.fact ?? "") });
    if (b.action === "delete") return Response.json({ facts: await deleteUserMemory(user.id, b.fact ?? "") });
    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof MemoryError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
