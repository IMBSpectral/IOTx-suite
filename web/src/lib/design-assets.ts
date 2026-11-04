import fs from "node:fs/promises";
import path from "node:path";
import { commit, deleteFile, listFiles, writeBinaryFile } from "./repo";
import { repoDir } from "./paths";
import { db } from "./db";

/**
 * A design system's asset bundle: logos, icons, illustrations and fonts kept
 * with the tokens (assets/ in the design system). Attaching the design system
 * copies them into the app's public/brand/, and the agent is told they exist.
 */
export const ASSET_TYPES = /\.(svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i;
export const MAX_ASSET_BYTES = 5_000_000;
export const MAX_ASSETS = 40;

export class AssetError extends Error {}

const clean = (name: string) => path.basename(name).replace(/[^\w.-]+/g, "-").replace(/^-+/, "").slice(-80);

export async function listAssets(dsId: string) {
  const files = (await listFiles(dsId)).filter((f) => f.startsWith("assets/"));
  return Promise.all(
    files.map(async (f) => {
      const s = await fs.stat(path.join(repoDir(dsId), f)).catch(() => null);
      return { name: f.slice("assets/".length), size: s?.size ?? 0 };
    }),
  );
}

export async function addAsset(dsId: string, name: string, bytes: Buffer) {
  const file = clean(name);
  if (!ASSET_TYPES.test(file)) throw new AssetError("Assets can be images (SVG, PNG, JPEG, WebP, GIF, ICO) or fonts (WOFF, WOFF2, TTF, OTF).");
  if (bytes.length > MAX_ASSET_BYTES) throw new AssetError("Assets can be up to 5 MB.");
  if ((await listAssets(dsId)).length >= MAX_ASSETS) throw new AssetError(`A design system can hold ${MAX_ASSETS} assets.`);
  await writeBinaryFile(dsId, `assets/${file}`, bytes);
  const sha = await commit(dsId, `Add asset ${file}`);
  await db.project.update({ where: { id: dsId }, data: { headSha: sha } });
  return file;
}

export async function removeAsset(dsId: string, name: string) {
  const file = clean(name);
  await deleteFile(dsId, `assets/${file}`);
  const sha = await commit(dsId, `Remove asset ${file}`);
  await db.project.update({ where: { id: dsId }, data: { headSha: sha } });
}

/** Copy the bundle into an app (public/brand/); returns the files written. */
export async function copyAssetsTo(dsId: string, appId: string) {
  const assets = await listAssets(dsId);
  const out: string[] = [];
  for (const a of assets) {
    const bytes = await fs.readFile(path.join(repoDir(dsId), "assets", a.name));
    out.push(await writeBinaryFile(appId, `public/brand/${a.name}`, bytes));
  }
  return out;
}
