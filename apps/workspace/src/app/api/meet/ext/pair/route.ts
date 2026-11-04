import { body, route } from "@/lib/http";
import { clientIp } from "@/lib/meet/meetings";
import { pair } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

/** The extension: POST { code, name? } -> { token, user, ws }. No session; the one-time code is the proof. */
async function POST_(req: Request) {
  const b = await body<{ code?: string; name?: string }>(req);
  return Response.json(await pair(b.code, clientIp(req), b.name), { headers: { "cache-control": "no-store" } });
}

export const POST = route(POST_);
