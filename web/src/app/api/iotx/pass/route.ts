import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { issuePass } from "@/lib/iotx/pass";

/**
 * GET /api/iotx/pass?app=<id>[&redirect=/path]
 * A short-lived signed pass for an app mounted under this domain. With
 * `redirect` (a path on this site) the browser is sent there with the pass in
 * the URL fragment (#iotx_pass=…), which never reaches server logs.
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const url = new URL(req.url);
  const app = url.searchParams.get("app") ?? "";
  const pass = await issuePass(user.id, ws.id, app);
  if (!pass) return Response.json({ error: "You can't open that app. Ask an admin to turn it on." }, { status: 403 });
  const to = url.searchParams.get("redirect");
  if (to) {
    // Local dev only: an app on another port (IOTx Workspace) may be named by
    // origin in WORKSPACE_ORIGIN; production stays same-origin paths.
    const devOrigins = (process.env.WORKSPACE_ORIGIN ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
    const allowedAbsolute = devOrigins.some((o) => to.startsWith(`${o}/`) && !to.includes("\\"));
    if (!allowedAbsolute && (!to.startsWith("/") || to.startsWith("//") || to.includes("\\"))) return Response.json({ error: "redirect must be a path on this site" }, { status: 400 });
    return new Response(null, { status: 303, headers: { location: `${to}#iotx_pass=${pass.token}`, "cache-control": "no-store" } });
  }
  return Response.json(pass, { headers: { "cache-control": "no-store" } });
}

export const GET = route(GET_);
