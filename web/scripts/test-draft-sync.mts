/**
 * Draft sync, directly against the library (run with the dev server stopped):
 * a draft falls behind when another is accepted, can't be accepted until it
 * is updated, updating merges main in, and same-line edits report a conflict.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import { db } from "../src/lib/db";
import { repoDir } from "../src/lib/paths";
import { destroyRepo } from "../src/lib/repo";
import { createProject } from "../src/lib/create-project";
import { acceptDraft, checkoutDraft, createDraft, draftBehind, syncDraft } from "../src/lib/drafts";

const AUTHOR = { name: "Builder", email: "builder@localhost" };
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function work(pid: string, draftId: string, file: string, content: string) {
  const dir = repoDir(pid);
  await checkoutDraft(pid, draftId);
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), content);
  await git.add({ fs, dir, filepath: file });
  const head = await git.commit({ fs, dir, message: `edit ${file}`, author: AUTHOR });
  return db.draft.update({ where: { id: draftId }, data: { status: "READY", headSha: head } });
}

async function main() {
  const owner = await db.membership.findFirstOrThrow({ where: { role: "OWNER", user: { email: "dev@localhost" } } });
  const project = await createProject({ workspaceId: owner.workspaceId, userId: owner.userId, name: `Draft sync test ${Date.now()}` });
  const pid = project.id;
  try {
    const a = await createDraft(pid, owner.userId, "A");
    const b = await createDraft(pid, owner.userId, "B");
    const ra = await work(pid, a.id, "notes/a.txt", "from A\n");
    const rb = await work(pid, b.id, "notes/b.txt", "from B\n");
    check("fresh drafts not behind", !(await draftBehind(pid, ra)) && !(await draftBehind(pid, rb)));

    await acceptDraft(pid, a.id);
    check("B behind after A accepted", await draftBehind(pid, rb));
    let blocked = "";
    await acceptDraft(pid, b.id).catch((e) => (blocked = e.message));
    check("accept blocked while behind", /catch up with the project/.test(blocked), blocked);

    await checkoutDraft(pid, b.id);
    const synced = await syncDraft(pid, b.id);
    check("B up to date after sync", !(await draftBehind(pid, synced)));
    const dir = repoDir(pid);
    const onDisk = await fs.readFile(path.join(dir, "notes/a.txt"), "utf8").catch(() => "");
    check("synced draft has A's work on disk", onDisk === "from A\n");
    await acceptDraft(pid, b.id);
    const mainSha = await git.resolveRef({ fs, dir, ref: "main" });
    const files = await git.listFiles({ fs, dir, ref: mainSha });
    check("main has both drafts' work", files.includes("notes/a.txt") && files.includes("notes/b.txt"));

    // Conflict: two drafts change the same line.
    const c = await createDraft(pid, owner.userId, "C");
    const d = await createDraft(pid, owner.userId, "D");
    await work(pid, c.id, "notes/shared.txt", "version C\n");
    const rd = await work(pid, d.id, "notes/shared.txt", "version D\n");
    await acceptDraft(pid, c.id);
    let conflict = "";
    await syncDraft(pid, rd.id).catch((e) => (conflict = e.message));
    check("same-line edits reported as conflict", /changed the same lines|Couldn't update/.test(conflict), conflict);
    const after = await db.draft.findUniqueOrThrow({ where: { id: rd.id } });
    check("conflicting draft left as it was", after.headSha === rd.headSha);

    let gone = "";
    await syncDraft(pid, a.id).catch((e) => (gone = e.message));
    check("accepted draft can't be synced", /already accepted or deleted/.test(gone));
  } finally {
    await checkoutDraft(pid, null).catch(() => undefined);
    await db.project.delete({ where: { id: pid } }).catch(() => undefined);
    await destroyRepo(pid).catch(() => undefined);
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
