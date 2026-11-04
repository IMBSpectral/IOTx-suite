import { requireMe } from "@/lib/auth";
import { listFiles } from "@/lib/chat";
import { route } from "@/lib/http";

/** GET ?q= -> { files } shared in channels I can see */
async function GET_(req: Request) {
  const me = await requireMe("teamchat.open");
  return Response.json({ files: await listFiles(me, { q: new URL(req.url).searchParams.get("q") ?? "" }) });
}

export const GET = route(GET_);
