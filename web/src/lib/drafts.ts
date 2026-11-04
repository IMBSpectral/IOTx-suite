import fs from "node:fs/promises";
import git from "isomorphic-git";
import { db } from "./db";
import { repoDir } from "./paths";
import { removeDraftDatabase } from "./cloud";
import { deployIfChanged } from "./cloud-functions";

/**
 * Drafts: proposed changes held on their own branch until accepted.
 *
 * The agent never writes to the project's main line. It writes into a draft,
 * which the user reviews and then accepts or discards. Several drafts can be
 * open at once on the same project, so each one records the commit it forked
 * from and, once accepted, the merge commit — reverting needs the merge, not
 * the diff.
 */

const AUTHOR = { name: "Builder", email: "builder@localhost" };
const MAIN = "main";

export type DraftStatus = "BUILDING" | "READY" | "MERGED" | "REVERTED" | "FAILED";

function branchName(id: string) {
  return `draft/${id}`;
}

async function headOf(dir: string, ref: string): Promise<string | null> {
  return git.resolveRef({ fs, dir, ref }).catch(() => null);
}

/** Open a new draft branched from the project's current main. */
export async function createDraft(
  projectId: string,
  authorId: string,
  name: string,
) {
  const dir = repoDir(projectId);
  const base = await headOf(dir, MAIN);
  if (!base) throw new Error("Project has no commits to branch from");

  const draft = await db.draft.create({
    data: {
      projectId,
      authorId,
      name: name.trim().slice(0, 80) || "Untitled draft",
      branch: "pending",
      baseSha: base,
      status: "BUILDING",
      seenBy: [authorId],
    },
  });

  const branch = branchName(draft.id);
  await git.branch({ fs, dir, ref: branch, object: base, checkout: true });

  return db.draft.update({
    where: { id: draft.id },
    data: { branch },
  });
}

/** Point the working tree at a draft so previews and reads reflect it. */
export async function checkoutDraft(projectId: string, draftId: string | null) {
  const dir = repoDir(projectId);
  const ref = draftId ? branchName(draftId) : MAIN;
  await git.checkout({ fs, dir, ref, force: true });
  return ref;
}

/** The draft the working tree is on, or null when it is on main. */
export async function currentDraftId(projectId: string): Promise<string | null> {
  const ref = await git
    .currentBranch({ fs, dir: repoDir(projectId), fullname: false })
    .catch(() => null);
  return ref && ref.startsWith("draft/") ? ref.slice("draft/".length) : null;
}

export async function listDrafts(projectId: string) {
  return db.draft.findMany({
    // FAILED stays visible: a build that dies part-way still holds real work,
    // and the user needs it in the list to retry or discard it.
    where: { projectId, status: { in: ["BUILDING", "READY", "FAILED", "MERGED"] } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
}

/**
 * Why accepting is blocked, or null when it is allowed.
 * Kept as a reason rather than a boolean so the UI can explain itself.
 */
export function acceptBlockedReason(d: {
  status: string;
  headSha: string | null;
}): string | null {
  if (d.status === "BUILDING") return "This draft is still building.";
  if (d.status === "FAILED") return "This draft failed to build.";
  if (d.status === "MERGED") return "This draft has already been accepted.";
  if (d.status === "REVERTED") return "This draft was reverted.";
  if (!d.headSha) return "This draft has no changes yet.";
  return null;
}

/** Why a merged draft cannot be reverted, or null when it can. */
export async function revertBlockedReason(projectId: string, draftId: string) {
  const d = await db.draft.findUnique({ where: { id: draftId } });
  if (!d) return "Draft not found.";
  if (d.status !== "MERGED") return "Only accepted drafts can be reverted.";
  if (!d.mergeSha) return "No merge commit was recorded for this draft.";

  // Anything merged after this draft may depend on it, so reverting out of
  // order would silently undo later work.
  const newer = await db.draft.count({
    where: {
      projectId,
      status: "MERGED",
      mergedAt: { gt: d.mergedAt ?? new Date(0) },
    },
  });
  if (newer > 0) {
    return `${newer} later draft${newer > 1 ? "s were" : " was"} accepted after this one.`;
  }
  return null;
}

/**
 * Whether main has moved on since this draft last caught up: another draft
 * was accepted, or a version was restored. A draft whose branch already
 * contains main's head is up to date.
 */
export async function draftBehind(projectId: string, d: { branch: string; status: string }) {
  if (d.status === "MERGED" || d.status === "REVERTED") return false;
  const dir = repoDir(projectId);
  const [main, head] = await Promise.all([headOf(dir, MAIN), headOf(dir, d.branch)]);
  if (!main || !head || main === head) return false;
  const contains = await git.isDescendent({ fs, dir, oid: head, ancestor: main, depth: -1 }).catch(() => false);
  return !contains;
}

/**
 * Bring a draft up to date: merge main into its branch so it can be
 * accepted. A conflict leaves the draft as it was and says so.
 */
export async function syncDraft(projectId: string, draftId: string) {
  const draft = await db.draft.findUniqueOrThrow({ where: { id: draftId } });
  if (draft.status === "MERGED" || draft.status === "REVERTED") throw new Error("This draft is already accepted or deleted.");
  if (draft.status === "BUILDING") throw new Error("Wait for the draft to finish building.");
  const dir = repoDir(projectId);
  const viewing = (await currentDraftId(projectId)) === draftId;
  let oid: string | undefined;
  try {
    const r = await git.merge({
      fs,
      dir,
      ours: draft.branch,
      theirs: MAIN,
      author: AUTHOR,
      message: `Update draft "${draft.name}" with the latest project changes`,
    });
    oid = r.oid;
  } catch (e) {
    const conflict = e instanceof Error && /conflict/i.test(e.name + e.message);
    throw new Error(
      conflict
        ? "This draft and the project changed the same lines. Ask the agent to redo the draft's change on the latest version."
        : `Couldn't update the draft: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // As with accept, merge moves refs only; refresh the files the preview serves.
  if (viewing) await git.checkout({ fs, dir, ref: draft.branch, force: true });
  return db.draft.update({
    where: { id: draftId },
    data: { headSha: oid ?? (await headOf(dir, draft.branch)) ?? draft.headSha },
  });
}

/** Accept a draft: merge its branch into main and record the merge commit. */
export async function acceptDraft(projectId: string, draftId: string) {
  const draft = await db.draft.findUniqueOrThrow({ where: { id: draftId } });
  const blocked = acceptBlockedReason(draft);
  if (blocked) throw new Error(blocked);
  if (await draftBehind(projectId, draft)) {
    throw new Error("Update the draft to catch up with the project before accepting.");
  }

  const dir = repoDir(projectId);

  // Merge by ref while the working tree is still on the draft. Checking out
  // main first would delete the draft's new files from disk mid-accept, and
  // the live preview would hot-reload against files that no longer exist.
  const result = await git.merge({
    fs,
    dir,
    ours: MAIN,
    theirs: draft.branch,
    author: AUTHOR,
    message: `Accept draft: ${draft.name}`,
  });

  // isomorphic-git's merge moves refs only and never writes the working
  // tree, so main is checked out afterwards; otherwise the files on disk —
  // which the preview serves — lag behind the commit main now points at.
  await git.checkout({ fs, dir, ref: MAIN, force: true });

  const mergeSha =
    result.oid ?? (await headOf(dir, MAIN)) ?? draft.headSha ?? draft.baseSha;

  const [updated] = await db.$transaction([
    db.draft.update({
      where: { id: draftId },
      data: { status: "MERGED", mergedAt: new Date(), mergeSha },
    }),
    db.project.update({
      where: { id: projectId },
      data: { headSha: mergeSha, updatedAt: new Date() },
    }),
  ]);
  // The draft's test data never reaches the live app.
  if (draft.ownBackend) await removeDraftDatabase(projectId, draftId);
  // The draft's server functions go live with it.
  await deployIfChanged(projectId).catch(() => undefined);

  return updated;
}

/** Revert an accepted draft by undoing its merge commit on main. */
export async function revertDraft(projectId: string, draftId: string) {
  const blocked = await revertBlockedReason(projectId, draftId);
  if (blocked) throw new Error(blocked);

  const draft = await db.draft.findUniqueOrThrow({ where: { id: draftId } });
  const dir = repoDir(projectId);
  await git.checkout({ fs, dir, ref: MAIN, force: true });

  // isomorphic-git has no revert, so the pre-merge tree is restored directly
  // and committed forward. History is preserved rather than rewritten.
  await git.checkout({ fs, dir, ref: draft.baseSha, force: true, noUpdateHead: true });
  const sha = await git.commit({
    fs,
    dir,
    message: `Revert draft: ${draft.name}`,
    author: AUTHOR,
  });

  const [updated] = await db.$transaction([
    db.draft.update({
      where: { id: draftId },
      data: { status: "REVERTED", revertedAt: new Date() },
    }),
    db.project.update({
      where: { id: projectId },
      data: { headSha: sha, updatedAt: new Date() },
    }),
  ]);

  return updated;
}

/**
 * Throw away a draft that was never accepted. Main is untouched by definition,
 * so this only retires the draft and points the working tree back at main.
 * The branch is kept, so the work stays recoverable from git.
 */
export async function discardDraft(projectId: string, draftId: string) {
  const d = await db.draft.findUniqueOrThrow({ where: { id: draftId } });
  if (d.status === "MERGED") {
    throw new Error("This draft was accepted — revert it instead.");
  }
  if (d.status === "BUILDING") {
    throw new Error("Wait for this draft to finish building before discarding it.");
  }
  await checkoutDraft(projectId, null);
  if (d.ownBackend) await removeDraftDatabase(projectId, draftId);
  return db.draft.update({
    where: { id: draftId },
    data: { status: "REVERTED", revertedAt: new Date(), ownBackend: false },
  });
}

export async function renameDraft(draftId: string, name: string) {
  return db.draft.update({
    where: { id: draftId },
    data: { name: name.trim().slice(0, 80) || "Untitled draft" },
  });
}

/** Mark a draft as seen so arrival badges clear per user. */
export async function markDraftSeen(draftId: string, userId: string) {
  const d = await db.draft.findUnique({ where: { id: draftId } });
  if (!d || d.seenBy.includes(userId)) return d;
  return db.draft.update({
    where: { id: draftId },
    data: { seenBy: { push: userId } },
  });
}
