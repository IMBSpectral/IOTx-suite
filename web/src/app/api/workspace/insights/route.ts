import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { toCsv, workspaceInsights } from "@/lib/insights";

/** Workspace insights for owners and admins; ?format=csv&kind=apps|builders downloads a table. */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const data = await workspaceInsights(ws.id, user.id);
  const q = new URL(req.url).searchParams;
  if (q.get("format") === "csv") {
    const kind = q.get("kind") === "builders" ? "builders" : "apps";
    const rows = (kind === "builders" ? data.builders : data.apps) as unknown as Record<string, unknown>[];
    return new Response(toCsv(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${ws.slug}-${kind}-insights.csv"`,
      },
    });
  }
  return Response.json(data);
}

export const GET = route(GET_);
