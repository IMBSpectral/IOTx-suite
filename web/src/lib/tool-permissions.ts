import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";

/**
 * Agent tool permissions for connectors and MCP servers, per workspace. Each
 * tool is "ask" (an approval card before it runs) or "allow" (never ask).
 * Unset tools that only read run freely; ones that change things ask. An
 * approval card can allow a call once, for an hour, or always.
 */

export type Pref = "ask" | "allow";
type Store = { prefs: Record<string, Pref>; grants: Record<string, { until: number; uses: number | null }> };

const file = (workspaceId: string) => path.join(PROJECTS_ROOT, "_forge", "tool-permissions", `${workspaceId.replace(/[^\w-]/g, "")}.json`);
async function load(workspaceId: string): Promise<Store> {
  const raw = await fs.readFile(file(workspaceId), "utf8").catch(() => null);
  return raw ? { prefs: {}, grants: {}, ...(JSON.parse(raw) as Partial<Store>) } : { prefs: {}, grants: {} };
}
async function save(workspaceId: string, s: Store) {
  await fs.mkdir(path.dirname(file(workspaceId)), { recursive: true });
  await fs.writeFile(file(workspaceId), JSON.stringify(s, null, 2));
}

const READ_NAME = /^(get|list|search|read|fetch|find|query|describe|lookup|view|show|count)[_-]?/i;

/** The permission key for a call: one per connector and kind of request, or per MCP tool. */
export function permissionKey(kind: "connector" | "mcp", connection: string, what: string) {
  return `${kind}:${connection.toLowerCase()}:${what}`;
}

export function defaultPref(kind: "connector" | "mcp", what: string): Pref {
  if (kind === "connector") return what === "read" ? "allow" : "ask";
  return READ_NAME.test(what) ? "allow" : "ask";
}

/** Whether a call may run now; a one-time grant is used up by this check. */
export async function mayRun(workspaceId: string, key: string, fallback: Pref) {
  const s = await load(workspaceId);
  if ((s.prefs[key] ?? fallback) === "allow") return true;
  const g = s.grants[key];
  if (g && g.until > Date.now()) {
    if (g.uses !== null) {
      g.uses -= 1;
      if (g.uses <= 0) delete s.grants[key];
      await save(workspaceId, s);
    }
    return true;
  }
  if (g) {
    delete s.grants[key];
    await save(workspaceId, s);
  }
  return false;
}

/** The answer from an approval card. */
export async function approve(workspaceId: string, key: string, how: "once" | "hour" | "always" | "deny") {
  const s = await load(workspaceId);
  if (how === "always") s.prefs[key] = "allow";
  else if (how === "hour") s.grants[key] = { until: Date.now() + 3_600_000, uses: null };
  else if (how === "once") s.grants[key] = { until: Date.now() + 30 * 60_000, uses: 1 };
  else delete s.grants[key];
  await save(workspaceId, s);
}

export async function setPref(workspaceId: string, key: string, pref: Pref | null) {
  const s = await load(workspaceId);
  if (pref) s.prefs[key] = pref;
  else delete s.prefs[key];
  await save(workspaceId, s);
}

export async function listPrefs(workspaceId: string) {
  const s = await load(workspaceId);
  const now = Date.now();
  return {
    prefs: Object.entries(s.prefs).map(([key, pref]) => ({ key, pref })),
    grants: Object.entries(s.grants)
      .filter(([, g]) => g.until > now)
      .map(([key, g]) => ({ key, until: new Date(g.until).toISOString(), uses: g.uses })),
  };
}
