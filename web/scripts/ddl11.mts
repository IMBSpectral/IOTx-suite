import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`ALTER TABLE "credit_entries"
    ADD COLUMN IF NOT EXISTS "category" TEXT,
    ADD COLUMN IF NOT EXISTS "userId" TEXT,
    ADD COLUMN IF NOT EXISTS "projectId" TEXT`);
  // Existing build charges: attribute to the project and sender of the message they paid for.
  const r = await c.query(`
    UPDATE "credit_entries" e SET "category" = CASE WHEN b."mode" IN ('ask','plan') THEN 'chat' ELSE 'build' END,
           "projectId" = m."projectId",
           "userId" = (SELECT u."userId" FROM "messages" u WHERE u."projectId" = m."projectId" AND u."role" = 'USER'
                        AND u."createdAt" <= m."createdAt" ORDER BY u."createdAt" DESC LIMIT 1)
      FROM "messages" m LEFT JOIN "builds" b ON b."messageId" = m."id"
     WHERE e."messageId" = m."id" AND e."reason" = 'GENERATION' AND e."category" IS NULL`);
  await c.query(`CREATE TABLE IF NOT EXISTS "spend_limits" (
    "id" TEXT PRIMARY KEY,
    "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "scope" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "monthly" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "spend_limits_workspaceId_scope_targetId_key" ON "spend_limits"("workspaceId","scope","targetId")`);
  await c.query(`CREATE INDEX IF NOT EXISTS "credit_entries_workspaceId_userId_idx" ON "credit_entries"("workspaceId","userId")`);
  console.log(`ddl11 ok, backfilled ${r.rowCount}`);
  await c.end();
}
main().catch((e) => { console.error("DDL FAILED:", e.message); process.exit(1); });
