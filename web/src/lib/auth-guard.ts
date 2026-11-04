/**
 * Bot and abuse protection for apps' sign-in and sign-up (Forge Cloud auth):
 * failed passwords are limited per email and per IP address, sign-ups per IP,
 * and requests that look scripted (no browser user agent, headless browsers)
 * are refused. Counters live in memory and reset on their own.
 */
export const LOGIN_FAILS_PER_EMAIL = 5;
export const LOGIN_FAILS_PER_IP = 20;
export const SIGNUPS_PER_IP = 10;
const WINDOW_MS = 15 * 60_000;
const SIGNUP_WINDOW_MS = 60 * 60_000;

const hits = new Map<string, number[]>();

function count(key: string, windowMs: number, now = Date.now()) {
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.set(key, list);
  return list.length;
}
function record(key: string, now = Date.now()) {
  hits.set(key, [...(hits.get(key) ?? []), now].slice(-200));
}

export class GuardError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfter?: number) {
    super(message);
  }
}

export function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

/** How likely the request is automated, 0–100. */
export function botScore(req: Request) {
  const ua = req.headers.get("user-agent") ?? "";
  let score = 0;
  if (!ua) score += 60;
  else if (/HeadlessChrome|PhantomJS|python-requests|curl\/|Go-http-client|libwww|scrapy/i.test(ua)) score += 70;
  if (!req.headers.get("accept-language")) score += 15;
  return Math.min(100, score);
}

export function guardLogin(projectId: string, req: Request, email: string) {
  const ip = clientIp(req);
  const e = email.trim().toLowerCase();
  if (count(`login:${projectId}:email:${e}`, WINDOW_MS) >= LOGIN_FAILS_PER_EMAIL || count(`login:${projectId}:ip:${ip}`, WINDOW_MS) >= LOGIN_FAILS_PER_IP) {
    throw new GuardError("Too many sign-in attempts. Try again in 15 minutes.", 429, 900);
  }
}

export function loginFailed(projectId: string, req: Request, email: string) {
  record(`login:${projectId}:email:${email.trim().toLowerCase()}`);
  record(`login:${projectId}:ip:${clientIp(req)}`);
}

export function loginSucceeded(projectId: string, email: string) {
  hits.delete(`login:${projectId}:email:${email.trim().toLowerCase()}`);
}

export function guardSignup(projectId: string, req: Request) {
  if (botScore(req) >= 70) throw new GuardError("This sign-up looks automated and was blocked.", 403);
  const key = `signup:${projectId}:ip:${clientIp(req)}`;
  if (count(key, SIGNUP_WINDOW_MS) >= SIGNUPS_PER_IP) throw new GuardError("Too many sign-ups from this network. Try again later.", 429, 3600);
  record(key);
}
