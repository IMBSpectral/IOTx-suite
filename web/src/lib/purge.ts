import fs from "node:fs/promises";
import path from "node:path";
import { destroyRepo } from "./repo";
import { destroyCloud } from "./cloud";
import { destroySandbox } from "./sandbox";
import { stopFunctions } from "./cloud-functions";
import { PROJECTS_ROOT } from "./paths";

/**
 * Remove everything a project keeps on disk: its repository and the side
 * stores beside it (backend, uploads, library, quick-edit undo, marketing).
 * Best effort: the rows are already gone, and an orphaned file is harmless.
 */
export async function purgeProjectData(projectId: string) {
  // The container mounts the project folder, so it goes first or the folder can't be deleted.
  await destroySandbox(projectId).catch(() => undefined);
  await destroyRepo(projectId).catch(() => undefined);
  await stopFunctions(projectId).catch(() => undefined);
  await destroyCloud(projectId).catch(() => undefined);
  const extras = [["_uploads", projectId], ["_library", `${projectId}.json`], ["_quick", `${projectId}.json`], ["_marketing", `${projectId}.json`], ["_notes", `${projectId}.md`], ["_variants", `${projectId}.json`], ["_visuals", projectId]];
  for (const extra of extras) {
    await fs.rm(path.join(PROJECTS_ROOT, ...extra), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => undefined);
  }
}
