import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import { siteOrigin } from "./site-host";

/**
 * Short-lived links for looking at a past version of an app. Each version is
 * served on its own host (version--<token>.localhost) so the app's router
 * sees "/" as it does when published. Tokens are random, last an hour, and
 * are only handed to people who can view the project.
 */

type View = { projectId: string; sha: string; exp: number };
const file = path.join(PROJECTS_ROOT, "_forge", "version-views.json");
const TTL_MS = 60 * 60_000;

async function readAll(): Promise<Record<string, View>> {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as Record<string, View>) : {};
}

export async function createVersionView(projectId: string, sha: string) {
  const all = await readAll();
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) if (v.exp < now) delete all[k];
  // 16 base-36 characters: fits in a hostname label and can't be guessed.
  const token = Array.from(crypto.randomBytes(16), (b) => (b % 36).toString(36)).join("");
  all[token] = { projectId, sha, exp: now + TTL_MS };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(all));
  return token;
}

export async function resolveVersionView(token: string) {
  if (!/^[a-z0-9]{16}$/.test(token)) return null;
  const v = (await readAll())[token];
  return v && v.exp > Date.now() ? v : null;
}

export function versionUrl(token: string) {
  return `${siteOrigin(`version--${token}`)}/`;
}
