import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  for (const p of await db.project.findMany({ select: { name: true, subdomain: true, publishedSha: true, publishedAt: true } })) {
    console.log(JSON.stringify(p));
  }
  console.log("findings:", await db.securityFinding.count());
  await db.$disconnect();
}
main();
