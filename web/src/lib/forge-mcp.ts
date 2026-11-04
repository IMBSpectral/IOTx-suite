import { effective, keyForMode } from "./iotx/permissions";
import { keyLabel } from "./iotx/manifests";
import { getBrand } from "./brand";
import { db } from "./db";
import { PROTOCOL_VERSION } from "./mcp";
import { projectAccess } from "./workspace";
import { visibleTo } from "./projects";
import { enqueueTurn } from "./turns";
import { assertCredits, InsufficientCredits, SpendLimitReached } from "./credits";
import { getCloud, readOnlyQuery } from "./cloud";
import { PublishBlocked, publishProject, siteUrl } from "./publish";
import { ApiKeyError, assertKeyBudget, authenticate, requireScope } from "./api-keys";
import { runCheckHooks } from "./event-destinations";

/**
 * Forge as an MCP server: Claude Desktop/Code, Cursor and other MCP clients
 * work with a workspace's projects using a workspace API key. Tool calls can
 * edit projects, deploy apps, query databases and use credits, each within
 * the key's scopes and the key owner's own access.
 */

type Key = NonNullable<Awaited<ReturnType<typeof authenticate>>>;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const TOOLS = [
  { name: "list_projects", description: "List the workspace's projects you can see, newest first.", inputSchema: obj({ query: { type: "string", description: "Filter by name" } }) },
  {
    name: "get_project",
    description: "A project's details: description, published URL, Cloud status and its latest builds.",
    inputSchema: obj({ projectId: { type: "string" } }, ["projectId"]),
  },
  {
    name: "send_message",
    description:
      "Send an instruction to a project's agent, as if typed in its chat. Build mode changes the app and uses credits; ask mode only answers. Returns a buildId to follow with get_build.",
    inputSchema: obj(
      { projectId: { type: "string" }, message: { type: "string" }, mode: { type: "string", enum: ["build", "ask", "plan"], default: "build" } },
      ["projectId", "message"],
    ),
  },
  { name: "get_build", description: "A build's status, the agent's reply and the credits it used.", inputSchema: obj({ buildId: { type: "string" } }, ["buildId"]) },
  {
    name: "query_database",
    description: "Run a read-only SQL SELECT on a project's {brand} Cloud database (SQLite, or PostgreSQL for projects that use it). At most 100 rows.",
    inputSchema: obj({ projectId: { type: "string" }, sql: { type: "string" } }, ["projectId", "sql"]),
  },
  { name: "publish_project", description: "Publish the project's current version to its live URL (runs the pre-publish checks).", inputSchema: obj({ projectId: { type: "string" } }, ["projectId"]) },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

async function project(key: Key, id: unknown, need: "view" | "edit" = "view") {
  const p = typeof id === "string" ? await db.project.findFirst({ where: { id, workspaceId: key.workspaceId, deletedAt: null } }) : null;
  const access = p ? await projectAccess(key.createdById, p) : null;
  if (!p || !access) throw new ApiKeyError("Project not found in this workspace.", 404);
  if (need === "edit" && access === "view") throw new ApiKeyError("The key's owner can only view this project.", 403);
  return p;
}

/** IOTx Suite: an API key acts with its creator's permissions (and needs "API keys and MCP"). */
async function perm(key: Key, ...keys: string[]) {
  const e = await effective(key.createdById, key.workspaceId);
  for (const k of ["builder.api_keys", ...keys]) {
    if (!e?.keys.includes(k)) throw new ApiKeyError(`The key owner's role doesn't include "${keyLabel(k).replace(/\bIOTx\b/g, getBrand().shortName)}". Ask an admin to turn it on.`, 403);
  }
}

async function callTool(key: Key, name: string, a: Record<string, unknown>) {
  await perm(key);
  switch (name) {
    case "list_projects": {
      requireScope(key, "read");
      const q = typeof a.query === "string" ? a.query.trim() : "";
      const rows = await db.project.findMany({
        where: {
          workspaceId: key.workspaceId,
          deletedAt: null,
          ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
          ...(await visibleTo(key.createdById, key.workspaceId)),
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, name: true, description: true, updatedAt: true, publishedSha: true, subdomain: true },
      });
      return json(rows.map((p) => ({ id: p.id, name: p.name, description: p.description, updatedAt: p.updatedAt, url: p.publishedSha ? siteUrl(p.subdomain) : null })));
    }
    case "get_project": {
      requireScope(key, "read");
      const p = await project(key, a.projectId);
      const builds = await db.build.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true, mode: true, creditsUsed: true, createdAt: true } });
      const cloud = await getCloud(p.id);
      return json({ id: p.id, name: p.name, description: p.description, url: p.publishedSha ? siteUrl(p.subdomain) : null, cloud: !!cloud?.enabled, builds });
    }
    case "send_message": {
      const mode = a.mode === "ask" || a.mode === "plan" ? a.mode : "build";
      requireScope(key, mode === "build" ? "build" : "read");
      await perm(key, keyForMode(mode));
      const p = await project(key, a.projectId, "edit");
      const message = typeof a.message === "string" ? a.message.trim() : "";
      if (!message) throw new ApiKeyError("Send a message.");
      if (mode === "build") await assertKeyBudget(key);
      try {
        await assertCredits(p.workspaceId, { userId: key.createdById, projectId: p.id });
      } catch (e) {
        if (e instanceof InsufficientCredits || e instanceof SpendLimitReached) throw new ApiKeyError(e.message, 402);
        throw e;
      }
      const turn = await enqueueTurn({ projectId: p.id, userId: key.createdById, content: message.slice(0, 20_000), mode, messageMode: "api" });
      await db.build.update({ where: { id: turn.buildId }, data: { apiKeyId: key.id } });
      return json({ buildId: turn.buildId, status: "QUEUED", note: "Follow it with get_build." });
    }
    case "get_build": {
      requireScope(key, "read");
      const b = typeof a.buildId === "string" ? await db.build.findUnique({ where: { id: a.buildId } }) : null;
      if (!b) throw new ApiKeyError("Build not found.", 404);
      await project(key, b.projectId);
      const reply = b.messageId ? await db.message.findUnique({ where: { id: b.messageId }, select: { content: true } }) : null;
      return json({ id: b.id, status: b.status, mode: b.mode, creditsUsed: b.creditsUsed, error: b.error, reply: reply?.content.slice(0, 8000) ?? "" });
    }
    case "query_database": {
      requireScope(key, "database");
      await perm(key, "builder.cloud.rows");
      const p = await project(key, a.projectId);
      if (!(await getCloud(p.id))?.enabled) throw new ApiKeyError(`This project has no ${getBrand().shortName} Cloud database.`);
      const sql = typeof a.sql === "string" ? a.sql.trim().replace(/;\s*$/, "") : "";
      if (!/^(select|with)\b/i.test(sql) || sql.includes(";")) throw new ApiKeyError("Only a single SELECT statement is allowed.");
      // The connection is read-only as well, so a sneaky write still fails.
      const rows = await readOnlyQuery(p.id, `SELECT * FROM (${sql}) AS q LIMIT 100`);
      return json(rows);
    }
    case "publish_project": {
      requireScope(key, "deploy");
      await perm(key, "builder.publish");
      const p = await project(key, a.projectId, "edit");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: p.workspaceId }, select: { publishRequiresApproval: true } });
      const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: key.createdById, workspaceId: p.workspaceId } }, select: { role: true } });
      if (ws.publishRequiresApproval && m?.role !== "OWNER" && m?.role !== "ADMIN") {
        throw new ApiKeyError(`Publishing in this workspace needs an admin's approval. Request it in ${getBrand().name}.`, 403);
      }
      if (await db.build.count({ where: { projectId: p.id, status: { in: ["QUEUED", "RUNNING"] } } })) {
        throw new ApiKeyError("Wait for the agent to finish before publishing.", 409);
      }
      const verdict = await runCheckHooks(p.workspaceId, "publish", { projectId: p.id, projectName: p.name, by: "api-key:" + key.name });
      if (!verdict.allow) throw new ApiKeyError(verdict.reason ?? "A workspace check stopped this publish.", 403);
      try {
        const r = await publishProject(p.id);
        return json({ url: r.url, sha: r.sha });
      } catch (e) {
        if (e instanceof PublishBlocked) return text(`Publishing was blocked by checks: ${JSON.stringify(e.result).slice(0, 2000)}`, true);
        throw e;
      }
    }
    default:
      throw new ApiKeyError(`Unknown tool ${name}`);
  }
}

const HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*" };

export async function handleForgeMcp(req: Request): Promise<Response> {
  const key = await authenticate(req.headers.get("authorization"));
  if (!key) {
    return new Response(JSON.stringify({ error: `A ${getBrand().name} API key is required (Settings → API & MCP).` }), {
      status: 401,
      headers: { ...HEADERS, "www-authenticate": 'Bearer realm="forge-mcp"' },
    });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const msg = (await req.json().catch(() => null)) as Rpc | null;
  if (!msg?.method) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: HEADERS });
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });
  const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { headers: HEADERS });

  switch (msg.method) {
    case "initialize": {
      const ws = await db.workspace.findUnique({ where: { id: key.workspaceId }, select: { name: true } });
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: `${getBrand().shortName} (${ws?.name ?? "workspace"})`, version: "1.0" },
        instructions: `Work with this ${getBrand().name} workspace's projects. send_message in build mode changes apps and uses credits; follow builds with get_build.`,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.filter((t) => toolAllowed(key, t.name)).map((t) => ({ ...t, description: t.description.replace("{brand}", getBrand().shortName) })) });
    case "tools/call":
      try {
        return reply(await callTool(key, String(msg.params?.name ?? ""), (msg.params?.arguments ?? {}) as Record<string, unknown>));
      } catch (e) {
        return reply(text(e instanceof Error ? e.message : "The tool failed.", true));
      }
    default:
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }), { headers: HEADERS });
  }
}

/** Only tools the key's scopes allow are listed. */
function toolAllowed(key: Key, tool: string) {
  const need: Record<string, string> = { list_projects: "read", get_project: "read", get_build: "read", send_message: "read", query_database: "database", publish_project: "deploy" };
  return key.scopes.includes(need[tool] ?? "read");
}
