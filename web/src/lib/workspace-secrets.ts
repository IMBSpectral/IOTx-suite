import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import { open as openBox, seal, type SecretBox } from "./secret-box";

/**
 * Workspace secrets: API keys every project in the workspace can use
 * (functions, the agent's http_request, app email). A project secret with the
 * same name overrides the workspace one. Values are sealed at rest and never
 * returned to the browser.
 */

// Same purpose as project secrets, so a value can move between the two stores.
const PURPOSE = "forge-cloud-secrets";
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

type Store = Record<string, SecretBox & { updatedAt: string; by?: string }>;

const file = (workspaceId: string) => path.join(PROJECTS_ROOT, "_forge", "workspace-secrets", `${workspaceId.replace(/[^\w-]/g, "")}.json`);

async function load(workspaceId: string): Promise<Store> {
  const raw = await fs.readFile(file(workspaceId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as Store) : {};
}

async function save(workspaceId: string, store: Store) {
  await fs.mkdir(path.dirname(file(workspaceId)), { recursive: true });
  await fs.writeFile(file(workspaceId), JSON.stringify(store, null, 2));
}

export class WorkspaceSecretError extends Error {}

export async function listWorkspaceSecrets(workspaceId: string) {
  const store = await load(workspaceId);
  return Object.entries(store)
    .map(([name, s]) => ({ name, updatedAt: s.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function setWorkspaceSecret(workspaceId: string, name: string, value: string, by?: string) {
  if (!NAME.test(name)) throw new WorkspaceSecretError("Use capitals, numbers and _ for the name, e.g. STRIPE_SECRET_KEY.");
  if (!value || value.length > 10_000) throw new WorkspaceSecretError("Enter a value (at most 10,000 characters).");
  const store = await load(workspaceId);
  store[name] = { ...seal(PURPOSE, value), updatedAt: new Date().toISOString(), by };
  await save(workspaceId, store);
}

export async function deleteWorkspaceSecret(workspaceId: string, name: string) {
  const store = await load(workspaceId);
  delete store[name];
  await save(workspaceId, store);
}

export async function readWorkspaceSecret(workspaceId: string, name: string): Promise<string | null> {
  const box = (await load(workspaceId))[name];
  return box ? openBox(PURPOSE, box) : null;
}

export async function workspaceSecretNames(workspaceId: string) {
  return Object.keys(await load(workspaceId));
}
