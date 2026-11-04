import { getMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { transcript } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";

/** GET -> { lines: [{ name, text, at }] } the caption transcript with speakers and times. */
async function GET_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ lines: await transcript(await getMe(), m, req.headers.get("x-meet-guest")) });
}

export const GET = route(GET_);
