/** Prints a project's latest build and its last events: npx tsx scripts/_diag-build.mts <projectId> */
import "dotenv/config";
import { db } from "../src/lib/db";

const pid = process.argv[2];
const b = await db.build.findFirst({ where: { projectId: pid }, orderBy: { createdAt: "desc" } });
console.log("build", b?.id, b?.status, b?.error ?? "");
const ev = await db.buildEvent.findMany({ where: { buildId: b!.id }, orderBy: { seq: "asc" } });
console.log("events", ev.length);
for (const e of ev.slice(-40)) console.log(e.seq, JSON.stringify(e.payload).slice(0, 240));
await db.$disconnect();
