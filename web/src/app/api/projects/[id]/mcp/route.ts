import { requireUser, requireProject } from "@/lib/workspace";
import { getBrand } from "@/lib/brand";
import { route } from "@/lib/route";
import { disableMcp, issueMcpToken, mcpInfo } from "@/lib/app-mcp";
import { audit } from "@/lib/workspace-security";

type Ctx = { params: Promise<{ id: string }> };

/** The app's MCP server: its URL and whether it's on. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "view");
  return Response.json(await mcpInfo(id));
}

/** Turn the MCP server on (token shown once), rotate the token, or turn it off. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "admin");
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  const info = await mcpInfo(id);
  if (!info.cloud) return Response.json({ error: `Turn on ${getBrand().shortName} Cloud first: the MCP server serves the app's data.` }, { status: 409 });
  if (action === "enable" || action === "rotate") {
    const token = await issueMcpToken(id);
    await audit(project.workspaceId, user.id, "workspace.settings", `${action === "rotate" ? "Rotated the MCP token" : "Turned on the MCP server"} for "${project.name}"`, id);
    return Response.json({ ...(await mcpInfo(id)), token });
  }
  if (action === "disable") {
    await disableMcp(id);
    await audit(project.workspaceId, user.id, "workspace.settings", `Turned off the MCP server for "${project.name}"`, id);
    return Response.json(await mcpInfo(id));
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export const GET = route(GET_);
export const POST = route(POST_);
