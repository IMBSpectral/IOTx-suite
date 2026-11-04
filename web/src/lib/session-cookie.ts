/**
 * Auth.js names its session cookie by protocol: "__Secure-authjs.session-token"
 * (Secure) on HTTPS, "authjs.session-token" on plain HTTP. Routes that create or
 * read sessions themselves (SSO, dev sign-in, two-step verification) use this.
 */
const ORIGIN = process.env.AUTH_URL ?? process.env.EDITOR_ORIGIN ?? "";
export const SECURE_COOKIES = ORIGIN.startsWith("https://");
export const SESSION_COOKIE = SECURE_COOKIES ? "__Secure-authjs.session-token" : "authjs.session-token";

/** A Set-Cookie value for a new session. */
export function sessionCookie(token: string, expires: Date) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${SECURE_COOKIES ? "; Secure" : ""}`;
}

/** The session token from a Cookie header (either name, so a protocol change can't strand a session). */
export function sessionTokenFrom(cookieHeader: string | null | undefined) {
  const m = (cookieHeader ?? "").match(/(?:^|;\s*)(?:__Secure-)?authjs\.session-token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
