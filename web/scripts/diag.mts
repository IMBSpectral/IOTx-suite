import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const p = await db.project.findFirst({
    where: { name: { contains: "manufacturing" } },
    orderBy: { createdAt: "desc" },
  });
  console.log("project:", p?.id, "|", p?.name?.slice(0, 40));
  if (!p) return;
  const msgs = await db.message.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } });
  console.log("messages:", msgs.length);
  for (const m of msgs) console.log(`  ${m.role} mode=${m.mode} len=${m.content.length} at=${m.createdAt.toISOString().slice(11,19)}`);
  const builds = await db.build.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } });
  console.log("builds:", builds.length);
  for (const b of builds) {
    console.log(`  ${b.status} mode=${b.mode} started=${b.startedAt?.toISOString().slice(11,19) ?? "-"} ended=${b.endedAt?.toISOString().slice(11,19) ?? "-"} err=${(b.error ?? "none").slice(0,120)}`);
    const ev = await db.buildEvent.findMany({ where: { buildId: b.id }, orderBy: { seq: "asc" } });
    console.log(`    events(${ev.length}):`, ev.map(e => e.type).join(" -> ") || "(none)");
  }
  await db.$disconnect();
}
main();
