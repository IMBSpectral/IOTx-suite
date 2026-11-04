import { requireMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { createToken, listTokens } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

/**
 * Browser extension and API (MCP) tokens, mine.
 * GET  -> { tokens }
 * POST { name?, kind?: "extension" | "api" } -> 201 { token (shown once), pairCode (extension: valid 10 min), pairUntil, item }
 */
async function GET_() {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json({ tokens: await listTokens(me) });
}

async function POST_(req: Request) {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await createToken(me, await body(req)), { status: 201, headers: { "cache-control": "no-store" } });
}

export const GET = route(GET_);
export const POST = route(POST_);
