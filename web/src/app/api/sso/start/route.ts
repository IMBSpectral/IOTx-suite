import { SsoError, startSso, workspaceForEmail } from "@/lib/sso";

/** Sign in with SSO: ?email= finds the workspace by domain and sends the person to its identity provider. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const ws = await workspaceForEmail(q.get("email") ?? "");
  if (!ws) return Response.redirect(new URL(`/login?sso_error=${encodeURIComponent("No workspace signs in with SSO for that email domain.")}`, req.url), 303);
  try {
    const { url, cookie } = await startSso(ws, q.get("next") ?? "/home");
    // SAML carries its state in the signed RelayState: the IdP posts back cross-site, where a Lax cookie wouldn't come along.
    if (!cookie) return new Response(null, { status: 302, headers: { location: url } });
    return new Response(null, {
      status: 302,
      headers: { location: url, "set-cookie": `forge_sso_state=${cookie}; Path=/api/sso; HttpOnly; SameSite=Lax; Max-Age=600` },
    });
  } catch (e) {
    const msg = e instanceof SsoError ? e.message : "SSO couldn't start.";
    return Response.redirect(new URL(`/login?sso_error=${encodeURIComponent(msg)}`, req.url), 303);
  }
}
