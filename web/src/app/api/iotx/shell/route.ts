import { db } from "@/lib/db";
import { route } from "@/lib/route";
import { getBrand } from "@/lib/brand";
import { shellData } from "@/lib/iotx/shell";
import { MANIFESTS, SIDEBAR_APPS } from "@/lib/iotx/manifests";
import { cleanAppearance, paintPayload, type Appearance } from "@/lib/iotx/appearance";
import { loadAppearance } from "@/lib/iotx/appearance-server";
import { forbidden, serviceKeyOk } from "@/lib/iotx/service-key";

/**
 * Server to server (header x-iotx-key: <IOTX_SERVICE_KEY>), for IOTx apps that
 * run as their own process (apps/workspace) but render inside the suite shell.
 *
 *   GET  ?userId=<suite user id>[&ws=<workspace id>]
 *        -> { shell: the same data shellData() gives the suite's own pages
 *             (user, perms, appearance, workspace(s), recent chats),
 *             paint (palettes for the first paint), brand, apps (every app the
 *             person can open, launcher order), sidebar (SIDEBAR_APPS) }
 *   POST { userId, appearance: Partial<Appearance> }
 *        -> save the theme menu's choice to the account, { appearance, paint }
 */
async function GET_(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const q = new URL(req.url).searchParams;
  const userId = q.get("userId");
  if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });
  const data = await shellData(userId, q.get("ws") || undefined);
  if (!data) return Response.json({ error: "Not a member of that workspace" }, { status: 404 });
  const open = new Set(data.perms?.apps ?? []);
  const apps = MANIFESTS.filter((m) => m.id !== "home" && !m.settingsOnly && open.has(m.id)).map((m) => ({
    id: m.id,
    name: m.name,
    desc: m.desc,
    color: m.color,
    icon: m.icon,
    status: m.status,
    href: m.status === "live" && m.href ? m.href : `/apps/${m.id}`,
  }));
  return Response.json(
    { shell: data, paint: paintPayload(data.appearance), brand: getBrand(), apps, sidebar: SIDEBAR_APPS },
    { headers: { "cache-control": "no-store" } },
  );
}

async function POST_(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const b = (await req.json().catch(() => ({}))) as { userId?: string; appearance?: Record<string, unknown> };
  if (!b.userId || !b.appearance || typeof b.appearance !== "object") return Response.json({ error: "userId and appearance are required" }, { status: 400 });
  const user = await db.user.findUnique({ where: { id: b.userId }, select: { id: true } });
  if (!user) return Response.json({ error: "Unknown user" }, { status: 404 });
  const next = cleanAppearance(b.appearance as Partial<Appearance>, await loadAppearance(user.id));
  await db.user.update({
    where: { id: user.id },
    data: { theme: next.theme, accent: next.accent, accentCustom: next.accentCustom, shellBg: next.shellBg as object },
  });
  return Response.json({ appearance: next, paint: paintPayload(next) });
}

export const GET = route(GET_);
export const POST = route(POST_);
