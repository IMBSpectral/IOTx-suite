import crypto from "node:crypto";
import { getBrand } from "./brand";
import { db } from "./db";
import { cloudUrl, getCloud, listTables, openDatabase, pgValue, updateCloud, type CloudConfig } from "./cloud";
import { type Param } from "./cloud-db";
import { PROTOCOL_VERSION } from "./mcp";

/**
 * Each app with Forge Cloud can expose an MCP server, so AI clients (Claude,
 * ChatGPT, Cursor…) can read and add the app's data. It always needs the
 * project's MCP token: there is no anonymous access. The token is shown once
 * when it's created and stored only as a hash.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const INTERNAL = /^(_forge_|auth_users$|sqlite_)/;
const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const mcpUrl = (projectId: string) => `${cloudUrl(projectId)}/mcp`;

export async function mcpInfo(projectId: string) {
  const cfg = await getCloud(projectId);
  return { cloud: !!cfg?.enabled, enabled: !!cfg?.mcp?.enabled, url: mcpUrl(projectId), createdAt: cfg?.mcp?.createdAt ?? null };
}

/** Turn the server on (or rotate its token): returns the new token, shown once. */
export async function issueMcpToken(projectId: string) {
  const token = `fmcp_${crypto.randomBytes(24).toString("base64url")}`;
  await updateCloud(projectId, (c) => {
    c.mcp = { enabled: true, tokenHash: hash(token), createdAt: new Date().toISOString() };
  });
  return token;
}

export async function disableMcp(projectId: string) {
  await updateCloud(projectId, (c) => {
    c.mcp = null;
  });
}

function authorized(cfg: CloudConfig, header: string | null) {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token || !cfg.mcp?.enabled) return false;
  const a = Buffer.from(hash(token));
  const b = Buffer.from(cfg.mcp.tokenHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const TOOLS = [
  { name: "list_tables", description: "List the app's tables with their columns and row counts.", inputSchema: { type: "object", properties: {} } },
  {
    name: "query_table",
    description: "Read rows from a table, optionally filtered by exact column values.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        where: { type: "object", description: "Column → value; rows must match all", additionalProperties: true },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["table"],
    },
  },
  {
    name: "insert_row",
    description: "Add one row to a table.",
    inputSchema: { type: "object", properties: { table: { type: "string" }, row: { type: "object", additionalProperties: true } }, required: ["table", "row"] },
  },
];

const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError });

function checkTable(table: unknown) {
  if (typeof table !== "string" || !IDENT.test(table) || INTERNAL.test(table)) throw new Error("Unknown table.");
  return table;
}

async function callTool(projectId: string, name: string, args: Record<string, unknown>) {
  if (name === "list_tables") {
    const tables = await listTables(projectId);
    return text(tables.map((t) => ({ name: t.name, rows: t.rows, columns: t.columns })));
  }
  if (name === "query_table") {
    const table = checkTable(args.table);
    const cols = (await listTables(projectId)).find((t) => t.name === table);
    if (!cols) throw new Error("Unknown table.");
    const where = (args.where ?? {}) as Record<string, unknown>;
    const names = (cols.columns as { name: string }[]).map((c) => c.name);
    const keys = Object.keys(where);
    for (const k of keys) if (!names.includes(k)) throw new Error(`No column "${k}" in ${table}.`);
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    const sql = `SELECT * FROM "${table}"${keys.length ? ` WHERE ${keys.map((k) => `"${k}" = ?`).join(" AND ")}` : ""} LIMIT ${limit}`;
    const rows = await openDatabase(projectId).all(sql, keys.map((k) => where[k]) as Param[]);
    return text(rows);
  }
  if (name === "insert_row") {
    const table = checkTable(args.table);
    const row = (args.row ?? {}) as Record<string, unknown>;
    const keys = Object.keys(row);
    if (!keys.length || keys.some((k) => !IDENT.test(k))) throw new Error("Give the row as column → value.");
    const db = openDatabase(projectId);
    const insert = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    if ((await db.engine()) === "postgres") {
      const cols = await db.columns(table);
      await db.run(insert, keys.map((k) => pgValue(row[k], cols.find((c) => c.name === k)?.type ?? "")));
      return text("Added 1 row.");
    }
    const r = await db.run(insert, keys.map((k) => row[k]) as Param[]);
    return text(`Added 1 row (rowid ${r.lastInsertRowid}).`);
  }
  throw new Error(`Unknown tool ${name}.`);
}

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };

/** Handle one MCP request (Streamable HTTP, JSON responses). */
export async function handleMcp(projectId: string, req: Request): Promise<Response> {
  const cfg = await getCloud(projectId);
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
  if (!cfg?.enabled || !cfg.mcp?.enabled) return new Response(JSON.stringify({ error: "This app has no MCP server." }), { status: 404, headers });
  if (!authorized(cfg, req.headers.get("authorization"))) {
    return new Response(JSON.stringify({ error: "An MCP token for this app is required." }), {
      status: 401,
      headers: { ...headers, "www-authenticate": 'Bearer realm="forge-app-mcp"' },
    });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const msg = (await req.json().catch(() => null)) as Rpc | null;
  if (!msg?.method) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers });
  // Notifications get no reply.
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });
  const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { headers });
  const fail = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } }), { headers });

  switch (msg.method) {
    case "initialize": {
      const p = await db.project.findUnique({ where: { id: projectId }, select: { name: true } });
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: `${p?.name ?? `${getBrand().shortName} app`} (${getBrand().shortName})`, version: "1.0" } });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      try {
        return reply(await callTool(projectId, name, (msg.params?.arguments ?? {}) as Record<string, unknown>));
      } catch (e) {
        return reply(text(e instanceof Error ? e.message : "The tool failed.", true));
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

