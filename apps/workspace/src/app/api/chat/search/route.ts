import { requireMe } from "@/lib/auth";
import { search } from "@/lib/chat";
import { route } from "@/lib/http";

/** GET ?q= -> { results } messages in channels I can see */
async function GET_(req: Request) {
  const me = await requireMe("teamchat.open");
  return Response.json({ results: await search(me, new URL(req.url).searchParams.get("q") ?? "") });
}

export const GET = route(GET_);
