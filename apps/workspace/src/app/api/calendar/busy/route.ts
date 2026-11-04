import { requireMe } from "@/lib/auth";
import { busy } from "@/lib/calendar";
import { bad, route } from "@/lib/http";

/** GET ?users=a,b&from=ISO&to=ISO -> { busy: { userId: [{ start, end }] } }  ("Find a time") */
async function GET_(req: Request) {
  const me = await requireMe("calendar.open");
  const q = new URL(req.url).searchParams;
  const from = new Date(q.get("from") ?? "");
  const to = new Date(q.get("to") ?? "");
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 15 * 86_400_000) bad("Give a range of up to 15 days.");
  const users = (q.get("users") ?? "").split(",").filter(Boolean);
  return Response.json({ busy: await busy(me, users, from, to) });
}

export const GET = route(GET_);
