import { search } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

/** GET ?q= -> { hits } passages from articles I can see, best first */
async function GET_(req: Request) {
  const v = await kbViewer();
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json({ hits: await search(v, q, { limit: 20 }) });
}

export const GET = kbRoute(GET_);
