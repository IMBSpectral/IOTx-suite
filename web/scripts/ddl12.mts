import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`CREATE TABLE IF NOT EXISTS "comments" (
    "id" TEXT PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "parentId" TEXT,
    "authorId" TEXT,
    "guestName" TEXT,
    "previewLinkId" TEXT,
    "body" TEXT NOT NULL,
    "locator" TEXT,
    "selector" TEXT,
    "elementText" TEXT,
    "reactions" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await c.query(`CREATE INDEX IF NOT EXISTS "comments_projectId_createdAt_idx" ON "comments"("projectId","createdAt")`);
  await c.query(`CREATE INDEX IF NOT EXISTS "comments_parentId_idx" ON "comments"("parentId")`);
  await c.query(`ALTER TABLE "project_visits" ADD COLUMN IF NOT EXISTS "commentsReadAt" TIMESTAMP(3)`);
  console.log("ddl12 ok");
  await c.end();
}
main().catch((e) => { console.error("DDL FAILED:", e.message); process.exit(1); });
