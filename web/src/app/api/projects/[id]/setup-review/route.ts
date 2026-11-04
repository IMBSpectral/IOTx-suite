import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { reviewSetup } from "@/lib/setup-review";

type Ctx = { params: Promise<{ id: string }> };

/** "Review project setup" before publishing. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "view");
  return Response.json({ items: await reviewSetup(id) });
}

export const GET = route(GET_);
