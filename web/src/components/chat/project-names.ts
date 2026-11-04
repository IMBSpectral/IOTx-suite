/**
 * Other projects in the workspace, for @-mentions in the composer. Fetched
 * once per page and shared by the composer (suggestions) and the editor
 * (telling the agent which projects were mentioned).
 */
let cache: Promise<{ id: string; name: string }[]> | null = null;

export function projectNames(exceptId?: string) {
  cache ??= fetch("/api/projects?view=all")
    .then((r) => (r.ok ? r.json() : { projects: [] }))
    .then((d) => ((d.projects ?? d) as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name })))
    .catch(() => []);
  return cache.then((list) => list.filter((p) => p.id !== exceptId));
}

/** Projects named in the text as "@Name". */
export function mentionedProjects(text: string, list: { id: string; name: string }[]) {
  return list.filter((p) => text.includes(`@${p.name}`));
}

/** This project's collections (Files tab), for @-mentions. Not cached: they change while you work. */
export function collectionNames(projectId: string): Promise<string[]> {
  return fetch(`/api/projects/${projectId}/library`)
    .then((r) => (r.ok ? r.json() : { collections: [] }))
    .then((d) => ((d.collections ?? []) as { name: string }[]).map((c) => c.name))
    .catch(() => []);
}

/** The suite sidebar's dashboards and folders this person can see, for @-mentions. */
export function spaceNames(): Promise<string[]> {
  return fetch("/api/spaces")
    .then((r) => (r.ok ? r.json() : { spaces: [] }))
    .then((d) => ((d.spaces ?? []) as { name: string }[]).map((s) => s.name))
    .catch(() => []);
}
