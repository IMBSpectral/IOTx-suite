import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  for (const b of await db.build.findMany({ orderBy: { createdAt: "desc" }, take: 3 })) {
    console.log("BUILD", b.status, "| err:", b.error, "| tok:", b.inputTokens, b.outputTokens);
  }
  for (const m of await db.message.findMany({ orderBy: { createdAt: "desc" }, take: 2 })) {
    console.log(m.role, "->", JSON.stringify(m.content).slice(0, 600));
  }
  await db.$disconnect();
}
main();
