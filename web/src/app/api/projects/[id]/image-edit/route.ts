import { requireProjectPerm } from "@/lib/iotx/permissions";
import sharp from "sharp";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { readUpload, saveUpload } from "@/lib/uploads";
import { editImage, editPrompt, EDIT_MODES, imagesEnabled, IMAGE_CREDITS, type Pin } from "@/lib/images";
import { assertCredits, charge, InsufficientCredits, SpendLimitReached } from "@/lib/credits";

export const maxDuration = 240;

type Ctx = { params: Promise<{ id: string }> };
/**
 * The image editor: edit a chat image with a brushed mask, pinned notes and
 * an instruction, erase what's brushed, or remove the background. The result
 * is saved as a new attachment ("name.edit.png"); the original is untouched.
 */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.images");
  if (!imagesEnabled()) return Response.json({ error: "Image editing isn't set up on this server." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { uploadId?: string; mode?: string; prompt?: string; mask?: string; pins?: Pin[] };
  const mode = (body.mode && body.mode in EDIT_MODES ? body.mode : "edit") as keyof typeof EDIT_MODES;
  const pins = (Array.isArray(body.pins) ? body.pins : [])
    .filter((p) => typeof p?.note === "string" && p.note.trim() && Number.isFinite(p.x) && Number.isFinite(p.y))
    .slice(0, 10)
    .map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), note: p.note.slice(0, 300) }));
  const prompt = (body.prompt ?? "").slice(0, 2000);
  if (mode === "edit" && !prompt.trim() && !pins.length) return Response.json({ error: "Describe the change, or pin a note on the image." }, { status: 400 });
  if (mode === "erase" && !body.mask) return Response.json({ error: "Brush over what to erase first." }, { status: 400 });

  const upload = await readUpload(id, body.uploadId ?? "", { original: true });
  if (!upload || !/^image\/(png|jpeg|webp)$/.test(upload.meta.type)) {
    return Response.json({ error: "Pick a PNG, JPEG or WebP image from this project's chat." }, { status: 400 });
  }

  // The mask must match the image's size; the editor draws it at natural size, but be safe.
  let mask: Buffer | undefined;
  if (body.mask) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(body.mask);
    if (!m) return Response.json({ error: "The mask isn't a PNG." }, { status: 400 });
    const { width, height } = await sharp(upload.bytes).metadata();
    mask = await sharp(Buffer.from(m[1], "base64")).resize(width, height, { fit: "fill" }).ensureAlpha().png().toBuffer();
  }

  try {
    await assertCredits(project.workspaceId, { userId: user.id, projectId: id });
  } catch (e) {
    if (e instanceof InsufficientCredits || e instanceof SpendLimitReached) {
      return Response.json({ error: "Image edits use credits. Add credits to continue." }, { status: 402 });
    }
    throw e;
  }

  let bytes: Buffer;
  try {
    bytes = await editImage({
      image: upload.bytes,
      imageType: upload.meta.type,
      prompt: editPrompt(mode, prompt, pins),
      mask,
      transparent: mode === "remove_bg",
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "The image edit failed." }, { status: 502 });
  }
  await charge(project.workspaceId, IMAGE_CREDITS.medium, "GENERATION", undefined, { category: "media", userId: user.id, projectId: id });

  const base = upload.meta.name.replace(/(\.edit)?\.[^.]+$/, "");
  const attachment = await saveUpload(id, { name: `${base}.edit.png`, type: "image/png", bytes });
  return Response.json({ attachment, credits: IMAGE_CREDITS.medium }, { status: 201 });
}

export const POST = route(POST_);
