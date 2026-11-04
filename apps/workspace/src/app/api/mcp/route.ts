import { HttpError } from "@/lib/auth";
import { tokenMe } from "@/lib/meet/external";
import { handleRpc } from "@/lib/meet/mcp";

export const dynamic = "force-dynamic";

/**
 * MCP server (Streamable HTTP, JSON-RPC 2.0) for meeting reports:
 * POST /workspace/api/mcp with "Authorization: Bearer iotxr_…" (Meet →
 * Integrations → API tokens). Requests get one JSON reply; notifications get
 * 202. There is no server-to-client stream, so GET answers 405 (the spec
 * allows that). Browsers from other sites are refused (Origin check, against
 * DNS rebinding).
 */
const json = (d: unknown, status = 200, h: Record<string, string> = {}) => Response.json(d, { status, headers: { "cache-control": "no-store", ...h } });

function originOk(req: Request) {
  const o = req.headers.get("origin");
  if (!o) return true;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(o).host === host;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!originOk(req)) return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Origin not allowed" } }, 403);
  let me;
  try {
    me = (await tokenMe(req)).me;
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 401;
    const message = e instanceof HttpError ? e.message : "Unauthorized";
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, status, status === 401 ? { "www-authenticate": `Bearer realm="IOTx Meet", error="invalid_token"` } : {});
  }
  let msg: unknown;
  try {
    msg = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  try {
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.slice(0, 20).map((m) => handleRpc(me, m)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const r = await handleRpc(me, msg as never);
    if (!r) return new Response(null, { status: 202 });
    return json(r, r.error?.code === -32600 ? 400 : 200);
  } catch (e) {
    console.error("[mcp]", e);
    return json({ jsonrpc: "2.0", id: (msg as { id?: string | number })?.id ?? null, error: { code: -32603, message: "Internal error" } }, 500);
  }
}

export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
