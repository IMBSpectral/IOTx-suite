import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { addCheckHook, addDestination, EventError, listEvents, removeEndpoint, testDestination, toggleDestination } from "@/lib/event-destinations";

/** Event destinations and check hooks (owners and admins). */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  return Response.json(await listEvents(ws.id));
}

/**
 * addDestination {url, events} → its signing secret, shown once · addHook {url, onError} ·
 * remove {id} · toggle {id, enabled} · test {id}
 */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; url?: string; events?: string[]; onError?: string; enabled?: boolean };
  try {
    switch (b.action) {
      case "addDestination": {
        const d = await addDestination(ws.id, b);
        return Response.json({ id: d.id, secret: d.secret }, { status: 201 });
      }
      case "addHook": {
        const h = await addCheckHook(ws.id, b);
        return Response.json({ id: h.id, secret: h.secret }, { status: 201 });
      }
      case "remove":
        await removeEndpoint(ws.id, b.id ?? "");
        return Response.json({ ok: true });
      case "toggle":
        await toggleDestination(ws.id, b.id ?? "", !!b.enabled);
        return Response.json({ ok: true });
      case "test":
        return Response.json(await testDestination(ws.id, b.id ?? ""));
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof EventError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
