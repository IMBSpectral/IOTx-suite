import crypto from "node:crypto";

/** AES-256-GCM for credentials at rest (Cloud secrets, connector tokens). */
export type SecretBox = { iv: string; data: string; tag: string };

function key(purpose: string) {
  const s = process.env.AUTH_SECRET ?? process.env.PREVIEW_TOKEN_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return crypto.createHash("sha256").update(`${purpose}:${s}`).digest();
}

export function seal(purpose: string, value: string): SecretBox {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(purpose), iv);
  const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), data: data.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

export function open(purpose: string, box: SecretBox) {
  const d = crypto.createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(box.iv, "base64"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8");
}
