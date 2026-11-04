import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { answerCleanup, GRACE_DAYS } from "@/lib/housekeeping";

type Ctx = { params: Promise<{ id: string }> };

/** Abandoned-project clean-up state: when it would be deleted, and whether it's protected. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "view");
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { abandonedNoticeAt: true, cleanupProtected: true } });
  return Response.json({
    protected: p.cleanupProtected,
    deletesAt: p.abandonedNoticeAt ? new Date(p.abandonedNoticeAt.getTime() + GRACE_DAYS * 86_400_000).toISOString() : null,
  });
}

/** "Keep it" or "Protect it" (admins), or turn protection off. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "admin");
  const { choice } = (await req.json().catch(() => ({}))) as { choice?: string };
  if (choice === "keep" || choice === "protect") await answerCleanup(id, choice);
  else if (choice === "unprotect") await db.project.update({ where: { id }, data: { cleanupProtected: false } });
  else return Response.json({ error: "Choose keep, protect or unprotect." }, { status: 400 });
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
