import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const pid = "81926f00-40ed-454b-a89d-6c0a7b6c6b4f";

  const builds = await db.build.findMany({
    where: { projectId: pid },
    orderBy: { createdAt: "asc" },
  });

  // Keep the first attempt, drop the duplicate the user sent when it hung.
  const [keep, ...dupes] = builds;
  for (const d of dupes) {
    await db.build.update({
      where: { id: d.id },
      data: { status: "CANCELLED", endedAt: new Date(), error: "Duplicate request" },
    });
    console.log("cancelled duplicate:", d.id);
  }

  await db.buildEvent.deleteMany({ where: { buildId: keep.id } });
  await db.build.update({
    where: { id: keep.id },
    data: { status: "QUEUED", attempts: 0, heartbeatAt: null, error: null, endedAt: null },
  });
  console.log("requeued:", keep.id);
  await db.$disconnect();
}
main();
