/**
 * Local only: makes a 1-day browser session for a user in the local database.
 *   npx tsx scripts/_dev-session.mts [email]   (no email: lists users)
 */
import "dotenv/config";
import crypto from "node:crypto";
import { db } from "../src/lib/db";

const [email] = process.argv.slice(2);
if (!email) {
  const users = await db.user.findMany({ select: { email: true, name: true }, take: 30, orderBy: { createdAt: "desc" } });
  for (const u of users) console.log(u.email, "|", u.name);
} else {
  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error("no such user");
  const sessionToken = crypto.randomUUID();
  await db.session.create({ data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 86_400_000) } });
  console.log(sessionToken);
}
process.exit(0);
