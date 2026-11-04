import { requireMe } from "@/lib/auth";
import { people } from "@/lib/calendar";
import { route } from "@/lib/http";

/** GET -> people in my workspace (everyone who has opened IOTx Workspace there). */
async function GET_() {
  const me = await requireMe();
  return Response.json({ people: await people(me.ws) });
}

export const GET = route(GET_);
