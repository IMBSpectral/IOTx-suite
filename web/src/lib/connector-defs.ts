import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import type { ConnectorDef } from "./connectors";

/**
 * Custom connectors, defined per workspace (the workspace's connector
 * registry): "Connect your own API" (an HTTPS base URL, how the token goes in
 * the request, and an optional check path) and "Connect your own MCP" (a
 * named MCP server URL). They are connected and used like built-in ones.
 */

export type CustomDef =
  | { kind: string; type: "api"; name: string; description: string; baseUrl: string; headerName: string; headerValue: string; check: string | null; tokenLabel: string; createdAt: string }
  | { kind: string; type: "mcp"; name: string; description: string; url: string; createdAt: string };

export class DefError extends Error {}

const file = (workspaceId: string) => path.join(PROJECTS_ROOT, "_forge", "connector-defs", `${workspaceId.replace(/[^\w-]/g, "")}.json`);
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;

export async function listCustomDefs(workspaceId: string): Promise<CustomDef[]> {
  const raw = await fs.readFile(file(workspaceId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as CustomDef[]) : [];
}

async function save(workspaceId: string, defs: CustomDef[]) {
  await fs.mkdir(path.dirname(file(workspaceId)), { recursive: true });
  await fs.writeFile(file(workspaceId), JSON.stringify(defs, null, 2));
}

function httpsUrl(raw: string, what: string) {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new DefError(`Enter the ${what} as a full address starting with https://.`);
  }
  if (u.protocol !== "https:") throw new DefError(`The ${what} must use https://.`);
  return u;
}

/** Create or update a custom definition (kind is derived from the name the first time). */
export async function saveCustomDef(workspaceId: string, input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim().slice(0, 40);
  if (!name) throw new DefError("Name the connector.");
  const type = input.type === "mcp" ? "mcp" : "api";
  const defs = await listCustomDefs(workspaceId);
  const kind = typeof input.kind === "string" && defs.some((d) => d.kind === input.kind) ? input.kind : `${type === "mcp" ? "mcp" : "api"}-${slug(name) || "custom"}`;
  if (!input.kind && defs.some((d) => d.kind === kind)) throw new DefError("There's already a custom connector with that name.");
  if (!input.kind && defs.length >= 30) throw new DefError("Up to 30 custom connectors.");
  const description = String(input.description ?? "").trim().slice(0, 200);
  let def: CustomDef;
  if (type === "mcp") {
    def = { kind, type, name, description: description || "Your own MCP server.", url: httpsUrl(String(input.url ?? ""), "server URL").toString(), createdAt: new Date().toISOString() };
  } else {
    const base = httpsUrl(String(input.baseUrl ?? ""), "API base URL");
    const headerName = String(input.headerName ?? "Authorization").trim();
    if (!HEADER.test(headerName)) throw new DefError("The header name can use letters, numbers and dashes.");
    const headerValue = String(input.headerValue ?? "Bearer {{token}}").trim();
    if (!headerValue.includes("{{token}}")) throw new DefError("The header value must include {{token}} where the key goes.");
    const check = String(input.check ?? "").trim();
    if (check && !check.startsWith("/")) throw new DefError("The check path starts with /, e.g. /v1/me.");
    def = {
      kind,
      type,
      name,
      description: description || `Your own API at ${base.host}.`,
      baseUrl: base.origin + base.pathname.replace(/\/$/, ""),
      headerName,
      headerValue,
      check: check || null,
      tokenLabel: String(input.tokenLabel ?? "").trim().slice(0, 40) || "API key",
      createdAt: new Date().toISOString(),
    };
  }
  await save(workspaceId, [...defs.filter((d) => d.kind !== kind), def]);
  return def;
}

export async function deleteCustomDef(workspaceId: string, kind: string) {
  const defs = await listCustomDefs(workspaceId);
  if (!defs.some((d) => d.kind === kind)) throw new DefError("Custom connector not found.");
  await save(workspaceId, defs.filter((d) => d.kind !== kind));
}

/** A custom definition in the same shape as the built-in catalog. */
export function toConnectorDef(d: CustomDef): ConnectorDef & { custom: true; mcpUrl?: string } {
  if (d.type === "mcp") {
    return {
      kind: d.kind,
      name: d.name,
      description: d.description,
      type: "standard",
      fields: [{ key: "token", label: "Access token (optional)", secret: true, placeholder: "Bearer token", optional: true }],
      custom: true,
      mcpUrl: d.url,
    };
  }
  return {
    kind: d.kind,
    name: d.name,
    description: d.description,
    type: "standard",
    baseUrl: d.baseUrl.endsWith("/") ? d.baseUrl : `${d.baseUrl}/`,
    check: d.check ? d.check.replace(/^\//, "") : undefined,
    fields: [{ key: "token", label: d.tokenLabel, secret: true }],
    headers: { [d.headerName.toLowerCase()]: d.headerValue },
    custom: true,
  };
}
