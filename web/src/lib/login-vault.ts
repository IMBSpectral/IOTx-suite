import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import { open, seal, type SecretBox } from "./secret-box";

/**
 * Saved logins for the agent's cloud browser, per person. A login is entered
 * once on Forge's own page; the password is sealed at rest and only ever
 * typed into the site's login form by the server, so the AI never sees it.
 */

type Entry = { id: string; site: string; username: string; password: SecretBox; createdAt: string };
const PURPOSE = "forge-login-vault";
const file = (userId: string) => path.join(PROJECTS_ROOT, "_forge", "vault", `${userId.replace(/[^\w-]/g, "")}.json`);

export class VaultError extends Error {}

async function load(userId: string): Promise<Entry[]> {
  const raw = await fs.readFile(file(userId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as Entry[]) : [];
}
async function save(userId: string, entries: Entry[]) {
  await fs.mkdir(path.dirname(file(userId)), { recursive: true });
  await fs.writeFile(file(userId), JSON.stringify(entries, null, 2));
}

export function siteOf(raw: string) {
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    throw new VaultError("Enter the site's address, e.g. app.example.com.");
  }
}

/** Saved logins without their passwords. */
export async function listLogins(userId: string) {
  return (await load(userId)).map((e) => ({ id: e.id, site: e.site, username: e.username, createdAt: e.createdAt }));
}

export async function saveLogin(userId: string, input: { site?: string; username?: string; password?: string }) {
  const site = siteOf(input.site ?? "");
  const username = (input.username ?? "").trim().slice(0, 200);
  const password = input.password ?? "";
  if (!username || !password) throw new VaultError("Enter the username and password.");
  if (password.length > 500) throw new VaultError("That password is too long.");
  const entries = (await load(userId)).filter((e) => e.site !== site);
  entries.push({ id: crypto.randomUUID(), site, username, password: seal(PURPOSE, password), createdAt: new Date().toISOString() });
  await save(userId, entries);
}

export async function deleteLogin(userId: string, id: string) {
  await save(userId, (await load(userId)).filter((e) => e.id !== id));
}

/** Server-side only: the saved login for a site (or its parent domain). */
export async function loginFor(userId: string, host: string) {
  const h = host.toLowerCase().replace(/^www\./, "");
  const e = (await load(userId)).find((x) => h === x.site || h.endsWith(`.${x.site}`));
  return e ? { username: e.username, password: open(PURPOSE, e.password) } : null;
}
