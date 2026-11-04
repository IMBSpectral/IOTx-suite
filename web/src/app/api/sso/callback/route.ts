import { finishSso, SsoError } from "@/lib/sso";
import { WORKSPACE_COOKIE } from "@/lib/workspace";
import { sessionCookie } from "@/lib/session-cookie";

/** Back from the identity provider: sign in, join the workspace, open it. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const state = req.headers.get("cookie")?.match(/(?:^|;\s*)forge_sso_state=([^;]+)/)?.[1] ?? null;
  try {
    const r = await finishSso(url.searchParams, state);
    const res = new Response(null, { status: 303, headers: { location: r.next } });
    res.headers.append("set-cookie", sessionCookie(r.sessionToken, r.expires));
    res.headers.append("set-cookie", `${WORKSPACE_COOKIE}=${r.workspaceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    res.headers.append("set-cookie", "forge_sso_state=; Path=/api/sso; Max-Age=0");
    return res;
  } catch (e) {
    const msg = e instanceof SsoError ? e.message : "Single sign-on failed.";
    return new Response(null, { status: 303, headers: { location: `/login?sso_error=${encodeURIComponent(msg)}` } });
  }
}
