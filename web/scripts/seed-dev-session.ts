/**
 * Creates a local user, workspace and session so the app can be exercised
 * without configuring an OAuth provider. Development only — it writes a
 * session row directly, which is exactly what the OAuth callback would do.
 *
 *   npx tsx scripts/seed-dev-session.ts
 *
 * Prints the session token to set as the `authjs.session-token` cookie.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const email = "dev@localhost";

  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    user = await db.user.create({
      data: { email, name: "Dev User", handle: "dev" },
    });
    await db.workspace.create({
      data: {
        name: "Dev workspace",
        slug: `dev-${randomUUID().slice(0, 6)}`,
        creditBalance: 500,
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
  }

  const sessionToken = randomUUID();
  await db.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  console.log(JSON.stringify({ userId: user.id, sessionToken }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
