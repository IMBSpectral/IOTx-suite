import { verifyPass } from "@/lib/iotx/pass";
import { effective } from "@/lib/iotx/permissions";
import { route } from "@/lib/route";

/**
 * POST /api/iotx/verify { token, app?, keys?: string[] }
 * For apps: checks a pass and, with `keys`, answers live permission
 * decisions for its holder (so a switch turned off takes effect before the
 * pass expires). Apps should cache the answer for a few seconds.
 */
async function POST_(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { token?: string; app?: string; keys?: string[] };
  if (!b.token) return Response.json({ valid: false, error: "token is required" }, { status: 400 });
  const claims = await verifyPass(b.token, b.app);
  if (!claims) return Response.json({ valid: false }, { status: 401 });
  let decisions: Record<string, boolean> | undefined;
  if (b.keys?.length) {
    const e = await effective(claims.sub, claims.ws);
    decisions = Object.fromEntries(b.keys.slice(0, 100).map((k) => [k, !!e && e.keys.includes(k)]));
  }
  return Response.json({ valid: true, claims, decisions });
}

export const POST = route(POST_);
