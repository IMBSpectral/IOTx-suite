import { can, requireMe } from "@/lib/auth";
import { applyAction, type Action } from "@/lib/cal-ai";
import { afterLocalChange } from "@/lib/google";
import { bad, body, route } from "@/lib/http";

/**
 * POST { action } -> runs one confirmed draft (create / update / delete) with
 * the person's own permissions, exactly as if they had done it by hand.
 */
async function POST_(req: Request) {
  const b = await body<{ action?: Action }>(req);
  const a = b.action;
  if (!a || !["create", "update", "delete"].includes(a.kind)) bad("Nothing to apply.");
  const me = await requireMe(a.kind === "create" ? ["calendar.open", "calendar.create"] : "calendar.open");
  const r = await applyAction(me, a);
  const id = "event" in r && r.event ? r.event.id : a.kind !== "create" ? a.eventId : null;
  if (id) await afterLocalChange(me.userId, me.ws, id, can(me, "calendar.google"));
  return Response.json({ ok: true, ...r }, { status: a.kind === "create" ? 201 : 200 });
}

export const POST = route(POST_);
