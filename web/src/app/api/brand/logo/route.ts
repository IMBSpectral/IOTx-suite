import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { readLogo, removeLogo, saveLogo } from "@/lib/brand";

/**
 * The platform logo.
 *   GET              -> the image (public)
 *   POST multipart   -> platform admins upload PNG, SVG, WebP or JPG (1 MB)
 *   DELETE           -> back to the text mark
 */
const EXT: Record<string, string> = { "image/png": "png", "image/svg+xml": "svg", "image/webp": "webp", "image/jpeg": "jpg" };

async function GET_() {
  const logo = await readLogo();
  if (!logo) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(logo.bytes), {
    headers: {
      "content-type": logo.type,
      "cache-control": "public, max-age=31536000, immutable",
      // An SVG opened on its own must never run script.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

async function admin() {
  const user = await requireUser();
  return isPlatformAdmin(user.email);
}

async function POST_(req: Request) {
  if (!(await admin())) return Response.json({ error: "Only platform admins can change branding." }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Choose an image" }, { status: 400 });
  const ext = EXT[file.type];
  if (!ext) return Response.json({ error: "Use a PNG, SVG, WebP or JPG" }, { status: 400 });
  if (file.size > 1024 * 1024) return Response.json({ error: "The logo must be under 1 MB" }, { status: 400 });
  return Response.json({ brand: await saveLogo(Buffer.from(await file.arrayBuffer()), ext) });
}

async function DELETE_() {
  if (!(await admin())) return Response.json({ error: "Only platform admins can change branding." }, { status: 403 });
  return Response.json({ brand: await removeLogo() });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
