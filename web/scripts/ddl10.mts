import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`ALTER TABLE "projects"
    ADD COLUMN IF NOT EXISTS "restricted" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "linkAccess" TEXT,
    ADD COLUMN IF NOT EXISTS "linkToken" TEXT,
    ADD COLUMN IF NOT EXISTS "allowGuestComments" BOOLEAN NOT NULL DEFAULT false`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "projects_linkToken_key" ON "projects"("linkToken")`);
  await c.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "allowExternalCollaborators" BOOLEAN NOT NULL DEFAULT true`);
  await c.query(`CREATE TABLE IF NOT EXISTS "preview_links" (
    "id" TEXT PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "passwordHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "allowComments" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "views" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3))`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "preview_links_token_key" ON "preview_links"("token")`);
  await c.query(`CREATE INDEX IF NOT EXISTS "preview_links_projectId_createdAt_idx" ON "preview_links"("projectId","createdAt")`);
  await c.query(`CREATE TABLE IF NOT EXISTS "access_requests" (
    "id" TEXT PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT)`);
  await c.query(`CREATE INDEX IF NOT EXISTS "access_requests_projectId_status_idx" ON "access_requests"("projectId","status")`);
  console.log("ddl10 ok");
  await c.end();
}
main().catch((e) => { console.error("DDL FAILED:", e.message); process.exit(1); });
