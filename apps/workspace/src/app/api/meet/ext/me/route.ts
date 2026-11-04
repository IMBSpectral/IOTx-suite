import { route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { tokenMe } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

/** The extension checks its token: GET (Bearer) -> { user, token, canRecord }. */
async function GET_(req: Request) {
  const { me, token } = await tokenMe(req);
  return Response.json({ user: { name: me.name, email: me.email }, token: { name: token.name, kind: token.kind }, canRecord: !!me.perms[MEET_KEYS.aiNotes] });
}

export const GET = route(GET_);
