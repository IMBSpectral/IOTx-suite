import { db } from "./db";
import type { BuildEvent } from "./generate";

/**
 * Build events are written to the database and mirrored to any live listener.
 *
 * The database copy is what makes a build survive a dropped connection: a
 * reconnecting client replays everything after the last `seq` it saw. The
 * in-memory fan-out is only a latency optimisation on top of that, so losing
 * it (a restart, a second server) degrades to polling rather than breaking.
 */

type Listener = (seq: number, event: BuildEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const counters = new Map<string, number>();

export function subscribe(buildId: string, fn: Listener): () => void {
  let set = listeners.get(buildId);
  if (!set) {
    set = new Set();
    listeners.set(buildId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(buildId);
  };
}

export async function emit(buildId: string, event: BuildEvent): Promise<number> {
  const seq = (counters.get(buildId) ?? 0) + 1;
  counters.set(buildId, seq);

  // Text deltas are high-volume and individually worthless on replay; the
  // worker persists the coalesced text instead, so they are fan-out only.
  // Streamed file content is the same: the file itself is the durable copy.
  // The live status line (thought, activity) only matters while it's happening.
  if (event.type !== "text" && event.type !== "file_stream" && event.type !== "thought" && event.type !== "activity") {
    await db.buildEvent.create({
      data: { buildId, seq, type: event.type, payload: event as object },
    });
  }

  for (const fn of listeners.get(buildId) ?? []) {
    try {
      fn(seq, event);
    } catch {
      // A broken listener must never take down the build.
    }
  }
  return seq;
}

/** Everything recorded for a build after `afterSeq`, oldest first. */
export async function replay(buildId: string, afterSeq = 0) {
  const rows = await db.buildEvent.findMany({
    where: { buildId, seq: { gt: afterSeq } },
    orderBy: { seq: "asc" },
  });
  return rows.map((r) => ({ seq: r.seq, event: r.payload as unknown as BuildEvent }));
}

/** Drop in-memory state once a build is finished. */
export function forget(buildId: string) {
  counters.delete(buildId);
  listeners.delete(buildId);
}

/**
 * Clear a build's recorded events before a fresh attempt.
 *
 * A reclaimed build starts over, so its log must start over too: the sequence
 * counter is per-process and restarts at 1, which would otherwise collide
 * with rows left by the attempt that died.
 */
export async function resetEvents(buildId: string) {
  counters.delete(buildId);
  await db.buildEvent.deleteMany({ where: { buildId } });
}
