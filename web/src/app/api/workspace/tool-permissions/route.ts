import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { approve, listPrefs, setPref } from "@/lib/tool-permissions";
import { audit } from "@/lib/workspace-security";

const KEY = /^(connector|mcp):[^:]{1,80}:[^:]{1,120}$/;

/** Saved tool permissions and live temporary approvals. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  return Response.json(await listPrefs(ws.id));
}

/**
 * approve {key, how: once | hour | always | deny} (from an approval card) ·
 * set {key, pref: ask | allow | null} (settings). Changing a lasting
 * preference needs an owner or admin; any member can allow once or for an hour.
 */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as { action?: string; key?: string; how?: string; pref?: string | null };
  if (!b.key || !KEY.test(b.key)) return Response.json({ error: "Unknown tool" }, { status: 400 });
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } }, select: { role: true } });
  if (!m || m.role === "VIEWER") return Response.json({ error: "Only workspace members can approve tools." }, { status: 403 });
  const admin = m.role === "OWNER" || m.role === "ADMIN";
  if (b.action === "approve") {
    if (!["once", "hour", "always", "deny"].includes(b.how ?? "")) return Response.json({ error: "Unknown answer" }, { status: 400 });
    if (b.how === "always" && !admin) return Response.json({ error: "Only owners and admins can always allow a tool." }, { status: 403 });
    await approve(ws.id, b.key, b.how as "once");
    if (b.how === "always") await audit(ws.id, user.id, "rules.changed", `Always allow ${b.key}`);
    return Response.json({ ok: true });
  }
  if (b.action === "set") {
    if (!admin) return Response.json({ error: "Only owners and admins can change tool permissions." }, { status: 403 });
    if (b.pref !== null && b.pref !== "ask" && b.pref !== "allow") return Response.json({ error: "ask, allow or null" }, { status: 400 });
    await setPref(ws.id, b.key, (b.pref as "ask" | "allow" | null) ?? null);
    await audit(ws.id, user.id, "rules.changed", `${b.key}: ${b.pref ?? "default"}`);
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export const GET = route(GET_);
export const POST = route(POST_);
