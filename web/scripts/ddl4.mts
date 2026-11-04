import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`DO $$ BEGIN
    CREATE TYPE "DraftStatus" AS ENUM ('BUILDING','READY','MERGED','REVERTED','FAILED');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await c.query(`CREATE TABLE IF NOT EXISTS "drafts" (
    "id" TEXT PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
    "name" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'BUILDING',
    "baseSha" TEXT NOT NULL,
    "headSha" TEXT,
    "mergeSha" TEXT,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "seenBy" TEXT[] NOT NULL DEFAULT '{}'
  )`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "drafts_projectId_branch_key" ON "drafts"("projectId","branch")`);
  await c.query(`CREATE INDEX IF NOT EXISTS "drafts_projectId_status_createdAt_idx" ON "drafts"("projectId","status","createdAt")`);
  await c.query(`ALTER TABLE "builds" ADD COLUMN IF NOT EXISTS "draftId" TEXT`);
  console.log("drafts table + builds.draftId ready");
  await c.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
