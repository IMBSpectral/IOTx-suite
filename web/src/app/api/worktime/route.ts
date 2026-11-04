import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError } from "@/lib/iotx/permissions";
import { clockIn, clockOut, myWorkTime, reviewReport, saveReport, teamWorkTime } from "@/lib/worktime";

/**
 * People → Work time.
 *   GET                 -> mine: { open, todayMinutes, weekMinutes, sessions, report, recent, managerId }
 *   GET ?team=1&day=    -> { people: [{ userId, in, todayMinutes, weekMinutes, report }], day, admin }   my reporting line (admins: everyone)
 *   POST { action: "in", note? } | { action: "out" }
 *   POST { action: "report", date?, done, next?, blockers? }      to my manager
 *   POST { action: "review", id, comment? }                        the manager or an admin
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  if (q.get("team")) return Response.json(await teamWorkTime(user.id, ws.id, q.get("day") ?? undefined));
  return Response.json(await myWorkTime(user.id, ws.id));
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    switch (b.action) {
      case "in":
        return Response.json({ session: await clockIn(user.id, ws.id, typeof b.note === "string" ? b.note : undefined) });
      case "out":
        return Response.json({ session: await clockOut(user.id, ws.id) });
      case "report":
        return Response.json({ report: await saveReport(user.id, ws.id, b) });
      case "review":
        return Response.json({ report: await reviewReport(user.id, ws.id, String(b.id ?? ""), typeof b.comment === "string" ? b.comment : undefined) });
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
