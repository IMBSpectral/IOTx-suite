import { finishSaml, SsoError } from "@/lib/sso";
import { WORKSPACE_COOKIE } from "@/lib/workspace";
import { sessionCookie } from "@/lib/session-cookie";

/** The identity provider POSTs the signed SAML response here: sign in, join the workspace, open it. */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  try {
    const r = await finishSaml({ SAMLResponse: form?.get("SAMLResponse")?.toString(), RelayState: form?.get("RelayState")?.toString() });
    const res = new Response(null, { status: 303, headers: { location: r.next } });
    res.headers.append("set-cookie", sessionCookie(r.sessionToken, r.expires));
    res.headers.append("set-cookie", `${WORKSPACE_COOKIE}=${r.workspaceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return res;
  } catch (e) {
    const msg = e instanceof SsoError ? e.message : "Single sign-on failed.";
    return new Response(null, { status: 303, headers: { location: `/login?sso_error=${encodeURIComponent(msg)}` } });
  }
}
