import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { dailyIdea, setIdeas } from "@/lib/daily-ideas";

type Ctx = { params: Promise<{ id: string }> };

/** Today's build idea for the project (people who can edit it). */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  return Response.json(await dailyIdea(id, user.id));
}

/** {action: "dismiss" | "off" | "on"} */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action !== "dismiss" && action !== "off" && action !== "on") return Response.json({ error: "Unknown action" }, { status: 400 });
  await setIdeas(id, action);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
