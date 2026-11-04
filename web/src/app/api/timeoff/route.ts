import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError } from "@/lib/iotx/permissions";
import { cancelTimeOff, decideTimeOff, requestTimeOff, savePolicy, timeOffView } from "@/lib/timeoff";

/**
 * People → Time off.
 *   GET ?month=YYYY-MM  -> { mine, waiting, chart, types, myApprover, takenThisYear, admin }
 *   POST { action: "request", type, start, end?, halfDay?, reason? }
 *   POST { action: "decide", id, approve, note? }      the approver, or an owner or admin
 *   POST { action: "cancel", id }                      the person (before it starts), or an admin
 *   POST { action: "policy", leaveAllowance?, holidays?, weekOff? }   owners and admins
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  return Response.json(await timeOffView(user.id, ws.id, new URL(req.url).searchParams.get("month") ?? ""));
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  try {
    switch (b.action) {
      case "request":
        return Response.json({ request: await requestTimeOff(user.id, ws.id, b) }, { status: 201 });
      case "decide":
        return Response.json({ request: await decideTimeOff(user.id, ws.id, id, b.approve === true, typeof b.note === "string" ? b.note : undefined) });
      case "policy":
        return Response.json({ policy: await savePolicy(user.id, ws.id, b) });
      case "cancel":
        return Response.json({ request: await cancelTimeOff(user.id, ws.id, id) });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof PermissionError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
