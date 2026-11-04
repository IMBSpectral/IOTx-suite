import { requireProjectPerm } from "@/lib/iotx/permissions";
import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { EXPIRY, hashPassword, newToken, previewLinkUrl, type Expiry } from "@/lib/sharing";
import { ensureMainSnapshot } from "@/lib/publish";

type Ctx = { params: Promise<{ id: string }> };

/** Create a named preview link ("Client review"), optionally expiring and password-protected. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "admin");
  await requireProjectPerm(user.id, id, "builder.preview_links");
  const body = (await req.json()) as { name?: string; expires?: Expiry; password?: string; allowComments?: boolean };

  const name = body.name?.trim().slice(0, 80);
  if (!name) return Response.json({ error: "Give the link a name." }, { status: 400 });
  const expires: Expiry = body.expires && body.expires in EXPIRY ? body.expires : "7d";
  const password = body.password?.trim();
  if (password && password.length < 6) {
    return Response.json({ error: "Passwords need at least 6 characters." }, { status: 400 });
  }
  // Workspace policy on preview links.
  const { workspace } = await db.project.findUniqueOrThrow({ where: { id }, select: { workspace: { select: { previewSharing: true } } } });
  if (workspace.previewSharing === "off") {
    return Response.json({ error: "Preview links are turned off for this workspace." }, { status: 403 });
  }
  if (workspace.previewSharing === "password" && !password) {
    return Response.json({ error: "This workspace requires a password on preview links." }, { status: 400 });
  }

  const link = await db.previewLink.create({
    data: {
      projectId: id,
      name,
      token: newToken(),
      expiresAt: EXPIRY[expires] ? new Date(Date.now() + EXPIRY[expires]) : null,
      passwordHash: password ? await hashPassword(password) : null,
      allowComments: !!body.allowComments,
      createdById: user.id,
    },
  });
  // Warm the build so the first guest doesn't wait for it.
  void ensureMainSnapshot(id).catch(() => undefined);
  return Response.json({ id: link.id, url: previewLinkUrl(link.token) }, { status: 201 });
}

/** Revoke a link; it stops working immediately. */
async function DELETE_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "admin");
  await requireProjectPerm(user.id, id, "builder.preview_links");
  const linkId = new URL(req.url).searchParams.get("linkId");
  const link = linkId ? await db.previewLink.findUnique({ where: { id: linkId } }) : null;
  if (!link || link.projectId !== id) return Response.json({ error: "Not found" }, { status: 404 });
  await db.previewLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
  return Response.json({ ok: true });
}

export const POST = route(POST_);
export const DELETE = route(DELETE_);
