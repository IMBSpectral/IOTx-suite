import type { Prisma } from "@prisma/client";
import { getBrand } from "./brand";
import { logConnectorRequest } from "./connector-log";
import { listCustomDefs, toConnectorDef } from "./connector-defs";
import { db } from "./db";
import { publicFetch } from "./net";
import { openMcp } from "./mcp";
import { open, seal, type SecretBox } from "./secret-box";

/**
 * Connectors: credentials for the tools people already use (Notion, Slack,
 * Stripe…), connected once and reused by the agent across projects.
 *
 * "Standard" connectors take an API token and work through connector_request:
 * Forge adds the credential server-side, only ever sends it to that
 * connector's own API host, and redacts it from anything returned. "Seamless"
 * ones sign in with OAuth and need a deployed OAuth app, so they're listed but
 * not connectable locally.
 */

type Field = { key: string; label: string; secret: boolean; placeholder?: string; optional?: boolean };
export type ConnectorDef = {
  kind: string;
  name: string;
  description: string;
  type: "standard" | "seamless";
  baseUrl?: string;
  fields?: Field[];
  /** Headers for every request, with {{field}} placeholders. */
  headers?: Record<string, string>;
  /** A cheap authenticated GET that proves the credential works. */
  check?: string;
  docs?: string;
};

export const CATALOG: ConnectorDef[] = [
  {
    kind: "notion", name: "Notion", type: "standard",
    description: "Read and write pages and databases in your Notion workspace.",
    baseUrl: "https://api.notion.com", check: "/v1/users/me",
    fields: [{ key: "token", label: "Internal integration secret", secret: true, placeholder: "ntn_…" }],
    headers: { authorization: "Bearer {{token}}", "notion-version": "2022-06-28" },
    docs: "https://www.notion.so/my-integrations",
  },
  {
    kind: "slack", name: "Slack", type: "standard",
    description: "Post messages and read channels with a Slack bot.",
    baseUrl: "https://slack.com", check: "/api/auth.test",
    fields: [{ key: "token", label: "Bot token", secret: true, placeholder: "xoxb-…" }],
    headers: { authorization: "Bearer {{token}}" },
    docs: "https://api.slack.com/apps",
  },
  {
    kind: "stripe", name: "Stripe", type: "standard",
    description: "Look up products, prices, customers and payments.",
    baseUrl: "https://api.stripe.com", check: "/v1/balance",
    fields: [{ key: "token", label: "Secret or restricted key", secret: true, placeholder: "sk_test_… or rk_…" }],
    headers: { authorization: "Bearer {{token}}" },
    docs: "https://dashboard.stripe.com/apikeys",
  },
  {
    kind: "github", name: "GitHub", type: "standard",
    description: "Read repositories, issues and pull requests.",
    baseUrl: "https://api.github.com", check: "/user",
    fields: [{ key: "token", label: "Personal access token", secret: true, placeholder: "github_pat_… or ghp_…" }],
    headers: { authorization: "Bearer {{token}}", accept: "application/vnd.github+json", "user-agent": "Forge" },
    docs: "https://github.com/settings/tokens",
  },
  {
    kind: "openai", name: "OpenAI", type: "standard",
    description: "Use OpenAI models from your app's backend.",
    baseUrl: "https://api.openai.com", check: "/v1/models",
    fields: [{ key: "token", label: "API key", secret: true, placeholder: "sk-…" }],
    headers: { authorization: "Bearer {{token}}" },
    docs: "https://platform.openai.com/api-keys",
  },
  {
    kind: "resend", name: "Resend", type: "standard",
    description: "Send transactional email.",
    baseUrl: "https://api.resend.com", check: "/domains",
    fields: [{ key: "token", label: "API key", secret: true, placeholder: "re_…" }],
    headers: { authorization: "Bearer {{token}}" },
    docs: "https://resend.com/api-keys",
  },
  {
    kind: "airtable", name: "Airtable", type: "standard",
    description: "Read and write records in your bases.",
    baseUrl: "https://api.airtable.com", check: "/v0/meta/whoami",
    fields: [{ key: "token", label: "Personal access token", secret: true, placeholder: "pat…" }],
    headers: { authorization: "Bearer {{token}}" },
    docs: "https://airtable.com/create/tokens",
  },
  {
    kind: "mcp", name: "MCP server", type: "standard",
    description: "Connect any remote MCP server (Streamable HTTP); the agent can list and use its tools.",
    fields: [
      { key: "url", label: "Server URL", secret: false, placeholder: "https://mcp.example.com/mcp" },
      { key: "token", label: "Access token (optional)", secret: true, placeholder: "Bearer token", optional: true },
    ],
    docs: "https://modelcontextprotocol.io",
  },
  { kind: "gmail", name: "Gmail", type: "seamless", description: "Read and send email as you." },
  { kind: "google-calendar", name: "Google Calendar", type: "seamless", description: "Check availability and create events with a Meet link." },
  { kind: "google-sheets", name: "Google Sheets", type: "seamless", description: "Read and update spreadsheets." },
];

export const defOf = (kind: string) => CATALOG.find((c) => c.kind === kind);

/** A built-in definition, or one of the workspace's custom connectors. */
export async function defFor(workspaceId: string, kind: string): Promise<(ConnectorDef & { mcpUrl?: string }) | undefined> {
  const builtIn = defOf(kind);
  if (builtIn) return builtIn;
  const custom = (await listCustomDefs(workspaceId)).find((d) => d.kind === kind);
  return custom ? toConnectorDef(custom) : undefined;
}

export { detectPastedCredential } from "./connector-patterns";

const PURPOSE = "forge-connectors";
type Stored = {
  scope: "workspace" | "project";
  projectId: string | null;
  fields: Record<string, SecretBox | string>;
  account: string | null;
  checkedAt: string | null;
  status: "ok" | "failed";
  error: string | null;
};

export class ConnectorError extends Error {}

function render(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? "");
}

/** A short account label from the check response, so people can tell connections apart. */
function accountFrom(kind: string, body: unknown): string | null {
  const b = body as Record<string, unknown> | null;
  if (!b) return null;
  if (kind === "notion") return String((b.bot as { workspace_name?: string } | undefined)?.workspace_name ?? b.name ?? "") || null;
  if (kind === "slack") return [b.team, b.user].filter(Boolean).join(" / ") || null;
  if (kind === "github") return (b.login as string) ?? null;
  if (kind === "airtable") return (b.email as string) ?? (b.id as string) ?? null;
  return null;
}

/** Run the connector's check request with these credentials. */
async function check(def: ConnectorDef & { mcpUrl?: string }, values: Record<string, string>) {
  if (def.kind === "mcp" || def.mcpUrl) return checkMcp(def.mcpUrl ? { ...values, url: def.mcpUrl } : values);
  if (!def.baseUrl || !def.check) return { ok: true, account: null, error: null };
  try {
    const headers = Object.fromEntries(Object.entries(def.headers ?? {}).map(([k, v]) => [k, render(v, values)]));
    const res = await publicFetch(new URL(def.check, def.baseUrl), { headers, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    // Slack answers 200 with ok:false for a bad token.
    if (!res.ok || (def.kind === "slack" && body && (body as { ok?: boolean }).ok === false)) {
      return { ok: false, account: null, error: `${def.name} rejected the credential (HTTP ${res.status}).` };
    }
    return { ok: true, account: accountFrom(def.kind, body), error: null };
  } catch (e) {
    const cause = e instanceof Error ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
    const why = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, account: null, error: `Couldn't reach ${def.name}: ${why}` };
  }
}

export async function connect(opts: {
  workspaceId: string;
  kind: string;
  label?: string;
  values: Record<string, string>;
  scope: "workspace" | "project";
  projectId?: string | null;
}) {
  const def = await defFor(opts.workspaceId, opts.kind);
  if (!def) throw new ConnectorError("Unknown connector");
  if (def.type === "seamless") {
    throw new ConnectorError(`${def.name} signs in with OAuth, which needs ${getBrand().name} deployed with an OAuth app. Use a standard connector for now.`);
  }
  for (const f of def.fields ?? []) {
    if (!f.optional && !opts.values[f.key]?.trim()) throw new ConnectorError(`${f.label} is required.`);
  }
  const values = Object.fromEntries((def.fields ?? []).map((f) => [f.key, (opts.values[f.key] ?? "").trim()]));
  const result = await check(def, values);
  if (!result.ok) throw new ConnectorError(result.error ?? "The credential didn't work.");
  const stored: Stored = {
    scope: opts.scope,
    projectId: opts.scope === "project" ? (opts.projectId ?? null) : null,
    fields: Object.fromEntries((def.fields ?? []).map((f) => [f.key, f.secret && values[f.key] ? seal(PURPOSE, values[f.key]) : values[f.key]])),
    account: result.account,
    checkedAt: new Date().toISOString(),
    status: "ok",
    error: null,
  };
  const label = (opts.label?.trim() || result.account || def.name).slice(0, 60);
  return db.connector.upsert({
    where: { workspaceId_kind_label: { workspaceId: opts.workspaceId, kind: def.kind, label } },
    create: { workspaceId: opts.workspaceId, kind: def.kind, label, config: stored as unknown as Prisma.InputJsonValue },
    update: { config: stored as unknown as Prisma.InputJsonValue },
  });
}

/** Connections as the UI and agent see them: never the credential itself. */
export async function listConnections(workspaceId: string, projectId?: string) {
  const rows = await db.connector.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  const custom = await listCustomDefs(workspaceId);
  const defOf = (kind: string) => CATALOG.find((c) => c.kind === kind) ?? custom.find((c) => c.kind === kind);
  return rows
    .map((r) => {
      const c = r.config as unknown as Stored;
      return {
        id: r.id,
        kind: r.kind,
        name: defOf(r.kind)?.name ?? r.kind,
        label: r.label,
        scope: c.scope,
        projectId: c.projectId,
        account: c.account,
        status: c.status,
        error: c.error,
        checkedAt: c.checkedAt,
      };
    })
    .filter((c) => !projectId || c.scope === "workspace" || c.projectId === projectId);
}

async function load(workspaceId: string, id: string) {
  const row = await db.connector.findFirst({ where: { id, workspaceId } });
  if (!row) throw new ConnectorError("Connection not found");
  const def = await defFor(workspaceId, row.kind);
  if (!def) throw new ConnectorError("Unknown connector");
  const c = row.config as unknown as Stored;
  const values: Record<string, string> = Object.fromEntries(
    Object.entries(c.fields).map(([k, v]) => [k, typeof v === "string" ? v : open(PURPOSE, v)]),
  );
  // A registered MCP server's address comes from its definition.
  if (def.mcpUrl) values.url = def.mcpUrl;
  return { row, def, c, values };
}

/** Re-run the connector check ("Connector checks"). */
export async function recheck(workspaceId: string, id: string) {
  const { row, def, c, values } = await load(workspaceId, id);
  const r = await check(def, values);
  const next: Stored = { ...c, status: r.ok ? "ok" : "failed", error: r.error, checkedAt: new Date().toISOString(), account: r.account ?? c.account };
  await db.connector.update({ where: { id: row.id }, data: { config: next as unknown as Prisma.InputJsonValue } });
  return { ok: r.ok, error: r.error };
}

export async function disconnect(workspaceId: string, id: string) {
  const r = await db.connector.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw new ConnectorError("Connection not found");
}

/**
 * A request on the agent's behalf. The path is resolved against the
 * connector's own API, so a connection can't be pointed at another host.
 */
export async function connectorRequest(opts: {
  workspaceId: string;
  projectId: string;
  connection: string;
  method: string;
  path: string;
  body?: string;
}) {
  const connections = await listConnections(opts.workspaceId, opts.projectId);
  const match = connections.find((c) => c.id === opts.connection || c.label.toLowerCase() === opts.connection.toLowerCase() || c.kind === opts.connection.toLowerCase());
  if (!match) throw new ConnectorError(`No connection "${opts.connection}" is available to this project.`);
  const { def, values } = await load(opts.workspaceId, match.id);
  if (!def.baseUrl) throw new ConnectorError(`${def.name} can't be called directly.`);
  const base = new URL(def.baseUrl.endsWith("/") ? def.baseUrl : `${def.baseUrl}/`);
  // Paths are relative to the connector's base URL, which may itself have a path.
  const url = new URL(opts.path.replace(/^\/+/, ""), base);
  if (url.host !== base.host || url.protocol !== "https:") throw new ConnectorError(`Requests through ${def.name} must go to ${base.host}.`);
  const headers: Record<string, string> = Object.fromEntries(Object.entries(def.headers ?? {}).map(([k, v]) => [k, render(v, values)]));
  if (opts.body) headers["content-type"] ??= def.kind === "stripe" ? "application/x-www-form-urlencoded" : "application/json";
  const started = Date.now();
  const res = await publicFetch(url, { method: opts.method, headers, body: opts.body, signal: AbortSignal.timeout(20_000) }).catch(async (e) => {
    await logConnectorRequest(opts.workspaceId, { projectId: opts.projectId, connection: match.label, kind: def.kind, request: `${opts.method} ${url.pathname}`, status: null, ms: Date.now() - started });
    throw e;
  });
  await countRequest(opts.workspaceId, opts.projectId, def.kind);
  await logConnectorRequest(opts.workspaceId, { projectId: opts.projectId, connection: match.label, kind: def.kind, request: `${opts.method} ${url.pathname}`, status: res.status, ms: Date.now() - started });
  let text = (await res.text()).slice(0, 15_000);
  for (const v of Object.values(values)) if (v.length >= 8) text = text.split(v).join("[credential]");
  return { status: res.status, text, name: def.name };
}

// ── Usage: connector requests are metered as requests (no credits) ──

/** Record one connector request, so usage shows how much each project calls out. */
export async function countRequest(workspaceId: string, projectId: string | null, kind: string) {
  await db.creditEntry
    .create({ data: { workspaceId, projectId: projectId ?? undefined, delta: 0, reason: "GENERATION", category: `connector:${kind}` } })
    .catch(() => undefined);
}

// ── MCP servers ─────────────────────────────────────────────────

function mcpTarget(values: Record<string, string>) {
  let url: URL;
  try {
    url = new URL(values.url);
  } catch {
    throw new ConnectorError("Enter the server's full URL, starting with https://.");
  }
  if (url.protocol !== "https:") throw new ConnectorError("MCP servers must use https://.");
  return { url: url.toString(), token: values.token || undefined };
}

async function checkMcp(values: Record<string, string>) {
  try {
    const t = mcpTarget(values);
    const session = await openMcp(t.url, t.token);
    const tools = await session.listTools();
    return { ok: true, account: `${session.serverName || new URL(t.url).host} · ${tools.length} tool${tools.length === 1 ? "" : "s"}`, error: null };
  } catch (e) {
    return { ok: false, account: null, error: e instanceof Error ? e.message : "Couldn't reach the MCP server." };
  }
}

async function mcpConnection(workspaceId: string, projectId: string, connection: string) {
  const all = (await listConnections(workspaceId, projectId)).filter((c) => c.kind === "mcp" || c.kind.startsWith("mcp-"));
  const match = all.find((c) => c.id === connection || c.label.toLowerCase() === connection.toLowerCase()) ?? (all.length === 1 && connection === "mcp" ? all[0] : null);
  if (!match) throw new ConnectorError(`No MCP server "${connection}" is connected to this project.`);
  const { values } = await load(workspaceId, match.id);
  return { match, ...mcpTarget(values) };
}

/** The tools an MCP connection offers, for the agent. */
export async function mcpTools(workspaceId: string, projectId: string, connection: string) {
  const c = await mcpConnection(workspaceId, projectId, connection);
  const session = await openMcp(c.url, c.token);
  return { label: c.match.label, tools: await session.listTools() };
}

/** Call one tool on an MCP connection; the credential stays on the server. */
export async function mcpCall(workspaceId: string, projectId: string, connection: string, tool: string, args: Record<string, unknown>) {
  const c = await mcpConnection(workspaceId, projectId, connection);
  const started = Date.now();
  const session = await openMcp(c.url, c.token);
  const r = await session.callTool(tool, args);
  await countRequest(workspaceId, projectId, "mcp");
  await logConnectorRequest(workspaceId, { projectId, connection: c.match.label, kind: "mcp", request: `tool ${tool}`, status: r.isError ? 500 : 200, ms: Date.now() - started });
  let text = r.text.slice(0, 15_000);
  if (c.token && c.token.length >= 8) text = text.split(c.token).join("[credential]");
  return { ...r, text, label: c.match.label };
}

/** The workspace's GitHub connector token, for importing private repositories (null when none is connected). */
export async function githubToken(workspaceId: string): Promise<string | null> {
  const row = await db.connector.findFirst({ where: { workspaceId, kind: "github" }, orderBy: { createdAt: "desc" } });
  if (!row) return null;
  const { values } = await load(workspaceId, row.id).catch(() => ({ values: {} as Record<string, string> }));
  return values.token || null;
}
