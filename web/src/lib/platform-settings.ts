import fs from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";

/**
 * Settings for the whole Forge install that platform admins change from
 * Settings → Platform (_forge/platform.json). Read synchronously and cached
 * by modification time, so hot paths like the credit check stay cheap.
 */
export type PlatformSettings = {
  /** Start of the free build hour (ISO); builds cost nothing for the hour after it. */
  freeBuildHourStart?: string | null;
};

const FILE = path.join(PROJECTS_ROOT, "_forge", "platform.json");
let cache: { mtime: number; value: PlatformSettings } | null = null;

export function platformSettings(file = FILE): PlatformSettings {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (cache?.mtime !== mtime) cache = { mtime, value: JSON.parse(fs.readFileSync(file, "utf8")) as PlatformSettings };
    return cache.value;
  } catch {
    return {};
  }
}

export function updatePlatformSettings(patch: PlatformSettings, file = FILE) {
  const next = { ...platformSettings(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  cache = null;
  return next;
}
