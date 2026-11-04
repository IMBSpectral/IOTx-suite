import { handleForgeMcp } from "@/lib/forge-mcp";

/** The Forge MCP server (Streamable HTTP, JSON responses). Authenticated by a workspace API key, never cookies. */
export const POST = (req: Request) => handleForgeMcp(req);
export const GET = (req: Request) => handleForgeMcp(req);
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
    },
  });
}
