import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import { db } from "./db";
import { repoDir } from "./paths";

/**
 * Git maintenance for a project's repository: branches (the main line and
 * drafts) with stale ones removable, the large files kept in history, and a
 * history clean-up that starts the history again from the current version,
 * removing every deleted or large file from all branches.
 */

export class GitMaintenanceError extends Error {}

const MAIN = "main";

export async function branches(projectId: string) {
  const dir = repoDir(projectId);
  const names = await git.listBranches({ fs, dir });
  const drafts = await db.draft.findMany({ where: { projectId }, select: { branch: true, name: true, status: true } });
  const out = [];
  for (const name of names) {
    const oid = await git.resolveRef({ fs, dir, ref: name });
    const c = await git.readCommit({ fs, dir, oid });
    const d = drafts.find((x) => x.branch === name);
    out.push({
      name,
      draft: d ? { name: d.name, status: d.status } : null,
      lastCommit: { sha: oid, message: c.commit.message.split("\n")[0], at: new Date(c.commit.committer.timestamp * 1000).toISOString(), author: c.commit.author.email },
      // Stale: not main and not a draft someone is still working on.
      stale: name !== MAIN && (!d || d.status === "MERGED" || d.status === "REVERTED"),
    });
  }
  return out;
}

export async function deleteBranch(projectId: string, name: string) {
  const b = (await branches(projectId)).find((x) => x.name === name);
  if (!b) throw new GitMaintenanceError("Branch not found.");
  if (!b.stale) throw new GitMaintenanceError(name === MAIN ? "The main branch can't be deleted." : "That draft is still open. Accept or discard it first.");
  const dir = repoDir(projectId);
  if ((await git.currentBranch({ fs, dir })) === name) throw new GitMaintenanceError("That branch is checked out right now.");
  await git.deleteBranch({ fs, dir, ref: name });
}

/** Files over the size limit anywhere in history (all branches), largest first. */
export async function largeFiles(projectId: string, minBytes = 1024 * 1024) {
  const dir = repoDir(projectId);
  const found = new Map<string, { path: string; bytes: number; inCurrent: boolean }>();
  const current = new Set(await git.listFiles({ fs, dir, ref: MAIN }).catch(() => [] as string[]));
  const seenTrees = new Set<string>();
  async function walk(treeOid: string, prefix: string) {
    if (seenTrees.has(treeOid)) return;
    seenTrees.add(treeOid);
    const { tree } = await git.readTree({ fs, dir, oid: treeOid });
    for (const e of tree) {
      const p = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === "tree") await walk(e.oid, p);
      else if (e.type === "blob" && !found.has(e.oid)) {
        const { blob } = await git.readBlob({ fs, dir, oid: e.oid });
        if (blob.byteLength >= minBytes) found.set(e.oid, { path: p, bytes: blob.byteLength, inCurrent: current.has(p) });
      }
    }
  }
  for (const ref of await git.listBranches({ fs, dir })) {
    for (const c of await git.log({ fs, dir, ref, depth: 300 })) await walk(c.commit.tree, "");
  }
  return [...found.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 100);
}

/**
 * Start history again from the current version of main: one commit with
 * today's files. Old versions, finished drafts, checkpoints and every file
 * not in the current version (deleted or large) are removed for good.
 */
export async function cleanHistory(projectId: string, confirm: string) {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } });
  if (confirm.trim() !== p.name.trim()) throw new GitMaintenanceError("Type the project name to confirm.");
  if (await db.draft.count({ where: { projectId, status: { in: ["BUILDING", "READY", "FAILED"] } } })) {
    throw new GitMaintenanceError("Accept or discard open drafts first: they're built on the history being removed.");
  }
  if (await db.build.count({ where: { projectId, status: { in: ["QUEUED", "RUNNING"] } } })) throw new GitMaintenanceError("Wait for the agent to finish.");
  const dir = repoDir(projectId);
  if ((await git.currentBranch({ fs, dir })) !== MAIN) await git.checkout({ fs, dir, ref: MAIN, force: true });
  const head = await git.resolveRef({ fs, dir, ref: MAIN });
  const before = (await git.log({ fs, dir, ref: MAIN, depth: 10_000 })).length;
  const { commit } = await git.readCommit({ fs, dir, oid: head });
  const now = Math.floor(Date.now() / 1000);
  const who = { name: "Builder", email: "builder@localhost", timestamp: now, timezoneOffset: 0 };
  const oid = await git.writeCommit({
    fs,
    dir,
    commit: { tree: commit.tree, parent: [], author: who, committer: who, message: `History cleaned up: started again from "${commit.message.split("\n")[0]}"\n\nForge-Project: ${projectId}` },
  });
  await git.writeRef({ fs, dir, ref: `refs/heads/${MAIN}`, value: oid, force: true });
  for (const b of await git.listBranches({ fs, dir })) if (b !== MAIN) await git.deleteBranch({ fs, dir, ref: b });
  await db.project.update({ where: { id: projectId }, data: { headSha: oid } });
  const removed = await pruneLooseObjects(dir);
  return { before, after: 1, removedObjects: removed, sha: oid };
}

/** Delete loose objects nothing points at any more (packed objects are left alone). */
async function pruneLooseObjects(dir: string) {
  const keep = new Set<string>();
  async function tree(oid: string) {
    if (keep.has(oid)) return;
    keep.add(oid);
    const { tree: t } = await git.readTree({ fs, dir, oid });
    for (const e of t) {
      if (e.type === "tree") await tree(e.oid);
      else keep.add(e.oid);
    }
  }
  for (const ref of await git.listBranches({ fs, dir })) {
    for (const c of await git.log({ fs, dir, ref, depth: 10_000 })) {
      keep.add(c.oid);
      await tree(c.commit.tree);
    }
  }
  let removed = 0;
  const objects = path.join(dir, ".git", "objects");
  for (const sub of await fs.readdir(objects).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue;
    for (const f of await fs.readdir(path.join(objects, sub))) {
      if (!keep.has(sub + f)) {
        await fs.rm(path.join(objects, sub, f), { force: true });
        removed++;
      }
    }
  }
  return removed;
}
