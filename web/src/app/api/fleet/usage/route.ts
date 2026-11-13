import { fleetKeyOk, localUsage } from "@/lib/fleet";
import { route } from "@/lib/route";

/**
 * This server's AI usage, summed (no prompts or replies), for the fleet's control server.
 * GET ?days=30 with header x-iotx-fleet-key: <IOTX_FLEET_KEY>.
 */
async function GET_(req: Request) {
  if (!fleetKeyOk(req)) return Response.json({ error: "Not allowed." }, { status: 401 });
  const days = Math.max(0, Math.min(3650, Number(new URL(req.url).searchParams.get("days")) || 0));
  return Response.json(await localUsage(days));
}

export const GET = route(GET_);
