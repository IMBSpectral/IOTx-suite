import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { addCaption } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/** POST { text } -> a finished caption line from my microphone (saved into the transcript). */
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  const b = await body<{ text?: string }>(req);
  return Response.json(await addCaption(await getMe(), m, key(req), String(b.text ?? "")), { status: 201 });
}

export const POST = route(POST_);
