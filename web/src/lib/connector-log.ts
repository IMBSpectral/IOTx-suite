import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";

/**
 * Connector request log: every call the agent makes through a connector or
 * MCP server, per workspace (project, connection, request, status, time).
 * Paths are kept without their query string, so tokens in URLs never land
 * here. Old entries are trimmed as the file grows.
 */

export type ConnectorLogEntry = { at: string; projectId: string | null; connection: string; kind: string; request: string; status: number | null; ms: number };

const file = (workspaceId: string) => path.join(PROJECTS_ROOT, "_forge", "connector-logs", `${workspaceId.replace(/[^\w-]/g, "")}.jsonl`);
const MAX_BYTES = 2 * 1024 * 1024;

export async function logConnectorRequest(workspaceId: string, e: Omit<ConnectorLogEntry, "at">) {
  const f = file(workspaceId);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.appendFile(f, JSON.stringify({ at: new Date().toISOString(), ...e, request: e.request.split("?")[0].slice(0, 200) }) + "\n");
  const st = await fs.stat(f).catch(() => null);
  if (st && st.size > MAX_BYTES) {
    const lines = (await fs.readFile(f, "utf8")).trim().split("\n");
    await fs.writeFile(f, lines.slice(-5000).join("\n") + "\n");
  }
}

export async function readConnectorLog(workspaceId: string, opts: { projectId?: string | null } = {}) {
  const raw = await fs.readFile(file(workspaceId), "utf8").catch(() => "");
  const all = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ConnectorLogEntry);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const recent = all.filter((e) => e.at >= since);
  const usage = new Map<string, { connection: string; kind: string; requests: number; errors: number }>();
  for (const e of recent) {
    const u = usage.get(e.connection) ?? { connection: e.connection, kind: e.kind, requests: 0, errors: 0 };
    u.requests++;
    if (!e.status || e.status >= 400) u.errors++;
    usage.set(e.connection, u);
  }
  const log = (opts.projectId ? all.filter((e) => e.projectId === opts.projectId) : all).slice(-300).reverse();
  return { usage: [...usage.values()].sort((a, b) => b.requests - a.requests), log };
}
