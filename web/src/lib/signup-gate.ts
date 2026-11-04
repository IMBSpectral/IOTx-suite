import { cookies } from "next/headers";
import { db } from "./db";

/**
 * Who may create a new account. With FORGE_SIGNUP_ALLOW unset, anyone can
 * (the original behaviour). With it set (comma-separated emails and
 * "@domain" entries), a new person may sign up only if their email matches,
 * or they arrived through an invite link (the proxy remembers it in
 * INVITE_COOKIE). Existing accounts can always sign in.
 */
export const INVITE_COOKIE = "iotx_invite";

function listed(email: string) {
  const rules = (process.env.FORGE_SIGNUP_ALLOW ?? "").split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return null; // not configured: open
  const e = email.toLowerCase();
  return rules.some((r) => (r.startsWith("@") ? e.endsWith(r) : e === r));
}

export async function mayCreateAccount(email: string | null | undefined) {
  if (!email) return false;
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) return true;
  const ok = listed(email);
  if (ok === null || ok) return true;
  return !!(await cookies()).get(INVITE_COOKIE)?.value;
}
