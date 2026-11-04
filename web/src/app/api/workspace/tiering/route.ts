import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { audit } from "@/lib/workspace-security";
import { saveTiering, setLabels, TierError, tieredApps } from "@/lib/tiering";

/** App tiers and admin labels (owners and admins). */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  try {
    return Response.json(await tieredApps(ws.id));
  } catch (e) {
    if (e instanceof TierError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** rules {yaml} · labels {projectId, labels[]} */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const b = (await req.json().catch(() => ({}))) as { action?: string; yaml?: string; projectId?: string; labels?: string[] };
  try {
    if (b.action === "rules") {
      await saveTiering(ws.id, b.yaml ?? "");
      await audit(ws.id, user.id, "rules.changed", "Updated app tiering rules");
      return Response.json(await tieredApps(ws.id));
    }
    if (b.action === "labels") return Response.json({ labels: await setLabels(ws.id, b.projectId ?? "", Array.isArray(b.labels) ? b.labels : []) });
    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof TierError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
