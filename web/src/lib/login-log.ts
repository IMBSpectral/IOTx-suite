import { headers } from "next/headers";
import { db } from "./db";

/** Record a sign-in for People → Login history. Never throws: a log failure must not block signing in. */
export async function recordLogin(userId: string, provider: string) {
  try {
    const h = await headers();
    const ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "").split(",")[0].trim().slice(0, 64) || null;
    await db.loginEvent.create({ data: { userId, provider, ip, userAgent: h.get("user-agent")?.slice(0, 300) ?? null } });
  } catch {}
}
