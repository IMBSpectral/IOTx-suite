import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "createdById" TEXT`);
  // Backfill from the earliest user message in each project.
  const r = await c.query(`
    UPDATE "projects" p SET "createdById" = m."userId"
      FROM (SELECT DISTINCT ON ("projectId") "projectId", "userId" FROM "messages"
             WHERE "userId" IS NOT NULL ORDER BY "projectId", "createdAt") m
     WHERE m."projectId" = p."id" AND p."createdById" IS NULL`);
  console.log(`createdById added, backfilled ${r.rowCount}`);
  await c.end();
}
main().catch((e) => { console.error("DDL FAILED:", e.message); process.exit(1); });
