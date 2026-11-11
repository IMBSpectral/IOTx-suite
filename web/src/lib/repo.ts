import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import { repoDir } from "./paths";

const AUTHOR = { name: "Builder", email: "builder@localhost" };

/** Backslash, kept out of literals so path handling survives shell quoting. */
const WINDOWS_SEP = String.fromCharCode(92);

/** Reject anything that would escape the project root. */
export function safeRelPath(p: string): string {
  const normalized = path.posix
    .normalize(p.split(WINDOWS_SEP).join("/"))
    .replace(/^\/+/, "");
  if (
    normalized === "" ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.split("/").includes("..") ||
    normalized.startsWith(".git/") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe path: ${p}`);
  }
  return normalized;
}

export async function initRepo(projectId: string) {
  const dir = repoDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  await git.init({ fs, dir, defaultBranch: "main" });
  return dir;
}

export async function writeFiles(
  projectId: string,
  files: { path: string; content: string }[],
) {
  const dir = repoDir(projectId);
  for (const f of files) {
    const rel = safeRelPath(f.path);
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content, "utf8");
    await git.add({ fs, dir, filepath: rel });
  }
}

/** Write non-text content such as generated images, and stage it. */
export async function writeBinaryFile(projectId: string, filePath: string, bytes: Buffer) {
  const dir = repoDir(projectId);
  const rel = safeRelPath(filePath);
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  await git.add({ fs, dir, filepath: rel });
  return rel;
}

export async function deleteFile(projectId: string, filePath: string) {
  const dir = repoDir(projectId);
  const rel = safeRelPath(filePath);
  await fs.rm(path.join(dir, rel), { force: true });
  await git.remove({ fs, dir, filepath: rel });
}

/**
 * Commit what's staged. With an author, the version is credited to the
 * member who asked for it, and the project is named in a trailer
 * (commit attribution), so history pushed elsewhere still says where it came from.
 */
export async function commit(projectId: string, message: string, author?: { name: string; email: string } | null): Promise<string> {
  const dir = repoDir(projectId);
  if (!author) return git.commit({ fs, dir, message, author: AUTHOR });
  return git.commit({ fs, dir, message: `${message}

Forge-Project: ${projectId}`, author, committer: AUTHOR });
}

/**
 * Snapshot what's staged as a commit without moving the branch: the agent
 * takes one after each tool call that changes files, so any step of a turn
 * can be restored. The commit stays reachable only through its hash.
 */
export async function checkpoint(projectId: string, message: string): Promise<string> {
  const dir = repoDir(projectId);
  return git.commit({ fs, dir, message, author: AUTHOR, noUpdateBranch: true });
}

/**
 * Make the current branch's working tree exactly match `targetSha`, then
 * commit that as a new commit. Used by undo/redo: history moves forward, it is
 * never rewritten, so an undone change can always be reapplied.
 *
 * Files that exist now but not in the target are deleted explicitly — a
 * checkout onto an older tree is not guaranteed to remove files added since.
 */
export async function restoreTree(projectId: string, targetSha: string, message: string) {
  const dir = repoDir(projectId);
  const [now, target] = await Promise.all([
    git.listFiles({ fs, dir, ref: "HEAD" }),
    git.listFiles({ fs, dir, ref: targetSha }),
  ]);
  const keep = new Set(target);
  await git.checkout({ fs, dir, ref: targetSha, force: true, noUpdateHead: true });
  for (const f of now) {
    if (keep.has(f)) continue;
    await fs.rm(path.join(dir, f), { force: true });
    await git.remove({ fs, dir, filepath: f });
  }
  return git.commit({ fs, dir, message, author: AUTHOR });
}

export async function headSha(projectId: string) {
  return git.resolveRef({ fs, dir: repoDir(projectId), ref: "HEAD" });
}

export async function parentOf(projectId: string, sha: string) {
  const { commit } = await git.readCommit({ fs, dir: repoDir(projectId), oid: sha });
  return commit.parent[0] ?? null;
}

export async function listFiles(projectId: string): Promise<string[]> {
  const dir = repoDir(projectId);
  return git.listFiles({ fs, dir, ref: "HEAD" }).catch(() => [] as string[]);
}

/** Files in a version (a commit), without touching the working tree. */
export async function listFilesAt(projectId: string, ref: string): Promise<string[]> {
  return git.listFiles({ fs, dir: repoDir(projectId), ref }).catch(() => [] as string[]);
}

/** A file's text as it is in a version, without touching the working tree. */
export async function readFileAt(projectId: string, ref: string, filePath: string): Promise<string> {
  const dir = repoDir(projectId);
  const oid = await git.resolveRef({ fs, dir, ref }).catch(() => ref);
  const { blob } = await git.readBlob({ fs, dir, oid, filepath: safeRelPath(filePath) });
  return Buffer.from(blob).toString("utf8");
}

/**
 * Write a version's files into `dest` (a separate folder), leaving the working tree — where
 * the agent is editing and the live preview runs — alone. Builds and checks of the accepted
 * version (main) run there, so they never switch branches under a build in progress.
 */
export async function exportTree(projectId: string, ref: string, dest: string) {
  const dir = repoDir(projectId);
  const oid = await git.resolveRef({ fs, dir, ref }).catch(() => ref);
  const files = await git.listFiles({ fs, dir, ref: oid });
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  await fs.rm(tmp, { recursive: true, force: true });
  for (const f of files) {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: f });
    const abs = path.join(tmp, f);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, blob);
  }
  await fs.rm(dest, { recursive: true, force: true });
  await fs.rename(tmp, dest);
  return files.length;
}

/**
 * Stage every change in the working tree: edits made by commands (scripts, installs) as well
 * as by the agent's file tools. Without this, anything not written through write_file was never
 * committed and vanished at the next checkout. Ignored paths (.gitignore, build output, the
 * agent's scratch folder) are left out.
 *
 * Returns how many files now differ from the last saved version (HEAD), whether they were staged
 * just now or earlier. Callers use it to decide whether there is a version to save, so a change
 * staged earlier in the turn (after each command, by the checkpoint) must still count — counting
 * only files staged by this call left command edits unsaved and the Publish button hidden (Nov 2026).
 */
export async function stageAll(projectId: string) {
  const dir = repoDir(projectId);
  const SKIP = /^(node_modules|\.builds|\.snapshots|tmp|\.cache|dist)(\/|$)/;
  const matrix = await git.statusMatrix({ fs, dir, filter: (f) => !SKIP.test(f) }).catch(() => [] as [string, number, number, number][]);
  let n = 0;
  // statusMatrix: head 0 absent / 1 present; work 0 absent / 1 same as HEAD / 2 changed;
  // stage 0 absent / 1 same as HEAD / 2 same as work / 3 neither.
  for (const [file, head, work, stage] of matrix) {
    if (head === 0 && work === 0) {
      // Added, then deleted before it was saved: nothing to keep.
      if (stage !== 0) await git.remove({ fs, dir, filepath: file });
      continue;
    }
    if (work === 0) {
      if (stage !== 0) await git.remove({ fs, dir, filepath: file });
      n++;
    } else if (work === 1) {
      // Same as the saved version; undo anything staged that no longer applies.
      if (stage !== 1) await git.add({ fs, dir, filepath: file });
    } else {
      if (stage !== 2) await git.add({ fs, dir, filepath: file });
      n++;
    }
  }
  return n;
}

export async function readFile(projectId: string, filePath: string): Promise<string> {
  const rel = safeRelPath(filePath);
  return fs.readFile(path.join(repoDir(projectId), rel), "utf8");
}

export async function history(projectId: string, depth = 50) {
  const dir = repoDir(projectId);
  const log = await git.log({ fs, dir, depth }).catch(() => []);
  return log.map((c) => ({
    sha: c.oid,
    message: c.commit.message.trim(),
    at: new Date(c.commit.author.timestamp * 1000).toISOString(),
  }));
}

/** Revert the working tree to an earlier commit, as a new commit. */
export async function revertTo(projectId: string, sha: string): Promise<string> {
  const dir = repoDir(projectId);
  await git.checkout({ fs, dir, ref: sha, force: true });
  return commit(projectId, `Revert to ${sha.slice(0, 7)}`);
}

/** Remove a project's repository from disk. */
export async function destroyRepo(projectId: string) {
  // Windows refuses to delete a file something still holds open (git, the build container); retry briefly.
  await fs.rm(repoDir(projectId), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

/** Copy a project's working tree into a fresh repo, dropping its history. */
export async function forkRepo(fromId: string, toId: string) {
  const src = repoDir(fromId);
  const dest = repoDir(toId);
  await fs.mkdir(dest, { recursive: true });
  await fs.cp(src, dest, {
    recursive: true,
    // Normalize separators first: on Windows these arrive backslash-delimited.
    filter: (p) => {
      const segments = p.split(WINDOWS_SEP).join("/").split("/");
      return !segments.includes(".git") && !segments.includes(".builds");
    },
  });
  await git.init({ fs, dir: dest, defaultBranch: "main" });
  const files = await fs.readdir(dest, { recursive: true, withFileTypes: true });
  for (const f of files) {
    if (!f.isFile()) continue;
    const rel = path.posix.join(
      path.relative(dest, f.parentPath ?? f.path).split(path.sep).join("/"),
      f.name,
    ).replace(/^\//, "");
    if (rel.startsWith(".git/")) continue;
    await git.add({ fs, dir: dest, filepath: rel });
  }
  return git.commit({ fs, dir: dest, message: "Remixed", author: AUTHOR });
}
