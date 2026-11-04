/**
 * AI image generation for generated apps, through the OpenAI Images API.
 *
 * Lovable's agent can generate and edit images (its `imagegen--generate_image`
 * tool), which is why its apps ship with real hero art and illustrations
 * instead of grey placeholders. This is the equivalent.
 */

const MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";

export type ImageShape = "square" | "landscape" | "portrait";
export type ImageQuality = "low" | "medium" | "high";
export type ImageFormat = "png" | "jpeg" | "webp";

const SIZES: Record<ImageShape, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

/**
 * Credits charged per image, by quality, on the same scale as builds (a credit
 * is about $0.12 of model cost, see credits.ts): a low or medium image costs
 * a few cents, a high-quality one about $0.20.
 */
export const IMAGE_CREDITS: Record<ImageQuality, number> = { low: 1, medium: 1, high: 2 };

export function imagesEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function generateImage(opts: {
  prompt: string;
  shape: ImageShape;
  quality: ImageQuality;
  format: ImageFormat;
  transparent: boolean;
}): Promise<{ bytes: Buffer; size: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Image generation is not configured (OPENAI_API_KEY is missing).");

  const size = SIZES[opts.shape];
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt: opts.prompt,
      size,
      quality: opts.quality,
      output_format: opts.format,
      // JPEG has no alpha channel, so transparency only applies to PNG/WebP.
      background: opts.transparent && opts.format !== "jpeg" ? "transparent" : "auto",
      n: 1,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  const body = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string }[];
    error?: { message?: string };
  } | null;

  if (!res.ok || !body?.data?.[0]?.b64_json) {
    throw new Error(body?.error?.message ?? `Image generation failed (HTTP ${res.status})`);
  }
  const raw = Buffer.from(body.data[0].b64_json, "base64");
  return { bytes: await compress(raw, opts.format), size };
}

/**
 * Re-encode for the web. The API returns near-lossless files of 1–1.6 MB;
 * quality 82 is visually identical at roughly a tenth of the size, which is
 * the difference between a page that loads and one that crawls on mobile.
 * Falls back to the original bytes if sharp is unavailable.
 */
async function compress(raw: Buffer, format: ImageFormat): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(raw);
    const out =
      format === "webp"
        ? img.webp({ quality: 82 })
        : format === "jpeg"
          ? img.jpeg({ quality: 82, mozjpeg: true })
          : img.png({ compressionLevel: 9, palette: true, quality: 90 });
    const buf = await out.toBuffer();
    return buf.length < raw.length ? buf : raw;
  } catch {
    return raw;
  }
}

/**
 * Edit an existing image (the image editor): optionally limited to a mask,
 * a PNG the same size as the image whose transparent pixels mark the area to
 * change. Returns a PNG so transparency (removed backgrounds) survives.
 */
export async function editImage(opts: {
  image: Buffer;
  imageType: string;
  prompt: string;
  mask?: Buffer;
  transparent?: boolean;
}): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Image editing is not configured (OPENAI_API_KEY is missing).");
  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", opts.prompt);
  form.append("image", new Blob([new Uint8Array(opts.image)], { type: opts.imageType }), `image.${opts.imageType.split("/")[1] ?? "png"}`);
  if (opts.mask) form.append("mask", new Blob([new Uint8Array(opts.mask)], { type: "image/png" }), "mask.png");
  form.append("quality", "medium");
  form.append("size", "auto");
  form.append("output_format", "png");
  if (opts.transparent) form.append("background", "transparent");
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await res.json().catch(() => null)) as { data?: { b64_json?: string }[]; error?: { message?: string } } | null;
  if (!res.ok || !body?.data?.[0]?.b64_json) {
    throw new Error(body?.error?.message ?? `Image edit failed (HTTP ${res.status})`);
  }
  return compress(Buffer.from(body.data[0].b64_json, "base64"), "png");
}

export type Pin = { x: number; y: number; note: string };

export const EDIT_MODES = {
  edit: "",
  erase: "Remove whatever is in the marked area and fill it in so it blends naturally with its surroundings, as if it was never there.",
  remove_bg: "Remove the background completely, leaving only the main subject on a transparent background. Keep the subject's edges clean.",
} as const;

/** The edit instruction, with any pinned notes placed by position. */
export function editPrompt(mode: keyof typeof EDIT_MODES, prompt: string, pins: Pin[]) {
  const parts = [EDIT_MODES[mode], prompt.trim()].filter(Boolean);
  pins.forEach((p, i) =>
    parts.push(`Change ${i + 1}, at ${Math.round(p.x * 100)}% from the left and ${Math.round(p.y * 100)}% from the top: ${p.note.trim()}`),
  );
  parts.push("Leave everything else exactly as it is.");
  return parts.join("\n");
}

