import path from "node:path";

/**
 * Every project is a real git repository on disk. Keeping the location in one
 * place means the repo layer, the bundler and the publisher cannot disagree
 * about where a project lives.
 */
// Resolved to an absolute path: esbuild rejects a relative absWorkingDir,
// and a relative root would otherwise follow the process's cwd around.
const ROOT = path.resolve(
  process.env.PROJECTS_ROOT ?? path.join(process.cwd(), ".projects"),
);

export function repoDir(projectId: string) {
  // projectId is a server-generated uuid, never user input.
  return path.join(ROOT, projectId);
}

export function buildDir(projectId: string, sha: string) {
  return path.join(ROOT, projectId, ".builds", sha);
}

export { ROOT as PROJECTS_ROOT };
