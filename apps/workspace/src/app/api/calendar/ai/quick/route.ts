import { requireMe } from "@/lib/auth";
import { quickAdd } from "@/lib/cal-ai";
import { body, route } from "@/lib/http";

/** POST { text } -> a draft event (with matched people, notes, conflicts) or 3 suggested slots. Nothing is saved. */
async function POST_(req: Request) {
  const me = await requireMe(["calendar.open", "calendar.create"]);
  const b = await body<{ text?: string }>(req);
  return Response.json(await quickAdd(me, String(b.text ?? "")));
}

export const POST = route(POST_);
