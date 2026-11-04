import { NextResponse, type NextRequest } from "next/server";

/**
 * Published apps live on their own host, <sub>.localhost — the local mirror of
 * <sub>.lovable.app. Requests for such a host are rewritten to the route that
 * serves the published snapshot; everything else is the editor.
 */
const SITE_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.localhost(?::\d+)?$/i;
// In production, also <sub>.<PUBLIC_SITES_HOST> (e.g. inventory.imbspectral.online).
const SITES_HOSTNAME = (process.env.PUBLIC_SITES_HOST ?? "localhost").toLowerCase().replace(/:\d+$/, "");
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function siteLabel(host: string): [string, string] | null {
  const m = SITE_HOST.exec(host);
  if (m) return [m[0], m[1]];
  const name = host.toLowerCase().replace(/:\d+$/, "");
  if (SITES_HOSTNAME === "localhost" || !name.endsWith("." + SITES_HOSTNAME)) return null;
  const label = name.slice(0, -SITES_HOSTNAME.length - 1);
  return LABEL.test(label) ? [name, label] : null;
}

// Any other named host that isn't the editor's is a custom domain pointed at Forge.
const EDITOR_HOST = new URL(process.env.EDITOR_ORIGIN ?? "http://localhost:3000").hostname.toLowerCase();
const NAMED_HOST = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::\d+)?$/i;
function customDomain(host: string) {
  const m = NAMED_HOST.exec(host);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return name === EDITOR_HOST || name.endsWith(".localhost") || name === SITES_HOSTNAME || name.endsWith("." + SITES_HOSTNAME) ? null : name;
}

/**
 * The suite's own pages may be framed only by the suite itself (its tabs are
 * same-origin iframes); no other site can frame them. Published sites and
 * custom domains are left alone.
 */
function sameOriginFrames(res: NextResponse) {
  res.headers.set("X-Frame-Options", "SAMEORIGIN");
  res.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  return res;
}

/**
 * A rewrite to another path on this server. Behind the HTTPS proxy (Caddy),
 * nextUrl says https://localhost:3000 while the server itself speaks plain
 * HTTP; a rewrite left on https makes Next fetch https://localhost:3000 and
 * fail ("wrong version number" → 500 on every published app). Internal
 * targets always go over http.
 */
function internal(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) url.protocol = "http:";
  return NextResponse.rewrite(url);
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const match = siteLabel(host);
  const domain = match ? null : customDomain(host);
  if (domain) {
    return internal(request, `/hosted/d~${domain}${request.nextUrl.pathname}`);
  }
  if (!match) {
    // Invite links: remember the token so an invitation-only install lets this person sign up.
    const invite = request.nextUrl.pathname.match(/^\/join\/(?:ws\/)?([A-Za-z0-9_-]{8,128})$/);
    if (invite) {
      const res = NextResponse.next();
      res.cookies.set("iotx_invite", invite[1], { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24, path: "/" });
      return sameOriginFrames(res);
    }
    // "Share Forge" links: remember who referred this visitor until signup.
    const ref = request.nextUrl.searchParams.get("ref");
    if (request.nextUrl.pathname === "/login" && ref && /^[A-Za-z0-9_-]{6,64}$/.test(ref)) {
      const res = NextResponse.next();
      res.cookies.set("forge_ref", ref, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30, path: "/" });
      return sameOriginFrames(res);
    }
    // Pages only: API routes set their own policies (sandboxed files, previews), and /workspace*
    // is another app (proxied here in local dev, by Caddy live) that sets its own.
    // Published apps, shared previews and versions (reached here after the rewrite below) set
    // their own frame rules so a suite dashboard can show them; don't overwrite those.
    if (/^\/(api|_next|workspace|hosted|shared|versions)(\/|$)/.test(request.nextUrl.pathname)) return NextResponse.next();
    return sameOriginFrames(NextResponse.next());
  }
  const label = match[1].toLowerCase();
  // preview--<token>: a shared preview link ("--" is never a project subdomain).
  // version--<token>: one past version, opened from History.
  return internal(
    request,
    label.startsWith("preview--")
      ? `/shared/${label.slice("preview--".length)}${request.nextUrl.pathname}`
      : label.startsWith("version--")
        ? `/versions/${label.slice("version--".length)}${request.nextUrl.pathname}`
        : `/hosted/${label}${request.nextUrl.pathname}`,
  );
}
