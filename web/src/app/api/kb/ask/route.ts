import { ask } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";
import { assertCredits } from "@/lib/credits";

/** POST { question } -> { answer, found, sources } answered only from the knowledge base, with citations (read.ask). */
async function POST_(req: Request) {
  const v = await kbViewer("read.ask");
  await assertCredits(v.workspaceId, { userId: v.userId });
  const b = (await req.json().catch(() => ({}))) as { question?: string };
  return Response.json(await ask(v, String(b.question ?? "")));
}

export const POST = kbRoute(POST_);
