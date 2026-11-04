import { versions } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

/** GET -> { versions } earlier versions of the article, newest first */
async function GET_(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const v = await kbViewer();
  return Response.json({ versions: await versions(v, (await params).id) });
}

export const GET = kbRoute(GET_);
