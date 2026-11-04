import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { decorateHtml, readSiteFile, seoForPath, type Seo } from "@/lib/publish";
import { recordSiteVisit } from "@/lib/projects";
import { SITE_COOKIE, canView, signSiteToken, verifySiteToken } from "@/lib/site-auth";

/**
 * Serves a published app at <sub>.localhost (rewritten here by proxy.ts).
 * Static files come from the immutable snapshot; any other path falls back to
 * index.html so client-side routes work. Non-public sites require the
 * site-auth handshake.
 */
type Ctx = { params: Promise<{ sub: string; path?: string[] }> };

const EDITOR = process.env.EDITOR_ORIGIN ?? "http://localhost:3000";

function page(status: number, title: string, body: string) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
      `<body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:system-ui,sans-serif;background:#fafaf9;color:#1c1917">` +
      `<div style="text-align:center;max-width:420px;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1><p style="color:#78716c;margin:0">${body}</p></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request, { params }: Ctx) {
  const { sub, path = [] } = await params;
  const url = new URL(req.url);
  const rel = path.join("/");

  // d~<domain>: a custom domain (see proxy.ts).
  const project = await db.project.findFirst({
    where: sub.startsWith("d~") ? { customDomain: sub.slice(2) } : { subdomain: sub },
    select: {
      id: true,
      workspaceId: true,
      publishedSha: true,
      publishAudience: true,
      showBadge: true,
      seo: true,
      deletedAt: true,
    },
  });
  if (!project?.publishedSha || project.deletedAt) {
    return page(404, "Nothing published here", "This app hasn't been published, or it was unpublished.");
  }

  // Completing the handshake: the editor sent us a short-lived token.
  if (rel === "__forge/auth") {
    const uid = await verifySiteToken(url.searchParams.get("token") ?? "", sub);
    if (!uid) return page(401, "Link expired", "Open the app again from the editor.");
    const long = await signSiteToken(sub, uid, "1d");
    const next = url.searchParams.get("next") ?? "/";
    const res = new Response(null, { status: 302, headers: { location: next.startsWith("/") ? next : "/" } });
    res.headers.append(
      "set-cookie",
      `${SITE_COOKIE}=${long}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    );
    return res;
  }

  if (project.publishAudience !== "public") {
    const token = (await cookies()).get(SITE_COOKIE)?.value;
    const uid = token ? await verifySiteToken(token, sub) : null;
    if (!(await canView(project, uid))) {
      if (uid) return page(403, "No access", "This app is shared with specific people only.");
      const back = `${EDITOR}/api/site-auth?sub=${encodeURIComponent(sub)}&next=${encodeURIComponent(url.pathname + url.search)}`;
      return new Response(null, { status: 302, headers: { location: back } });
    }
  }

  // A real file (asset, image, favicon…) is served as-is.
  if (rel && rel !== "index.html") {
    const file = await readSiteFile(project.id, project.publishedSha, rel);
    if (file) {
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          "content-type": file.type,
          // Vite fingerprints everything under assets/, so it never changes.
          "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    }
    // An asset that doesn't exist is a 404, not the app shell.
    if (/\.[a-z0-9]{1,5}$/i.test(rel)) return new Response("Not found", { status: 404 });
  }

  const index = await readSiteFile(project.id, project.publishedSha, "index.html");
  if (!index) return page(500, "Build missing", "Republish the app from the editor.");
  // Page views (not asset requests) feed the project's analytics.
  void recordSiteVisit(project.id).catch(() => undefined);
  const html = decorateHtml(index.bytes.toString("utf8"), seoForPath((project.seo as Seo | null) ?? {}, rel), {
    badge: project.showBadge,
    editorUrl: `${EDITOR}/projects/${project.id}`,
  });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The shell always revalidates so a republish is picked up immediately.
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      // Safe defaults for every published app; a CSP is the app's own (a meta tag in index.html).
      "referrer-policy": "strict-origin-when-cross-origin",
      // Framed only by itself and by the suite (dashboards show apps as modules); never by other sites.
      "content-security-policy": `frame-ancestors 'self' ${EDITOR}`,
      "permissions-policy": "camera=(self), microphone=(self), geolocation=(self)",
    },
  });
}
