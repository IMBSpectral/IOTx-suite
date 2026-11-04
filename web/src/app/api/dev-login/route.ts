import crypto from "node:crypto";
import { db } from "@/lib/db";
import { recordLogin } from "@/lib/login-log";

/**
 * Local test sign-in, for trying Forge before Google/GitHub sign-in is set up.
 * Off unless DEV_LOGIN_TOKEN is set in .env, and it needs that secret in the
 * link (/api/dev-login?token=…), so nobody else on the network can use it.
 * Signs in as the dev@localhost user. Never set DEV_LOGIN_TOKEN in production.
 */
export async function GET(req: Request) {
  const secret = process.env.DEV_LOGIN_TOKEN;
  const url = new URL(req.url);
  const given = url.searchParams.get("token") ?? "";
  const ok =
    !!secret &&
    secret.length >= 24 &&
    given.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return new Response("Not found", { status: 404 });

  const user = await db.user.findUnique({ where: { email: "dev@localhost" }, select: { id: true } });
  if (!user) return new Response("The dev@localhost user doesn't exist.", { status: 500 });

  const sessionToken = crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 86_400_000);
  await db.session.create({ data: { sessionToken, userId: user.id, expires } });
  await recordLogin(user.id, "dev");

  // Same cookie Auth.js uses for database sessions over plain http.
  const res = new Response(null, { status: 303, headers: { location: "/home" } });
  res.headers.append(
    "set-cookie",
    `authjs.session-token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}`,
  );
  return res;
}
