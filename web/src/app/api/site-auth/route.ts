import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canView, signSiteToken } from "@/lib/site-auth";
import { siteUrl } from "@/lib/publish";

/**
 * First half of the handshake for non-public sites: on the editor's origin,
 * where the session cookie exists, check access and send the browser back to
 * the site with a two-minute token.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sub = url.searchParams.get("sub") ?? "";
  const next = url.searchParams.get("next") ?? "/";

  const session = await auth();
  const userId = session?.user?.id ?? null;
  if (!userId) {
    const back = `/api/site-auth?sub=${encodeURIComponent(sub)}&next=${encodeURIComponent(next)}`;
    return Response.redirect(new URL(`/login?callbackUrl=${encodeURIComponent(back)}`, url), 302);
  }

  const project = await db.project.findFirst({
    where: sub.startsWith("d~") ? { customDomain: sub.slice(2) } : { subdomain: sub },
    select: { id: true, workspaceId: true, publishAudience: true },
  });
  if (!project || !(await canView(project, userId))) {
    return new Response("You don't have access to this app.", { status: 403 });
  }

  const token = await signSiteToken(sub, userId, "2m");
  // Custom domains are served over HTTPS (FORGE_DOMAIN_PROTOCOL overrides, e.g. for local tests).
  const origin = sub.startsWith("d~") ? `${process.env.FORGE_DOMAIN_PROTOCOL ?? "https"}://${sub.slice(2)}` : siteUrl(sub);
  const target = `${origin}/__forge/auth?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next.startsWith("/") ? next : "/")}`;
  return Response.redirect(target, 302);
}
