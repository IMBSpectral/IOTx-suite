import { db } from "@/lib/db";
import { addSource, listSources } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

/**
 * Google Drive folders kept in the knowledge base.
 * GET -> { sources, googleConnected } · POST { folder (link or id), kind?, tags?, audience? } -> { source, added, updated, archived, failed }  (read.publish)
 */
async function GET_() {
  const v = await kbViewer();
  const g = await db.googleConnection.findUnique({ where: { userId: v.userId }, select: { email: true } });
  return Response.json({ sources: await listSources(v), googleConnected: !!g, googleEmail: g?.email ?? null });
}
async function POST_(req: Request) {
  const v = await kbViewer("read.publish");
  return Response.json(await addSource(v, await req.json().catch(() => ({}))), { status: 201 });
}

export const GET = kbRoute(GET_);
export const POST = kbRoute(POST_);
