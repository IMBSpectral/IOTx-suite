import { databaseSize, openDatabase } from "./cloud";
import { readUsage } from "./cloud-ops";
import { storageUsed } from "./cloud-storage";
import { hasLive, liveId } from "./cloud-envs";

/**
 * The Cloud tab's Usage section: per day over 30 days, the app's API requests
 * and errors, AI calls and credits, server-function run time and emails; and
 * today's database and storage size.
 */

const DAY = 86_400_000;

async function daily(projectId: string, sql: string, since: string) {
  try {
    return await openDatabase(projectId).all<Record<string, number | string>>(sql, [since]);
  } catch {
    // The table appears with its first row.
    return [];
  }
}

export async function cloudUsage(projectId: string) {
  const since = new Date(Date.now() - 29 * DAY).toISOString().slice(0, 10);
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * DAY).toISOString().slice(0, 10));
  const requests = await daily(projectId, "SELECT substr(at, 1, 10) AS day, COUNT(*) AS n, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors FROM _forge_logs WHERE at >= ? GROUP BY day", since);
  const ai = await daily(projectId, "SELECT substr(at, 1, 10) AS day, COUNT(*) AS n, SUM(credits) AS credits FROM _forge_ai_logs WHERE at >= ? GROUP BY day", since);
  const fns = await daily(projectId, "SELECT substr(at, 1, 10) AS day, COUNT(*) AS n, SUM(ms) AS ms FROM _forge_fn_logs WHERE at >= ? GROUP BY day", since);
  const email = await readUsage(projectId);
  const pick = (rows: Record<string, number | string>[], day: string, k: string) => Number(rows.find((r) => r.day === day)?.[k] ?? 0);
  const size = (id: string) => databaseSize(id).catch(() => 0);
  return {
    days: days.map((day) => ({
      day,
      requests: pick(requests, day, "n"),
      errors: pick(requests, day, "errors"),
      aiCalls: pick(ai, day, "n"),
      aiCredits: pick(ai, day, "credits"),
      functionCalls: pick(fns, day, "n"),
      functionSeconds: Math.round(pick(fns, day, "ms") / 1000),
      emails: email[day]?.emails ?? 0,
    })),
    databaseBytes: await size(projectId),
    liveDatabaseBytes: (await hasLive(projectId)) ? await size(liveId(projectId)) : null,
    storage: await storageUsed(projectId).catch(() => ({ bytes: 0, files: 0 })),
  };
}
