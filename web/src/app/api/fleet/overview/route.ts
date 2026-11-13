import { requireUser } from "@/lib/workspace";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { deploymentLog, fleetUsage, isFleetControl } from "@/lib/fleet";
import { route } from "@/lib/route";

/**
 * Admin → Deployments, on the control server only (platform admins):
 *   GET ?view=log            -> the deployment log and the server list
 *   GET ?view=usage&days=30  -> every server's AI usage
 */
async function GET_(req: Request) {
  const user = await requireUser();
  if (!isFleetControl() || !isPlatformAdmin(user.email)) return Response.json({ error: "Only the people who run this platform can see this." }, { status: 403 });
  const q = new URL(req.url).searchParams;
  if (q.get("view") === "usage") {
    const days = Math.max(0, Math.min(3650, Number(q.get("days")) || 0));
    return Response.json({ days, servers: await fleetUsage(days) });
  }
  return Response.json(await deploymentLog());
}

export const GET = route(GET_);
