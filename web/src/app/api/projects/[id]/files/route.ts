import { requireProjectPerm } from "@/lib/iotx/permissions";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { listFiles, readFile, writeFiles, commit, safeRelPath } from "@/lib/repo";
import { currentDraftId } from "@/lib/drafts";
import { route } from "@/lib/route";
import git from "isomorphic-git";
import fs from "node:fs";
import { repoDir } from "@/lib/paths";

/**
 * Save a hand edit from the code editor. It lands wherever the working tree
 * is — the open draft, or main — as its own commit, so it shows in history
 * and can be undone like any agent edit.
 */
async function PUT_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.code.edit");

  const busy = await db.build.count({ where: { projectId: id, status: "RUNNING" } });
  if (busy > 0) {
    return NextResponse.json({ error: "Wait for the agent to finish first." }, { status: 409 });
  }

  const { path, content } = (await req.json().catch(() => ({}))) as { path?: string; content?: string };
  if (typeof path !== "string" || typeof content !== "string") {
    return NextResponse.json({ error: "path and content are required" }, { status: 400 });
  }
  let rel: string;
  try {
    rel = safeRelPath(path);
  } catch {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  if (content.length > 2_000_000) {
    return NextResponse.json({ error: "File is too large to edit here" }, { status: 413 });
  }

  await writeFiles(id, [{ path: rel, content }]);
  const sha = await commit(id, `Edit ${rel}`);
  const draftId = await currentDraftId(id);
  if (draftId) await db.draft.update({ where: { id: draftId }, data: { headSha: sha } });
  else await db.project.update({ where: { id }, data: { headSha: sha } });
  return NextResponse.json({ ok: true, sha });
}

async function GET_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  if (new URL(req.url).searchParams.get("path")) await requireProjectPerm(user.id, id, "builder.code.view");

  const url = new URL(req.url);
  const file = url.searchParams.get("path");

  // ?before=<sha>: the file as it was before that version (its parent), for
  // the Code tab's diff of what the last build changed. null when it was new.
  const before = url.searchParams.get("before");
  if (file && before) {
    if (!/^[0-9a-f]{40}$/.test(before)) return NextResponse.json({ error: "Unknown version" }, { status: 400 });
    let rel: string;
    try {
      rel = safeRelPath(file);
    } catch {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }
    const dir = repoDir(id);
    try {
      const { commit: c } = await git.readCommit({ fs, dir, oid: before });
      const parent = c.parent[0];
      if (!parent) return NextResponse.json({ path: rel, content: null });
      const { blob } = await git.readBlob({ fs, dir, oid: parent, filepath: rel }).catch(() => ({ blob: null }));
      if (blob && blob.length > 2_000_000) return NextResponse.json({ error: "Too large to compare" }, { status: 413 });
      return NextResponse.json({ path: rel, content: blob ? Buffer.from(blob).toString("utf8") : null });
    } catch {
      return NextResponse.json({ error: "Unknown version" }, { status: 404 });
    }
  }

  if (file) {
    try {
      return NextResponse.json({ path: file, content: await readFile(id, file) });
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }
  return NextResponse.json({ files: await listFiles(id) });
}

export const GET = route(GET_);
export const PUT = route(PUT_);
