import { requireMe } from "@/lib/auth";
import { openDm } from "@/lib/chat";
import { body, route } from "@/lib/http";

/** POST { userId } or { userIds } -> { channel } the direct or group message with those people (created once). */
async function POST_(req: Request) {
  const me = await requireMe("teamchat.open");
  const b = await body<{ userId?: string; userIds?: string[] }>(req);
  const ids = Array.isArray(b.userIds) ? b.userIds.map(String) : [String(b.userId ?? "")];
  return Response.json({ channel: await openDm(me, ids) });
}

export const POST = route(POST_);
