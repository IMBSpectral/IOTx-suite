import { CloudError, openDatabase, updateCloud, type CloudConfig } from "./cloud";

/**
 * The app's AI activity (Cloud tab → AI): every cloud.ai call with its model,
 * tokens, credits, time and outcome. Prompts and answers are kept only while
 * "Log request and response bodies" is on. An optional monthly credit limit
 * stops the app's AI once reached.
 */

export type AiRun = {
  at: string;
  model: string;
  status: number;
  ms: number;
  input_tokens: number;
  output_tokens: number;
  credits: number;
  error: string | null;
  request: string | null;
  response: string | null;
};

async function table(projectId: string) {
  const db = openDatabase(projectId);
  await db.ensure(`CREATE TABLE IF NOT EXISTS _forge_ai_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, model TEXT NOT NULL, status INTEGER NOT NULL, ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, credits INTEGER NOT NULL DEFAULT 0,
    error TEXT, request TEXT, response TEXT)`);
  return db;
}

export async function recordAiRun(projectId: string, cfg: CloudConfig, run: Omit<AiRun, "at" | "request" | "response">, bodies: { request: unknown; response: string | null }) {
  const keep = cfg.ai?.logBodies === true;
  const t = await table(projectId);
  await t.run(
    "INSERT INTO _forge_ai_logs (at, model, status, ms, input_tokens, output_tokens, credits, error, request, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      new Date().toISOString(),
      run.model,
      run.status,
      run.ms,
      run.input_tokens,
      run.output_tokens,
      run.credits,
      run.error,
      keep ? JSON.stringify(bodies.request).slice(0, 50_000) : null,
      keep ? (bodies.response ?? "").slice(0, 50_000) : null,
    ],
  );
  await t.run("DELETE FROM _forge_ai_logs WHERE id <= (SELECT MAX(id) - 2000 FROM _forge_ai_logs)");
}

export async function readAiRuns(projectId: string, { errorsOnly = false, limit = 200 } = {}) {
  return (await table(projectId)).all<AiRun>(
    `SELECT at, model, status, ms, input_tokens, output_tokens, credits, error, request, response FROM _forge_ai_logs ${errorsOnly ? "WHERE status >= 400" : ""} ORDER BY id DESC LIMIT ?`,
    [Math.min(1000, limit)],
  );
}

/** Credits the app's AI used since the start of this calendar month (UTC). */
export async function aiCreditsThisMonth(projectId: string) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const r = await (await table(projectId)).get<{ n: number; c: number }>(
    "SELECT COALESCE(SUM(credits), 0) AS n, COUNT(*) AS c FROM _forge_ai_logs WHERE at >= ?",
    [start.toISOString()],
  );
  return { credits: Number(r?.n ?? 0), calls: Number(r?.c ?? 0) };
}

export async function checkAiLimit(projectId: string, cfg: CloudConfig) {
  const limit = cfg.ai?.creditLimit;
  if (limit && (await aiCreditsThisMonth(projectId)).credits >= limit) {
    throw new CloudError("This app's AI reached its monthly credit limit.", 402);
  }
}

export async function setAiSettings(projectId: string, patch: { logBodies?: boolean; creditLimit?: number | null }) {
  const cfg = await updateCloud(projectId, (c) => {
    c.ai = { enabled: c.ai?.enabled ?? true, ...c.ai };
    if (typeof patch.logBodies === "boolean") c.ai.logBodies = patch.logBodies;
    if (patch.creditLimit === null || patch.creditLimit === 0) delete c.ai.creditLimit;
    else if (patch.creditLimit !== undefined) {
      const n = Math.floor(Number(patch.creditLimit));
      if (!Number.isFinite(n) || n < 1 || n > 1_000_000) throw new CloudError("Set the limit as a whole number of credits.");
      c.ai.creditLimit = n;
    }
  });
  return cfg.ai;
}
