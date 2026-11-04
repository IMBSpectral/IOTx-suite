import sharp from "sharp";

/**
 * Large photos and screenshots attached to chat are shrunk before the agent
 * sees them: at most 2560px on the long side and re-encoded, which keeps them
 * well inside the model's image limits and makes turns faster and cheaper.
 * The original is kept for when the agent copies the file into the app.
 */
export const MAX_SIDE = 2560;
export const COMPRESS_OVER_BYTES = 1_500_000;
const FORMATS = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function compressImage(bytes: Buffer, type: string): Promise<Buffer | null> {
  if (!FORMATS.has(type)) return null;
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    return null;
  }
  const big = Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_SIDE;
  if (!big && bytes.length <= COMPRESS_OVER_BYTES) return null;
  let img = sharp(bytes).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
  img =
    type === "image/jpeg"
      ? img.jpeg({ quality: 85, mozjpeg: true })
      : type === "image/webp"
        ? img.webp({ quality: 85 })
        : img.png({ compressionLevel: 9, palette: !meta.hasAlpha && bytes.length > COMPRESS_OVER_BYTES });
  const out = await img.toBuffer();
  return out.length < bytes.length || big ? out : null;
}
