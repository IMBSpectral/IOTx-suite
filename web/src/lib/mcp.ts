import { publicFetch } from "./net";

/**
 * A small client for remote MCP servers (Streamable HTTP transport):
 * JSON-RPC 2.0 over POST, answered either as JSON or as a server-sent event
 * stream. Each operation opens a session (initialize), then lists or calls
 * tools. Only public hosts are reachable (publicFetch).
 */
export const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {}

export type McpTool = { name: string; description?: string; inputSchema?: unknown };

type Rpc = { jsonrpc: "2.0"; id?: number; result?: unknown; error?: { code: number; message: string } };

/** Read the JSON-RPC reply with this id from a JSON body or an SSE stream. */
async function readReply(res: Response, id: number): Promise<Rpc | null> {
  const type = res.headers.get("content-type") ?? "";
  const text = (await res.text()).slice(0, 2_000_000);
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as Rpc;
        if (msg.id === id) return msg;
      } catch {
        // keep-alive or non-JSON event
      }
    }
    return null;
  }
  if (!text.trim()) return null;
  try {
    const msg = JSON.parse(text) as Rpc | Rpc[];
    return Array.isArray(msg) ? (msg.find((m) => m.id === id) ?? null) : msg;
  } catch {
    throw new McpError(`The MCP server answered with something that isn't JSON (HTTP ${res.status}).`);
  }
}

export class McpSession {
  private nextId = 1;
  private sessionId: string | null = null;
  serverName = "";

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  async request<T>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    const res = await publicFetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new McpError("The MCP server refused the credential.");
    if (!res.ok) throw new McpError(`The MCP server returned HTTP ${res.status} for ${method}.`);
    this.sessionId = res.headers.get("mcp-session-id") ?? this.sessionId;
    const reply = await readReply(res, id);
    if (!reply) throw new McpError(`No reply to ${method} from the MCP server.`);
    if (reply.error) throw new McpError(`MCP error: ${reply.error.message}`);
    return reply.result as T;
  }

  async notify(method: string, params: unknown = {}) {
    await publicFetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }

  async initialize() {
    const r = await this.request<{ serverInfo?: { name?: string; version?: string } }>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Forge", version: "1.0" },
    });
    this.serverName = r.serverInfo?.name ?? "";
    await this.notify("notifications/initialized");
    return this;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.request<{ tools?: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const r = await this.request<{ content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown }>(
      "tools/call",
      { name, arguments: args },
      120_000,
    );
    const text = (r.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
      .join("\n")
      .trim();
    return { isError: !!r.isError, text: text || (r.structuredContent ? JSON.stringify(r.structuredContent) : "(no output)") };
  }
}

export async function openMcp(url: string, token?: string) {
  return new McpSession(url, token).initialize();
}
