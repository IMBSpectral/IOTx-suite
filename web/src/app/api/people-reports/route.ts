import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError } from "@/lib/iotx/permissions";
import { loginHistory, timesheet, timesheetCsv } from "@/lib/people-reports";

/**
 * People → Reports.
 *   GET ?view=timesheet&month=YYYY-MM[&format=csv]   hours, presence, late, leave, absent per person and day
 *   GET ?view=logins&page=&size=&q=                   sign-ins (admins: everyone; others: their own)
 * Owners and admins see everyone; managers their reporting line; others themselves.
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  try {
    if (q.get("view") === "logins") return Response.json(await loginHistory(user.id, ws.id, { page: Number(q.get("page")) || 1, size: Number(q.get("size")) || 25, q: q.get("q") ?? undefined }));
    const t = await timesheet(user.id, ws.id, q.get("month") ?? "");
    if (q.get("format") === "csv")
      return new Response(timesheetCsv(t), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="timesheet-${t.month}.csv"` } });
    return Response.json(t);
  } catch (e) {
    if (e instanceof PermissionError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
