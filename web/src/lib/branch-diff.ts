import fs from "node:fs";
import git from "isomorphic-git";
import { createTwoFilesPatch } from "diff";
import { db } from "./db";
import { repoDir } from "./paths";

/**
 * What a draft changes: every file added, modified or deleted between the
 * commit the draft started from and the draft's latest commit, with a
 * unified diff per text file.
 */
export type FileDiff = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  /** Unified diff; null for binary or very large files. */
  patch: string | null;
};

const MAX_PATCH_BYTES = 200_000;
const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);

export async function draftDiff(projectId: string, draftId: string): Promise<{ base: string; head: string; files: FileDiff[] }> {
  const draft = await db.draft.findFirst({ where: { id: draftId, projectId } });
  if (!draft) throw new Error("Draft not found.");
  const head = draft.headSha ?? draft.baseSha;
  return diffCommits(projectId, draft.baseSha, head);
}

export async function diffCommits(projectId: string, base: string, head: string) {
  const dir = repoDir(projectId);
  const files: FileDiff[] = [];
  if (base === head) return { base, head, files };
  const changed: { path: string; a: string | null; b: string | null }[] = [];
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: base }), git.TREE({ ref: head })],
    map: async (filepath, [A, B]) => {
      if (filepath === ".") return true;
      const [ta, tb] = [await A?.type(), await B?.type()];
      if (ta === "tree" || tb === "tree") return true;
      const [oa, ob] = [A ? await A.oid() : null, B ? await B.oid() : null];
      if (oa !== ob) changed.push({ path: filepath, a: oa, b: ob });
      return true;
    },
  });
  for (const c of changed.sort((x, y) => x.path.localeCompare(y.path))) {
    const read = async (oid: string | null) => (oid ? (await git.readBlob({ fs, dir, oid })).blob : new Uint8Array());
    const [a, b] = await Promise.all([read(c.a), read(c.b)]);
    const status: FileDiff["status"] = !c.a ? "added" : !c.b ? "deleted" : "modified";
    if (isBinary(a) || isBinary(b) || a.length + b.length > MAX_PATCH_BYTES) {
      files.push({ path: c.path, status, additions: 0, deletions: 0, patch: null });
      continue;
    }
    const before = Buffer.from(a).toString("utf8");
    const after = Buffer.from(b).toString("utf8");
    const patch = createTwoFilesPatch(c.a ? `a/${c.path}` : "/dev/null", c.b ? `b/${c.path}` : "/dev/null", before, after, "", "", { context: 3 });
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    files.push({ path: c.path, status, additions, deletions, patch });
  }
  return { base, head, files };
}
