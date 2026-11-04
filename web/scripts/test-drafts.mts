import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import { db } from "../src/lib/db";
import { repoDir } from "../src/lib/paths";
import {
  createDraft, acceptDraft, revertDraft, listDrafts,
  acceptBlockedReason, revertBlockedReason, checkoutDraft,
} from "../src/lib/drafts";

const PID = "d2f83ba4-7130-45f6-846a-ba7432fcefa2"; // throwaway smoke-test project
const USER = "cmvgrps720000q8vwd902e6po";

async function readMain(file: string) {
  const dir = repoDir(PID);
  const sha = await git.resolveRef({ fs, dir, ref: "main" });
  const { blob } = await git.readBlob({ fs, dir, oid: sha, filepath: file });
  return Buffer.from(blob).toString("utf8");
}

async function main() {
  const started = new Date();
  const dir = repoDir(PID);
  await git.checkout({ fs, dir, ref: "main", force: true }).catch(() => {});
  const before = await readMain("src/App.tsx");
  console.log("main App.tsx length before:", before.length);

  // 1. open a draft
  const draft = await createDraft(PID, USER, "Add a banner");
  console.log("1. created draft:", draft.name, "| branch:", draft.branch);
  console.log("   accept blocked (expected, BUILDING):", acceptBlockedReason(draft));

  // 2. the agent writes into the draft branch
  const marker = "\n// DRAFT_MARKER_" + Date.now() + "\n";
  await fs.writeFile(path.join(dir, "src/App.tsx"), before + marker, "utf8");
  await git.add({ fs, dir, filepath: "src/App.tsx" });
  const head = await git.commit({ fs, dir, message: "draft work",
    author: { name: "Builder", email: "builder@localhost" } });
  const ready = await db.draft.update({
    where: { id: draft.id }, data: { status: "READY", headSha: head } });
  console.log("2. committed to draft:", head.slice(0, 8));
  console.log("   accept blocked now:", acceptBlockedReason(ready) ?? "no — acceptable");

  // 3. main must be untouched while the draft is open
  const during = await readMain("src/App.tsx");
  console.log("3. main unchanged while draft open:", during === before);

  // 4. accept
  const merged = await acceptDraft(PID, draft.id);
  const after = await readMain("src/App.tsx");
  // The commit is not enough: the preview serves the working tree.
  const onDisk = await fs.readFile(path.join(dir, "src/App.tsx"), "utf8");
  console.log("4. accepted. merge:", merged.mergeSha?.slice(0, 8),
              "| main commit has marker:", after.includes("DRAFT_MARKER"),
              "| disk has marker:", onDisk.includes("DRAFT_MARKER"));

  // 5. revert
  const why = await revertBlockedReason(PID, draft.id);
  console.log("5. revert blocked?", why ?? "no");
  if (!why) {
    await revertDraft(PID, draft.id);
    const reverted = await readMain("src/App.tsx");
    const revertedDisk = await fs.readFile(path.join(dir, "src/App.tsx"), "utf8");
    console.log("   reverted. commit restored:", reverted === before,
                "| disk restored:", revertedDisk === before);
  }

  // 6. ordering guard: an older accepted draft cannot be reverted while a
  // newer one sits on top of it. The guard is pure bookkeeping, so the two
  // accepted drafts are recorded directly rather than built.
  await checkoutDraft(PID, null);
  const older = await createDraft(PID, USER, "Older accepted");
  await checkoutDraft(PID, null);
  const newer = await createDraft(PID, USER, "Newer accepted");
  const t = Date.now();
  await db.draft.update({ where: { id: older.id }, data: { status: "MERGED",
    mergedAt: new Date(t - 60_000), mergeSha: "aaaa1111", headSha: "aaaa1111" } });
  await db.draft.update({ where: { id: newer.id }, data: { status: "MERGED",
    mergedAt: new Date(t), mergeSha: "bbbb2222", headSha: "bbbb2222" } });
  console.log("6. revert older while newer accepted:", await revertBlockedReason(PID, older.id));
  console.log("   revert newest:", (await revertBlockedReason(PID, newer.id)) ?? "allowed");

  // Only the drafts this run opened; the project may have real ones.
  await db.draft.deleteMany({ where: { projectId: PID, createdAt: { gte: started } } });
  await checkoutDraft(PID, null);
  await db.$disconnect();
}
main().catch(async (e) => { console.error("FAILED:", e.message); await db.$disconnect(); process.exit(1); });
