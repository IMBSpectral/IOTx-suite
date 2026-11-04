import { db } from "@/lib/db";
import { SITES_HOSTNAME } from "@/lib/site-host";

/**
 * Asked by the HTTPS proxy (Caddy on-demand TLS) before it requests a
 * certificate for a host: 200 only for the platform itself, published
 * subdomains, preview/version links and connected custom domains.
 */
export async function GET(req: Request) {
  const domain = (new URL(req.url).searchParams.get("domain") ?? "").toLowerCase().replace(/\.$/, "");
  const ok = (yes: boolean) => new Response(null, { status: yes ? 200 : 404 });
  if (!domain) return ok(false);
  if (domain === SITES_HOSTNAME || domain === `www.${SITES_HOSTNAME}`) return ok(true);
  if (domain.endsWith(`.${SITES_HOSTNAME}`)) {
    const label = domain.slice(0, -SITES_HOSTNAME.length - 1);
    if (label.includes(".")) return ok(false);
    if (/^(preview|version)--[A-Za-z0-9_-]+$/i.test(label)) return ok(true);
    // Live previews (sbx-<projectId>, see lib/sandbox-proxy.ts) for projects that exist.
    const sbx = /^sbx-([0-9a-f-]{36})$/.exec(label)?.[1];
    if (sbx) return ok(!!(await db.project.findUnique({ where: { id: sbx }, select: { id: true } })));
    return ok(!!(await db.project.findFirst({ where: { subdomain: label }, select: { id: true } })));
  }
  return ok(!!(await db.project.findFirst({ where: { customDomain: domain }, select: { id: true } })));
}
