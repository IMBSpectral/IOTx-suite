import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { cloudDbFile, cloudEngine, dataExists, getCloud, openDatabase, pgTarget, type Migration } from "./cloud";
import { withSqlite } from "./cloud-db";
import { cloneDatabase, pgDatabaseName } from "./cloud-pg";
import { SITES_HOST } from "./site-host";

/**
 * Test and Live environments for a Forge Cloud backend. Until the first
 * publish there is one database, Test. The first publish creates Live as a
 * copy of Test (schema and data); after that the published site and custom
 * domain use Live while the preview and drafts keep using Test, and each
 * publish applies to Live the database changes it hasn't had yet. Storage,
 * server functions, secrets and access rules are shared by both.
 *
 * SQLite: Live is a second file, first made with VACUUM INTO. Postgres: Live
 * is a second database (fc_<project>_live), first made with CREATE DATABASE
 * … TEMPLATE (an exact copy, sequences included). Later publishes replay the
 * migrations Live hasn't had, each in its own transaction, on both engines.
 */

export const liveId = (projectId: string) => `${projectId.split("@")[0]}@live`;

// Live, once made, stays: remember it so requests from the published site don't each ask the database server.
const gl = globalThis as unknown as { __forgeCloudLive?: Set<string> };
const knownLive = (gl.__forgeCloudLive ??= new Set<string>());

export async function hasLive(projectId: string) {
  const id = liveId(projectId);
  if (knownLive.has(id)) return true;
  const yes = await dataExists(id);
  if (yes) knownLive.add(id);
  return yes;
}

/** Forget that Live exists (the backend was turned off or moved to another engine). */
export function forgetLive(projectId: string) {
  knownLive.delete(liveId(projectId));
}

/** The data id for an environment name from the Cloud tab. */
export async function envDataId(projectId: string, env: string | null) {
  return env === "live" && (await hasLive(projectId)) ? liveId(projectId) : projectId;
}

/**
 * Called after a publish: create Live from Test the first time, otherwise
 * bring Live's schema up to date. Returns what happened, for the publish log.
 */
export async function syncLive(projectId: string): Promise<{ created: boolean; applied: string[]; failed: { id: string; error: string }[] }> {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) return { created: false, applied: [], failed: [] };
  if (!(await hasLive(projectId))) {
    if ((await cloudEngine(projectId)) === "postgres") {
      // An exact copy of Test's database, owned by the project's role.
      const t = await pgTarget(projectId);
      await cloneDatabase(t.database, pgDatabaseName(liveId(projectId)), t.user);
    } else {
      const target = cloudDbFile(liveId(projectId));
      await fs.mkdir(path.dirname(target), { recursive: true });
      // A consistent copy of Test, schema and data, migration history included.
      await withSqlite(cloudDbFile(projectId), (h) => h.prepare("VACUUM INTO ?").run(target));
    }
    return { created: true, applied: [], failed: [] };
  }
  const test = openDatabase(projectId);
  const live = openDatabase(liveId(projectId));
  const done = new Set((await live.all<{ id: string }>("SELECT id FROM _forge_migrations WHERE status = 'applied'")).map((r) => r.id));
  const todo = (await test.all<Migration>("SELECT * FROM _forge_migrations WHERE status = 'applied' ORDER BY applied_at ASC")).filter((m) => !done.has(m.id));
  const applied: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const m of todo) {
    try {
      await live.transaction(async (tx) => {
        await tx.exec(m.sql);
        await tx.run(
          `INSERT INTO _forge_migrations (id, description, sql, status, created_at, applied_at) VALUES (?, ?, ?, 'applied', ?, ?)
           ON CONFLICT (id) DO UPDATE SET status = 'applied', applied_at = excluded.applied_at, error = NULL`,
          [m.id, m.description, m.sql, m.created_at, new Date().toISOString()],
        );
      });
      applied.push(m.description);
    } catch (e) {
      failed.push({ id: m.id, error: e instanceof Error ? e.message : String(e) });
      // Later changes may depend on this one, so stop here.
      break;
    }
  }
  return { created: false, applied, failed };
}

/** Which environment a request to the app's API belongs to: the live site and custom domain use Live. */
export async function liveForOrigin(projectId: string, origin: string | null) {
  if (!origin || !(await hasLive(projectId))) return false;
  const p = await db.project.findUnique({ where: { id: projectId }, select: { subdomain: true, customDomain: true } });
  if (!p) return false;
  const host = SITES_HOST;
  try {
    const o = new URL(origin);
    return o.host === `${p.subdomain}.${host}` || (!!p.customDomain && o.host === p.customDomain);
  } catch {
    return false;
  }
}
