import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CloudError, cloudDbFile, cloudDir, cloudEngine, getCloud, openDatabase, pgTarget, updateCloud, type CloudConfig } from "./cloud";
import { withSqlite, type CloudDb } from "./cloud-db";
import { cloneDatabase, pgBackupName } from "./cloud-pg";
import { hasLive, liveId } from "./cloud-envs";

/**
 * Changes to the live app's data (the database the published site uses), asked for by the
 * Builder agent and approved by a person: clear test data before launch, fix a wrong record,
 * delete rows someone asked to remove.
 *
 * Only row changes (INSERT / UPDATE / DELETE) on the app's own tables; never the schema (that's
 * a migration), sign-in accounts or the platform's own tables. Proposing rehearses the change on
 * Live and rolls it back, so the approval card shows how many rows each statement touches.
 * Approving backs Live up first (kept apart from the Test backups in the Cloud tab), then runs
 * every statement in one transaction: all or nothing.
 */

export type LiveChange = {
  id: string;
  description: string;
  sql: string;
  statements: { sql: string; rows: number }[];
  status: "pending" | "applied" | "rejected" | "failed";
  requestedAt: string;
  requestedBy: string | null;
  decidedAt?: string;
  decidedBy?: string | null;
  backup?: string;
  error?: string;
};

type WithChanges = CloudConfig & { liveChanges?: LiveChange[] };

/** Statements of a script, split on semicolons outside quotes and comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) {
      cur += c;
      if (c === q) {
        if (sql[i + 1] === q) cur += sql[++i];
        else q = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const PROTECTED = /(^|[^\w])("?)(_forge_\w*|auth_users|sqlite_\w*|pg_catalog|information_schema)\2([^\w]|$)/i;
const FORBIDDEN = /\b(attach|detach|pragma|vacuum|create|drop|alter|truncate|grant|revoke|copy|begin|commit|rollback|savepoint|reindex|analyze)\b/i;

/** Why a statement can't be a live data change, or null when it can. */
function refuse(stmt: string): string | null {
  const s = stmt.replace(/'(?:[^']|'')*'/g, "''");
  if (!/^\s*(with\b[\s\S]+?\)\s*)?(insert|update|delete)\b/i.test(s)) return "Only INSERT, UPDATE and DELETE are allowed here; table changes go through a migration.";
  if (FORBIDDEN.test(s)) return "Only row changes are allowed here (no table, index or transaction commands).";
  if (PROTECTED.test(s)) return "Sign-in accounts and the platform's own tables can't be changed here.";
  return null;
}

async function live(projectId: string): Promise<CloudDb> {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError("This app has no backend.", 409);
  if (!(await hasLive(projectId))) throw new CloudError("The app hasn't been published yet, so there's no live data. Change the preview's data instead.", 409);
  return openDatabase(liveId(projectId));
}

class Rehearsal extends Error {}

/** Run the statements on Live in one transaction and roll back: rows each would change. */
async function rehearse(projectId: string, statements: string[]) {
  const db = await live(projectId);
  const counts: number[] = [];
  try {
    await db.transaction(async (tx) => {
      for (const s of statements) counts.push((await tx.run(s)).changes);
      throw new Rehearsal();
    });
  } catch (e) {
    if (!(e instanceof Rehearsal)) throw new CloudError(`The change doesn't run on the live data: ${e instanceof Error ? e.message : String(e)}`, 400);
  }
  return counts;
}

/** Propose a change to the live data: checked and rehearsed, then waiting for approval. */
export async function proposeLiveChange(projectId: string, description: string, sql: string, requestedBy: string | null) {
  const statements = splitStatements(sql);
  if (!statements.length) throw new CloudError("No SQL to run.");
  if (statements.length > 50) throw new CloudError("At most 50 statements in one change.");
  for (const s of statements) {
    const why = refuse(s);
    if (why) throw new CloudError(`${why} (${s.slice(0, 80)})`);
  }
  const counts = await rehearse(projectId, statements);
  const change: LiveChange = {
    id: crypto.randomUUID().slice(0, 12),
    description: description.trim().slice(0, 300) || "Change the live data",
    sql: statements.join(";\n") + ";",
    statements: statements.map((s, i) => ({ sql: s, rows: counts[i] ?? 0 })),
    status: "pending",
    requestedAt: new Date().toISOString(),
    requestedBy,
  };
  await updateCloud(projectId, (c) => {
    const w = c as WithChanges;
    w.liveChanges = [...(w.liveChanges ?? []), change].slice(-30);
  });
  return change;
}

export async function liveChanges(projectId: string): Promise<LiveChange[]> {
  return ((await getCloud(projectId)) as WithChanges | null)?.liveChanges ?? [];
}

const liveBackupDir = (projectId: string) => path.join(cloudDir(projectId), "backups-live");

/** A copy of Live as it is now, kept apart from the Test backups (never offered as a Test restore). */
async function backupLive(projectId: string, label: string) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
  await fs.mkdir(liveBackupDir(projectId), { recursive: true });
  if ((await cloudEngine(projectId)) === "postgres") {
    const t = await pgTarget(liveId(projectId));
    const database = pgBackupName(projectId, `${projectId}:live:${id}`);
    await cloneDatabase(t.database, database, t.user);
    await fs.writeFile(path.join(liveBackupDir(projectId), `${id}.pgbackup.json`), JSON.stringify({ database, from: liveId(projectId), at: new Date().toISOString() }, null, 2));
  } else {
    await withSqlite(cloudDbFile(liveId(projectId)), (h) => h.prepare("VACUUM INTO ?").run(path.join(liveBackupDir(projectId), `${id}.sqlite`)));
  }
  return id;
}

async function setChange(projectId: string, id: string, patch: Partial<LiveChange>) {
  await updateCloud(projectId, (c) => {
    const w = c as WithChanges;
    w.liveChanges = (w.liveChanges ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x));
  });
}

/** Approve: back Live up, then run the change in one transaction. */
export async function applyLiveChange(projectId: string, id: string, by: string | null) {
  const ch = (await liveChanges(projectId)).find((x) => x.id === id);
  if (!ch) throw new CloudError("That change doesn't exist.", 404);
  if (ch.status !== "pending") throw new CloudError(`That change was already ${ch.status}.`, 409);
  const db = await live(projectId);
  const backup = await backupLive(projectId, "before-change");
  try {
    const applied: number[] = [];
    await db.transaction(async (tx) => {
      for (const s of ch.statements) applied.push((await tx.run(s.sql)).changes);
    });
    await setChange(projectId, id, {
      status: "applied",
      decidedAt: new Date().toISOString(),
      decidedBy: by,
      backup,
      statements: ch.statements.map((s, i) => ({ ...s, rows: applied[i] ?? s.rows })),
    });
    return { backup, rows: applied.reduce((a, b) => a + b, 0) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setChange(projectId, id, { status: "failed", decidedAt: new Date().toISOString(), decidedBy: by, backup, error: error.slice(0, 500) });
    throw new CloudError(`The change failed and nothing was changed: ${error}`, 400);
  }
}

export async function rejectLiveChange(projectId: string, id: string, by: string | null) {
  const ch = (await liveChanges(projectId)).find((x) => x.id === id);
  if (!ch) throw new CloudError("That change doesn't exist.", 404);
  if (ch.status !== "pending") throw new CloudError(`That change was already ${ch.status}.`, 409);
  await setChange(projectId, id, { status: "rejected", decidedAt: new Date().toISOString(), decidedBy: by });
}
