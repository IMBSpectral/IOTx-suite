import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { signIn } from "@/lib/auth";
import { BASE, SESSION_COOKIE } from "@/lib/env";
import { body, route } from "@/lib/http";

/**
 * POST { pass, tz? }  -> verifies the suite pass and sets the session cookie (path /workspace).
 * DELETE              -> signs out of Workspace.
 */
async function POST_(req: Request) {
  const b = await body<{ pass?: string; tz?: string }>(req);
  if (!b.pass) return Response.json({ error: "pass is required" }, { status: 400 });
  const s = await signIn(b.pass, b.tz);
  if (!s) return Response.json({ error: "That sign-in pass isn't valid or has expired." }, { status: 401 });
  const jar = await cookies();
  const old = jar.get(SESSION_COOKIE)?.value;
  if (old) await db.session.deleteMany({ where: { id: old } });
  jar.set(SESSION_COOKIE, s.id, { httpOnly: true, sameSite: "lax", path: BASE, secure: process.env.NODE_ENV === "production" && !/^http:\/\/localhost/.test(process.env.WORKSPACE_PUBLIC_URL ?? ""), maxAge: 7 * 86_400 });
  return Response.json({ ok: true, user: { id: s.claims.sub, name: s.claims.name, email: s.claims.email }, ws: s.claims.ws });
}

async function DELETE_() {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (sid) await db.session.deleteMany({ where: { id: sid } });
  jar.delete({ name: SESSION_COOKIE, path: BASE });
  return Response.json({ ok: true });
}

export const POST = route(POST_);
export const DELETE = route(DELETE_);
