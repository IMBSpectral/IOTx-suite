import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";

/** Helpful / not helpful on an agent reply. Sending the same value clears it. */
async function POST_(req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  const user = await requireUser();
  const msg = await db.message.findUnique({ where: { id: messageId } });
  if (!msg) return new Response("Not found", { status: 404 });
  await requireProject(user.id, msg.projectId);
  const { value } = (await req.json().catch(() => ({}))) as { value?: string };
  if (value !== "up" && value !== "down") {
    return Response.json({ error: "value must be up or down" }, { status: 400 });
  }
  const next = msg.feedback === value ? null : value;
  await db.message.update({ where: { id: messageId }, data: { feedback: next } });
  return Response.json({ ok: true, feedback: next });
}

export const POST = route(POST_);
