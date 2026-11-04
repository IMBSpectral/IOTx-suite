import crypto from "node:crypto";
import { route } from "@/lib/route";
import { calendarAccessToken, GoogleError } from "@/lib/google";

/**
 * POST /api/iotx/google-token { userId }   header x-iotx-key: <IOTX_SERVICE_KEY>
 * Server to server, for IOTx Workspace Calendar: a fresh Google access token
 * for that person when their Google connection includes Calendar access,
 * else 409 { reconnect: true }. Never reachable from a browser without the key.
 */
function keyOk(given: string | null) {
  const want = process.env.IOTX_SERVICE_KEY;
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function POST_(req: Request) {
  if (!keyOk(req.headers.get("x-iotx-key"))) return Response.json({ error: "Forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { userId?: string };
  if (!b.userId) return Response.json({ error: "userId is required" }, { status: 400 });
  try {
    const token = await calendarAccessToken(b.userId);
    if (!token) return Response.json({ reconnect: true, error: "Google Calendar isn't connected." }, { status: 409 });
    return Response.json({ accessToken: token }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof GoogleError) return Response.json({ reconnect: true, error: e.message }, { status: 409 });
    throw e;
  }
}

export const POST = route(POST_);
