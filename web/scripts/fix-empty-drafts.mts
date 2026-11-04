/** One-off repair: remove drafts that hold no work and are not being built. */
import "dotenv/config";
import { db } from "../src/lib/db";
import { checkoutDraft, currentDraftId } from "../src/lib/drafts";

async function main() {
  const empty = await db.draft.findMany({ where: { headSha: null, status: { in: ["BUILDING", "READY", "FAILED"] } } });
  for (const d of empty) {
    const running = await db.build.count({ where: { draftId: d.id, status: { in: ["RUNNING", "QUEUED"] } } });
    if (running) continue;
    if ((await currentDraftId(d.projectId)) === d.id) await checkoutDraft(d.projectId, null);
    await db.draft.delete({ where: { id: d.id } });
    console.log(`removed empty draft "${d.name.slice(0, 40)}"`);
  }
  console.log(`checked ${empty.length}`);
  await db.$disconnect();
}
main().catch(async (e) => {
  console.error("FAILED:", e.message);
  await db.$disconnect();
  process.exit(1);
});
