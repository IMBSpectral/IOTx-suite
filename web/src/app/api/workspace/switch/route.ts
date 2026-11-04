import { db } from "@/lib/db";
import { requireUser, WORKSPACE_COOKIE } from "@/lib/workspace";
import { route } from "@/lib/route";

/** Switch the active workspace. Membership is checked again on every request. */
async function POST_(req: Request) {
  const user = await requireUser();
  const { workspaceId } = (await req.json().catch(() => ({}))) as { workspaceId?: string };
  const m = workspaceId
    ? await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId } } })
    : null;
  if (!m) return Response.json({ error: "Not a member of that workspace" }, { status: 403 });
  const res = Response.json({ ok: true });
  res.headers.append(
    "set-cookie",
    `${WORKSPACE_COOKIE}=${m.workspaceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  );
  return res;
}

export const POST = route(POST_);
