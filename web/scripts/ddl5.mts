import "dotenv/config";
import { Client } from "pg";
const SQL = [
  `ALTER TABLE "builds" ADD COLUMN IF NOT EXISTS "cancelRequested" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "builds" ADD COLUMN IF NOT EXISTS "queuePos" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "builds" ADD COLUMN IF NOT EXISTS "undone" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "feedback" TEXT`,
  `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "attachments" JSONB`,
  `ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "monthlySpendLimit" INTEGER`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "emoji" TEXT`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "notes" TEXT`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "isTemplate" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "folderId" TEXT`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3)`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "queuePaused" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "tasks" JSONB`,
  `CREATE TABLE IF NOT EXISTS "bookmarks" ("id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE, "sha" TEXT NOT NULL, "name" TEXT NOT NULL, "createdById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS "bookmarks_projectId_createdAt_idx" ON "bookmarks"("projectId","createdAt")`,
  `CREATE TABLE IF NOT EXISTS "folders" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "parentId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS "folders_workspaceId_idx" ON "folders"("workspaceId")`,
  `DO $$ BEGIN ALTER TABLE "projects" ADD CONSTRAINT "projects_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE TABLE IF NOT EXISTS "notifications" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE, "projectId" TEXT, "kind" TEXT NOT NULL, "title" TEXT NOT NULL, "body" TEXT, "href" TEXT, "readAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId","readAt","createdAt")`,
  `CREATE TABLE IF NOT EXISTS "project_visits" ("userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE, "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE, "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("userId","projectId"))`,
  `CREATE INDEX IF NOT EXISTS "project_visits_userId_at_idx" ON "project_visits"("userId","at")`,
];
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (const q of SQL) await c.query(q);
  console.log(`applied ${SQL.length} statements`);
  await c.end();
}
main().catch((e) => { console.error("DDL FAILED:", e.message); process.exit(1); });
