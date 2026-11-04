import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { cloudDir } from "./cloud";
import { exportDatabase, exportFormat } from "./cloud-admin";
import { sendPlatformEmail } from "./platform-email";
import { getBrand } from "./brand";

/**
 * "Email me a download link" for an app's database export: the export is
 * saved, and a signed link valid for 24 hours is emailed to the person who
 * asked. The link names one file and is checked against AUTH_SECRET, so it
 * can't be guessed or pointed at another project.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const dirFor = (projectId: string) => path.join(cloudDir(projectId), "exports");
const sign = (projectId: string, file: string, exp: number) =>
  crypto.createHmac("sha256", process.env.AUTH_SECRET ?? "dev").update(`${projectId}:${file}:${exp}`).digest("base64url");

async function sweep(projectId: string) {
  const dir = dirFor(projectId);
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    const st = await fs.stat(path.join(dir, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > TTL_MS) await fs.rm(path.join(dir, f), { force: true });
  }
}

/** Save an export of `dataId` (the project, or its draft or live copy) and email a link to `to`. */
export async function emailExportLink(projectId: string, dataId: string, slug: string, to: string) {
  await sweep(projectId);
  const bytes = await exportDatabase(dataId);
  // SQLite projects export a SQLite file; PostgreSQL projects a plain SQL dump.
  const format = await exportFormat(dataId);
  const file = `${slug.replace(/[^\w-]/g, "")}-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(6).toString("hex")}.${format.extension}`;
  await fs.mkdir(dirFor(projectId), { recursive: true });
  await fs.writeFile(path.join(dirFor(projectId), file), bytes);
  const exp = Date.now() + TTL_MS;
  const origin = (process.env.EDITOR_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
  const url = `${origin}/api/cloud-export/${projectId}/${file}?exp=${exp}&sig=${sign(projectId, file, exp)}`;
  const b = getBrand();
  const status = await sendPlatformEmail({
    to,
    subject: `Your database export from ${b.name}`,
    text: [
      `Your export of "${slug}" is ready (${Math.max(1, Math.round(bytes.length / 1024))} KB, ${format.extension === "sql" ? "PostgreSQL SQL dump" : "SQLite format"}).`,
      ``,
      `Download it within 24 hours:`,
      url,
      ``,
      `Anyone with this link can download the file until it expires, so don't forward it.`,
      ``,
      b.company,
    ].join("\n"),
  });
  return { status, expiresAt: new Date(exp).toISOString() };
}

/** The file behind a signed link, or null when the link is wrong or expired. */
export async function readExportLink(projectId: string, file: string, exp: number, sig: string) {
  if (!/^[\w-]+\.(sqlite|sql)$/.test(file) || !Number.isFinite(exp) || exp < Date.now()) return null;
  const want = Buffer.from(sign(projectId, file, exp));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return fs.readFile(path.join(dirFor(projectId), file)).catch(() => null);
}
