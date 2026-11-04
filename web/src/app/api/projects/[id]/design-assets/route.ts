import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { repoDir } from "@/lib/paths";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { addAsset, AssetError, listAssets, removeAsset } from "@/lib/design-assets";

type Ctx = { params: Promise<{ id: string }> };

async function designSystem(userId: string, id: string, access: "view" | "edit") {
  await requireProject(userId, id, access);
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { kind: true } });
  if (p.kind !== "design_system") throw new AssetError("Only design systems have an asset bundle.");
}

/** A design system's asset bundle. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  try {
    await designSystem(user.id, id, "view");
  } catch (e) {
    if (e instanceof AssetError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const raw = new URL(_req.url).searchParams.get("raw");
  if (raw) {
    // One asset's bytes, for previews. SVGs can carry script, so they're sandboxed.
    const name = path.basename(raw);
    const bytes = await fs.readFile(path.join(repoDir(id), "assets", name)).catch(() => null);
    if (!bytes) return Response.json({ error: "Not found" }, { status: 404 });
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const type = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", ico: "image/x-icon" }[ext] ?? "application/octet-stream";
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": type, "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" },
    });
  }
  return Response.json({ assets: await listAssets(id) });
}

/** Add an asset (multipart "file"). */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  try {
    await designSystem(user.id, id, "edit");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Attach a file." }, { status: 400 });
    const name = await addAsset(id, file.name, Buffer.from(await file.arrayBuffer()));
    return Response.json({ name, assets: await listAssets(id) }, { status: 201 });
  } catch (e) {
    if (e instanceof AssetError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

async function DELETE_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  try {
    await designSystem(user.id, id, "edit");
  } catch (e) {
    if (e instanceof AssetError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const name = new URL(req.url).searchParams.get("name") ?? "";
  await removeAsset(id, name);
  return Response.json({ assets: await listAssets(id) });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
