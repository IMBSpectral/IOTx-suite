import { requirePerm } from "@/lib/iotx/permissions";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { audit } from "@/lib/workspace-security";
import { browserSettings, saveBrowserSettings } from "@/lib/cloud-browser";

/** Cloud browser settings: on/off, allowed sites or any site, idle limit. Changes are for owners and admins. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  return Response.json(await browserSettings(ws.id));
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  await requirePerm(user.id, ws.id, "builder.browser");
  const s = await saveBrowserSettings(ws.id, (await req.json().catch(() => ({}))) as Record<string, never>);
  await audit(ws.id, user.id, "workspace.settings", `Cloud browser: ${s.enabled ? "on" : "off"}, ${s.anySite ? "any site" : `${s.allowed.length} allowed sites`}`);
  return Response.json(s);
}

export const GET = route(GET_);
export const POST = route(POST_);
