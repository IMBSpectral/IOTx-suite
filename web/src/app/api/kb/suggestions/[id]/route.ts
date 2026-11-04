import { review } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

/** POST { action: "approve" | "reject", title?, body?, kind?, tags? } (read.review) */
async function POST_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const v = await kbViewer();
  return Response.json(await review(v, (await params).id, await req.json().catch(() => ({}))));
}

export const POST = kbRoute(POST_);
