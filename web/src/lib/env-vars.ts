import fs from "node:fs/promises";
import path from "node:path";
import { repoDir } from "./paths";

/**
 * A project's environment variables, kept in the app's .env file. The
 * scaffold's .gitignore excludes it and it is written straight to disk, never
 * staged, so values stay out of the project's history. Vite reads it for the
 * preview and for published builds; only VITE_ variables reach the browser.
 */

export class EnvError extends Error {}

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const file = (projectId: string) => path.join(repoDir(projectId), ".env");

export function cleanEnv(vars: unknown): Record<string, string> {
  if (!Array.isArray(vars)) return {};
  const out: Record<string, string> = {};
  for (const v of vars as { name?: unknown; value?: unknown }[]) {
    const name = typeof v?.name === "string" ? v.name.trim().toUpperCase() : "";
    const value = typeof v?.value === "string" ? v.value : "";
    if (!name && !value) continue;
    if (!NAME.test(name)) throw new EnvError(`"${name || "(empty)"}" isn't a valid variable name. Use letters, numbers and underscores.`);
    if (/[\r\n]/.test(value)) throw new EnvError(`${name} can't contain line breaks.`);
    if (value.length > 4096) throw new EnvError(`${name} is too long.`);
    out[name] = value;
  }
  if (Object.keys(out).length > 50) throw new EnvError("Up to 50 variables.");
  return out;
}

const quote = (v: string) => (/^[A-Za-z0-9_./:@-]*$/.test(v) ? v : JSON.stringify(v));

export async function readEnvNames(projectId: string) {
  const raw = await fs.readFile(file(projectId), "utf8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .map((l) => /^([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter((n): n is string => !!n);
}

async function readEnvMap(projectId: string) {
  const raw = await fs.readFile(file(projectId), "utf8").catch(() => "");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].startsWith('"') ? (JSON.parse(m[2]) as string) : m[2];
  }
  return out;
}

/** Set some variables and remove others, keeping the rest as they are. */
export async function updateEnv(projectId: string, set: unknown, remove: unknown) {
  const vars = await readEnvMap(projectId);
  Object.assign(vars, cleanEnv(set));
  for (const name of Array.isArray(remove) ? remove : []) if (typeof name === "string") delete vars[name];
  if (Object.keys(vars).length > 50) throw new EnvError("Up to 50 variables.");
  await writeEnv(projectId, vars);
  return Object.keys(vars);
}

/** Replace the managed variables. Values are never read back out. */
export async function writeEnv(projectId: string, vars: Record<string, string>) {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join("\n");
  await fs.writeFile(file(projectId), body ? `# Set in the platform settings. Not committed.\n${body}\n` : "");
}
