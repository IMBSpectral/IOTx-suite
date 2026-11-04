import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PROJECTS_ROOT } from "@/lib/paths";
import { cleanAppearance, paintPayload, type Appearance } from "@/lib/iotx/appearance";
import { loadAppearance } from "@/lib/iotx/appearance-server";

/**
 * The signed-in person's IOTx Suite appearance.
 *   GET               -> { appearance, paint }
 *   GET ?bg=<file>    -> their uploaded background image
 *   POST json         -> save theme / accent / accentCustom / shellBg
 *   POST multipart    -> upload a background image (JPG, PNG or WebP, 5 MB), returns its url
 */
const DIR = path.join(PROJECTS_ROOT, "_forge", "backgrounds");
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

async function GET_(req: Request) {
  const user = await requireUser();
  const bg = new URL(req.url).searchParams.get("bg");
  if (bg) {
    // Only the person's own files: names start with their id.
    if (!/^[\w-]+\.(jpg|png|webp)$/.test(bg) || !bg.startsWith(`${user.id}-`)) return new Response("Not found", { status: 404 });
    const bytes = await fs.readFile(path.join(DIR, bg)).catch(() => null);
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(bytes), { headers: { "content-type": MIME[bg.split(".").pop()!], "cache-control": "private, max-age=86400" } });
  }
  const appearance = await loadAppearance(user.id);
  return Response.json({ appearance, paint: paintPayload(appearance) });
}

async function POST_(req: Request) {
  const user = await requireUser();
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose an image." }, { status: 400 });
    const ext = TYPES[file.type];
    if (!ext) return Response.json({ error: "Use a JPG, PNG or WebP image." }, { status: 400 });
    if (file.size > 5 * 1024 * 1024) return Response.json({ error: "Images up to 5 MB." }, { status: 400 });
    await fs.mkdir(DIR, { recursive: true });
    const name = `${user.id}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    await fs.writeFile(path.join(DIR, name), Buffer.from(await file.arrayBuffer()));
    return Response.json({ url: `/api/account/appearance?bg=${name}` }, { status: 201 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const next = cleanAppearance(body as Partial<Appearance>, await loadAppearance(user.id));
  await db.user.update({
    where: { id: user.id },
    data: { theme: next.theme, accent: next.accent, accentCustom: next.accentCustom, shellBg: next.shellBg as object },
  });
  return Response.json({ appearance: next, paint: paintPayload(next) });
}

export const GET = route(GET_);
export const POST = route(POST_);
