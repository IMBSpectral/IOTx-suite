import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const b = await db.build.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, projectId: true, attempts: true },
  });
  for (const x of b) console.log(`${x.id} ${x.status} attempts=${x.attempts} project=${x.projectId}`);
  await db.$disconnect();
}
main();
