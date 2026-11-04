import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { acceptGuest, requestLink } from "@/lib/chat-guests";
import { BASE, SESSION_COOKIE } from "@/lib/env";
import { body, route } from "@/lib/http";

/**
 * No sign-in needed:
 * POST { token, name?, tz? } -> signs a guest in from their emailed link (sets the session cookie)
 * POST { email }             -> emails a new sign-in link if the address is an active guest (always { ok })
 */
async function POST_(req: Request) {
  const b = await body<{ token?: string; name?: string; tz?: string; email?: string }>(req);
  if (b.email !== undefined) return Response.json(await requestLink(b.email));
  const s = await acceptGuest(String(b.token ?? ""), b);
  const jar = await cookies();
  const old = jar.get(SESSION_COOKIE)?.value;
  if (old) await db.session.deleteMany({ where: { id: old } });
  jar.set(SESSION_COOKIE, s.sid, { httpOnly: true, sameSite: "lax", path: BASE, secure: process.env.NODE_ENV === "production" && !/^http:\/\/localhost/.test(process.env.WORKSPACE_PUBLIC_URL ?? ""), maxAge: s.maxAge });
  return Response.json({ ok: true });
}

export const POST = route(POST_);
