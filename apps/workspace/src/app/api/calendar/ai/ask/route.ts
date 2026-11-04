import { requireMe } from "@/lib/auth";
import { askCalendar, type ChatTurn } from "@/lib/cal-ai";
import { body, route } from "@/lib/http";

/** POST { question, history? } -> { answer, actions (drafts to confirm), looked } */
async function POST_(req: Request) {
  const me = await requireMe("calendar.open");
  const b = await body<{ question?: string; history?: ChatTurn[] }>(req);
  const history = (Array.isArray(b.history) ? b.history : []).filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.text === "string");
  return Response.json(await askCalendar(me, history, String(b.question ?? "")));
}

export const POST = route(POST_);
