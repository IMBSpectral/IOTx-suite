import { gaps, resolveGap } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

/** GET -> { gaps } questions nobody could answer · POST { id } marks one dealt with */
async function GET_() {
  const v = await kbViewer();
  return Response.json({ gaps: await gaps(v) });
}
async function POST_(req: Request) {
  const v = await kbViewer();
  const b = (await req.json().catch(() => ({}))) as { id?: string };
  return Response.json(await resolveGap(v, String(b.id ?? "")));
}

export const GET = kbRoute(GET_);
export const POST = kbRoute(POST_);
