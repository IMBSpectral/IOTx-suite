import { requireMe } from "@/lib/auth";
import { addAttachment } from "@/lib/tasks-plan";
import { bad, route } from "@/lib/http";

/** POST multipart (file) -> { attachment }: up to 25 MB, 50 per issue */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("tasks.open");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) bad("Choose a file.");
  const a = await addAttachment(me, (await ctx.params).id, file);
  return Response.json({ attachment: { id: a.id, name: a.name, type: a.type, size: a.size, userId: a.userId, createdAt: a.createdAt } }, { status: 201 });
}

export const POST = route(POST_);
