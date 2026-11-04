import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { versionBuilt } from "@/lib/publish";
import { createVersionView, versionUrl } from "@/lib/version-views";
import git from "isomorphic-git";
import fs from "node:fs/promises";
import { repoDir } from "@/lib/paths";

type Ctx = { params: Promise<{ id: string }> };

/** A link to look at one past version of the app. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const { sha } = (await req.json().catch(() => ({}))) as { sha?: string };
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return Response.json({ error: "Unknown version" }, { status: 400 });
  try {
    await git.readCommit({ fs, dir: repoDir(id), oid: sha });
  } catch {
    return Response.json({ error: "Unknown version" }, { status: 404 });
  }
  const token = await createVersionView(id, sha);
  return Response.json({ url: versionUrl(token), built: await versionBuilt(id, sha) });
}

export const POST = route(POST_);
