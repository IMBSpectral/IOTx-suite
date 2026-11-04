import { route } from "@/lib/route";
import { poll } from "@/lib/device-auth";

/** The device checks whether its code was approved; the session is handed over once. */
async function POST_(req: Request) {
  const { deviceCode } = (await req.json().catch(() => ({}))) as { deviceCode?: string };
  if (!deviceCode) return Response.json({ error: "deviceCode is required" }, { status: 400 });
  return Response.json(await poll(deviceCode));
}

export const POST = route(POST_);
