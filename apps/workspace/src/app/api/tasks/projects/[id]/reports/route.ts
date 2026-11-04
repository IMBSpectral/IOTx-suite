import { requireMe } from "@/lib/auth";
import { burndown, flow, velocity, workload } from "@/lib/tasks-plan";
import { bad, route } from "@/lib/http";

/** GET ?kind=burndown (&sprint=) | velocity | flow (&days=) | workload */
async function GET_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("tasks.open");
  const id = (await ctx.params).id;
  const q = new URL(req.url).searchParams;
  const kind = q.get("kind");
  if (kind === "burndown") return Response.json(await burndown(me, id, q.get("sprint") || undefined));
  if (kind === "velocity") return Response.json({ sprints: await velocity(me, id) });
  if (kind === "flow") return Response.json({ days: await flow(me, id, Math.max(7, Math.min(180, Number(q.get("days")) || 30))) });
  if (kind === "workload") return Response.json({ people: await workload(me, id) });
  bad("Ask for burndown, velocity, flow or workload.");
}

export const GET = route(GET_);
