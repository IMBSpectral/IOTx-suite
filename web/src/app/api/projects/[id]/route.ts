import { db } from "@/lib/db";
import { projectEntitlements } from "@/lib/entitlements";
import { requireUser, requireProject } from "@/lib/workspace";
import { requirePerm } from "@/lib/iotx/permissions";
import { purgeProjectData } from "@/lib/purge";
import { route } from "@/lib/route";
import { RESERVED_SUBDOMAINS } from "@/lib/site-host";

type Ctx = { params: Promise<{ id: string }> };

type Patch = {
  name?: string;
  description?: string | null;
  customDomain?: string | null;
  subdomain?: string;
  emoji?: string | null;
  notes?: string | null;
  isTemplate?: boolean;
  folderId?: string | null;
  restore?: boolean;
};

async function PATCH_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");

  const body = (await req.json()) as Patch;
  // IOTx Suite switches: the subdomain, a custom domain and moving between folders.
  if (body.customDomain !== undefined) await requirePerm(user.id, project.workspaceId, "builder.domain.custom");
  if (typeof body.subdomain === "string") await requirePerm(user.id, project.workspaceId, "builder.domain.subdomain");
  if (body.folderId !== undefined) await requirePerm(user.id, project.workspaceId, "builder.project.transfer");
  const data: Record<string, unknown> = {};

  if (typeof body.name === "string") {
    const name = body.name.trim().slice(0, 80);
    if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
    data.name = name;
  }
  if (body.description !== undefined) {
    data.description = body.description?.trim().slice(0, 500) || null;
  }
  if (body.customDomain !== undefined) {
    const domain = body.customDomain?.trim().toLowerCase() || null;
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      return Response.json({ error: "That domain is not valid" }, { status: 400 });
    }
    if (domain && !(await projectEntitlements(id)).customDomain) {
      return Response.json({ error: "Custom domains need a paid plan. Upgrade in Settings → Billing.", upgrade: true }, { status: 402 });
    }
    data.customDomain = domain;
  }
  if (typeof body.subdomain === "string") {
    // Becomes <subdomain>.localhost / <subdomain>.<host>: DNS label rules.
    const sub = body.subdomain.trim().toLowerCase();
    // "--" is reserved for preview hosts (preview--<token>).
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(sub) || sub.includes("--")) {
      return Response.json(
        { error: "Use 3–63 lowercase letters, numbers or hyphens, not starting or ending with a hyphen." },
        { status: 400 },
      );
    }
    if (RESERVED_SUBDOMAINS.has(sub)) return Response.json({ error: "That name is reserved. Pick another." }, { status: 400 });
    data.subdomain = sub;
  }
  if (body.emoji !== undefined) {
    // A single emoji (possibly multi-codepoint), not arbitrary text.
    const e = body.emoji?.trim() ?? "";
    if (e && [...e].length > 8) return Response.json({ error: "Pick one emoji" }, { status: 400 });
    data.emoji = e || null;
  }
  if (body.notes !== undefined) data.notes = body.notes?.slice(0, 100_000) ?? null;
  if (typeof body.isTemplate === "boolean") data.isTemplate = body.isTemplate;
  if (body.folderId !== undefined) {
    if (body.folderId) {
      const folder = await db.folder.findFirst({
        where: { id: body.folderId, workspaceId: project.workspaceId },
      });
      if (!folder) return Response.json({ error: "Folder not found" }, { status: 404 });
    }
    data.folderId = body.folderId || null;
  }
  if (body.restore === true) data.deletedAt = null;

  if (Object.keys(data).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    const updated = await db.project.update({ where: { id }, data });
    return Response.json({ project: updated });
  } catch {
    return Response.json({ error: "That domain or address is already taken" }, { status: 409 });
  }
}

/**
 * Delete a project. By default it moves to "Recently deleted", where it can be
 * restored; `?permanent=1` removes it and its repository for good.
 */
async function DELETE_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const doomed = await requireProject(user.id, id, "admin");
  await requirePerm(user.id, doomed.workspaceId, "builder.project.delete");

  if (new URL(req.url).searchParams.get("permanent") === "1") {
    // Rows first: if the disk removal fails the project is already gone from
    // the UI, and an orphaned directory is harmless.
    await db.project.delete({ where: { id } });
    await purgeProjectData(id);
    return Response.json({ ok: true, permanent: true });
  }

  await db.project.update({ where: { id }, data: { deletedAt: new Date() } });
  return Response.json({ ok: true, permanent: false });
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
