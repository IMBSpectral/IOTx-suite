import "dotenv/config";
import { db } from "../src/lib/db";

const PID = process.argv[2] ?? "d2f83ba4-7130-45f6-846a-ba7432fcefa2";

async function main() {
  const builds = await db.build.findMany({
    where: { projectId: PID },
    orderBy: { createdAt: "desc" },
    take: 4,
  });
  for (const b of builds) {
    console.log(
      `${b.id.slice(-6)} ${b.status.padEnd(9)} mode=${b.mode.padEnd(6)} cancelRequested=${b.cancelRequested} ` +
        `tokens=${b.inputTokens}/${b.outputTokens} credits=${b.creditsUsed} sha=${b.sha?.slice(0, 8) ?? "-"} ` +
        `heartbeat=${b.heartbeatAt?.toISOString().slice(11, 19) ?? "-"}`,
    );
  }
  const drafts = await db.draft.findMany({ where: { projectId: PID } });
  for (const d of drafts) console.log(`draft ${d.status} head=${d.headSha?.slice(0, 8) ?? "-"} "${d.name.slice(0, 40)}"`);
  await db.$disconnect();
}
main().catch(async (e) => {
  console.error("FAILED:", e.message);
  await db.$disconnect();
  process.exit(1);
});
