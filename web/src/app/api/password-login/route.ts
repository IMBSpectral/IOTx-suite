import { passwordSignIn } from "@/lib/password-login";
import { sessionCookie } from "@/lib/session-cookie";

/**
 * POST (form) email, password, next -> a session cookie and on to next (or /home);
 * a wrong password goes back to /login with the reason. Same-origin forms only.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Forbidden", { status: 403 });
  const fd = await req.formData();
  const raw = String(fd.get("next") ?? "");
  const next = raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/home";
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const r = await passwordSignIn(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""), ip);
  const back = (path: string) => new URL(path, `${url.protocol}//${host ?? url.host}`).toString();
  if ("error" in r) {
    const q = new URLSearchParams({ pw_error: r.error ?? "", ...(raw ? { redirect: next } : {}), email: String(fd.get("email") ?? "").slice(0, 200) });
    return new Response(null, { status: 303, headers: { location: back(`/login?${q}`) } });
  }
  const res = new Response(null, { status: 303, headers: { location: back(next) } });
  res.headers.append("set-cookie", sessionCookie(r.sessionToken, r.expires));
  return res;
}
