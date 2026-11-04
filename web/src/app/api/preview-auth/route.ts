import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { signSiteToken } from "@/lib/site-auth";
import { linkStatus, previewLinkUrl } from "@/lib/sharing";
import { previewViewerAllowed } from "@/lib/workspace-security";

/**
 * Sign-in for preview links when the workspace requires it ("Sign-in only"):
 * on the editor's origin, where the session exists, check the person is a
 * member or on a verified domain, then send them back to the link with a
 * two-minute token (the same handshake as private published sites).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const next = url.searchParams.get("next") ?? "/";

  const session = await auth();
  const userId = session?.user?.id ?? null;
  if (!userId) {
    const back = `/api/preview-auth?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
    return Response.redirect(
      new URL(`/login?callbackUrl=${encodeURIComponent(back)}`, url),
      302,
    );
  }

  const link = await db.previewLink.findUnique({
    where: { token },
    include: {
      project: {
        select: {
          deletedAt: true,
          workspace: { select: { id: true, verifiedDomains: true } },
        },
      },
    },
  });
  if (!link || link.project.deletedAt || linkStatus(link) !== "active")
    return new Response("This preview link isn't active.", { status: 410 });
  if (!(await previewViewerAllowed(link.project.workspace, userId))) {
    return new Response(
      "This preview is only for people in the workspace or from its verified domains.",
      { status: 403 },
    );
  }
  const t = await signSiteToken(`preview--${token}`, userId, "2m");
  return Response.redirect(
    `${previewLinkUrl(token)}/__forge/auth?token=${encodeURIComponent(t)}&next=${encodeURIComponent(next.startsWith("/") ? next : "/")}`,
    302,
  );
}
