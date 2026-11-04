import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const ws = await db.workspace.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  await db.$transaction([
    db.workspace.update({ where: { id: ws.id }, data: { creditBalance: 2000 } }),
    db.creditEntry.create({
      data: { workspaceId: ws.id, delta: 2000 - ws.creditBalance, reason: "TOPUP" },
    }),
  ]);
  console.log(`balance: ${ws.creditBalance} -> 2000`);
  await db.$disconnect();
}
main();
