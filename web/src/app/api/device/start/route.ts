import { db } from "@/lib/db";
import { route } from "@/lib/route";
import { startDeviceAuth } from "@/lib/device-auth";

/** A device (desktop app, CLI) asks to sign in; it shows the user code and polls. */
async function POST_(req: Request) {
  // A coarse brake on code requests: they're unauthenticated.
  const recent = await db.deviceAuth.count({ where: { createdAt: { gte: new Date(Date.now() - 60_000) } } });
  if (recent >= 30) return Response.json({ error: "Too many sign-in requests. Try again in a minute." }, { status: 429 });
  const { clientName } = (await req.json().catch(() => ({}))) as { clientName?: string };
  const r = await startDeviceAuth(clientName ?? "");
  const origin = process.env.EDITOR_ORIGIN ?? new URL(req.url).origin;
  return Response.json({ ...r, verifyUrl: `${origin}/device?code=${r.userCode}`, interval: 3 }, { status: 201 });
}

export const POST = route(POST_);
