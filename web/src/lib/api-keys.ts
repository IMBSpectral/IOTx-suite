import crypto from "node:crypto";
import { db } from "./db";

/**
 * Workspace API keys for the Forge MCP server. A key belongs to a workspace
 * and acts as the person who made it, limited by its scopes:
 *   read      list projects, read project and build status
 *   build     send messages that make the agent build (uses credits)
 *   database  read-only SQL on a project's Forge Cloud database
 *   deploy    publish projects
 * A key can carry a monthly credit limit on the builds it starts.
 */

export const SCOPES = ["read", "build", "database", "deploy"] as const;
export type Scope = (typeof SCOPES)[number];

export class ApiKeyError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const monthStart = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

export async function createApiKey(workspaceId: string, userId: string, input: { name?: string; scopes?: string[]; monthlyLimit?: number | null }) {
  const name = (input.name ?? "").trim().slice(0, 60);
  if (!name) throw new ApiKeyError("Name the key, e.g. “Claude Desktop”.");
  const scopes = [...new Set((input.scopes ?? []).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)))];
  if (!scopes.length) throw new ApiKeyError("Pick at least one scope.");
  const limit = input.monthlyLimit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000)) throw new ApiKeyError("The limit is a whole number of credits.");
  if ((await db.apiKey.count({ where: { workspaceId, revokedAt: null } })) >= 25) throw new ApiKeyError("A workspace can have 25 active keys.");
  const token = `forge_${crypto.randomBytes(24).toString("base64url")}`;
  const key = await db.apiKey.create({
    data: { workspaceId, name, prefix: token.slice(0, 12), hash: hash(token), scopes, monthlyLimit: limit, createdById: userId },
  });
  return { id: key.id, token };
}

export async function listApiKeys(workspaceId: string) {
  const keys = await db.apiKey.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  return Promise.all(
    keys.map(async (k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      monthlyLimit: k.monthlyLimit,
      usedThisMonth: await keyCreditsThisMonth(k.id),
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revoked: !!k.revokedAt,
    })),
  );
}

export async function revokeApiKey(workspaceId: string, id: string) {
  const { count } = await db.apiKey.updateMany({ where: { id, workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!count) throw new ApiKeyError("Key not found", 404);
}

export async function setKeyLimit(workspaceId: string, id: string, monthlyLimit: number | null) {
  if (monthlyLimit !== null && (!Number.isInteger(monthlyLimit) || monthlyLimit < 1)) throw new ApiKeyError("The limit is a whole number of credits.");
  const { count } = await db.apiKey.updateMany({ where: { id, workspaceId }, data: { monthlyLimit } });
  if (!count) throw new ApiKeyError("Key not found", 404);
}

/** Credits used this month by builds the key started. */
export async function keyCreditsThisMonth(apiKeyId: string) {
  const r = await db.build.aggregate({ where: { apiKeyId, createdAt: { gte: monthStart() } }, _sum: { creditsUsed: true } });
  return r._sum.creditsUsed ?? 0;
}

/** The key behind an Authorization header, or null. Updates its last use. */
export async function authenticate(header: string | null) {
  const token = header?.match(/^Bearer\s+(forge_[\w-]+)$/i)?.[1];
  if (!token) return null;
  const key = await db.apiKey.findUnique({ where: { hash: hash(token) } });
  if (!key || key.revokedAt) return null;
  // Last use is kept to the minute, so busy keys don't write on every call.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return key;
}

export function requireScope(key: { scopes: string[] }, scope: Scope) {
  if (!key.scopes.includes(scope)) throw new ApiKeyError(`This key doesn't have the "${scope}" scope.`, 403);
}

export async function assertKeyBudget(key: { id: string; monthlyLimit: number | null }) {
  if (key.monthlyLimit && (await keyCreditsThisMonth(key.id)) >= key.monthlyLimit) {
    throw new ApiKeyError(`This key reached its monthly limit of ${key.monthlyLimit} credits.`, 402);
  }
}
