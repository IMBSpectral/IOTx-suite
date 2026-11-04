/** Where a build's time went: npx tsx scripts/_diag-timeline.mts <projectId> */
import "dotenv/config";
import { db } from "../src/lib/db";
const b = await db.build.findFirst({ where: { projectId: process.argv[2] }, orderBy: { createdAt: "desc" } });
const ev = await db.buildEvent.findMany({ where: { buildId: b!.id }, orderBy: { seq: "asc" } });
const t0 = b!.createdAt.getTime();
let prev = t0;
for (const e of ev) {
  const p = e.payload as any;
  const at = e.at.getTime();
  const label = p.type === "tool" ? String(p.step).slice(0, 90) : p.type === "thinking" ? "thinking" : `${p.type}${p.type === "usage" ? ` in=${p.inputTokens} out=${p.outputTokens}` : ""}${p.durationMs ? ` total=${Math.round(p.durationMs / 1000)}s` : ""}`;
  console.log(`${String(Math.round((at - t0) / 1000)).padStart(5)}s  +${String(Math.round((at - prev) / 1000)).padStart(4)}s  ${label}`);
  prev = at;
}
await db.$disconnect();
