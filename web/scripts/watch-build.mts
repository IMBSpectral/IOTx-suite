import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  const id = process.argv[2];
  const deadline = Date.now() + 150_000;
  let last = "";
  while (Date.now() < deadline) {
    const b = await db.build.findUnique({ where: { id } });
    if (!b) break;
    if (b.status !== last) {
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${b.status}`);
      last = b.status;
    }
    if (b.status === "SUCCEEDED" || b.status === "FAILED") {
      const evs = await db.buildEvent.findMany({
        where: { buildId: id }, orderBy: { seq: "asc" },
      });
      console.log("events:", evs.map((e) => e.type).join(" -> "));
      console.log("tokens:", b.inputTokens, "/", b.outputTokens, "credits:", b.creditsUsed);
      console.log("error:", b.error ?? "none");
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await db.$disconnect();
}
main();
