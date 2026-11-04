/**
 * Recent runtime logs from each project's preview, as reported by the
 * editor. They come from whoever has the preview open — the same model
 * Lovable uses, where the agent reads what the user's preview recorded.
 *
 * Held on globalThis: Next compiles route handlers into separate bundles, and
 * a plain module-level map would give the route that writes logs and the
 * worker that reads them two different stores.
 */

export type RuntimeLog = {
  level: "error" | "warn";
  kind: "runtime" | "console" | "network" | "resource";
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  url?: string;
  at: number;
  /** Consecutive identical entries collapse into one with a count. */
  count: number;
};

const MAX_PER_PROJECT = 200;

const holder = globalThis as { __forgeRuntimeLogs?: Map<string, RuntimeLog[]> };
const store: Map<string, RuntimeLog[]> = (holder.__forgeRuntimeLogs ??= new Map());

export function appendLogs(projectId: string, entries: Omit<RuntimeLog, "count">[]) {
  const list = store.get(projectId) ?? [];
  for (const e of entries) {
    const last = list[list.length - 1];
    if (last && last.message === e.message && last.kind === e.kind) {
      last.count++;
      last.at = e.at;
      continue;
    }
    list.push({ ...e, count: 1 });
  }
  store.set(projectId, list.slice(-MAX_PER_PROJECT));
}

export function readLogs(
  projectId: string,
  opts: { kinds?: RuntimeLog["kind"][]; since?: number; limit?: number } = {},
): RuntimeLog[] {
  return (store.get(projectId) ?? [])
    .filter((l) => (!opts.kinds || opts.kinds.includes(l.kind)) && (!opts.since || l.at >= opts.since))
    .slice(-(opts.limit ?? 50));
}

/** Forget a project's logs, e.g. once the errors they describe are fixed. */
export function clearLogs(projectId: string) {
  store.delete(projectId);
}

/** A readable digest for the agent, newest last. */
export function formatLogs(logs: RuntimeLog[], now = Date.now()): string {
  if (logs.length === 0) return "No errors, warnings or failed requests have been recorded in the preview.";
  return logs
    .map((l) => {
      const age = Math.max(0, Math.round((now - l.at) / 1000));
      const head = `[${l.level} · ${l.kind} · ${age}s ago${l.count > 1 ? ` · ×${l.count}` : ""}${l.url ? ` · ${l.url}` : ""}] ${l.message}`;
      return l.stack ? `${head}\n${l.stack.split("\n").slice(0, 6).join("\n")}` : head;
    })
    .join("\n\n");
}
