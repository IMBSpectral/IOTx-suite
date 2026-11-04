import { requireMe } from "@/lib/auth";
import { listGroups, saveGroup } from "@/lib/chat";
import { body, route } from "@/lib/http";

/** GET -> { groups } · POST { handle, name, memberIds } -> { group } (@handle mentions everyone in it) */
async function GET_() {
  const me = await requireMe("teamchat.open");
  return Response.json({ groups: await listGroups(me) });
}
async function POST_(req: Request) {
  const me = await requireMe("teamchat.open");
  return Response.json({ group: await saveGroup(me, null, await body(req)) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
