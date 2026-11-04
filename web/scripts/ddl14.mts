import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`CREATE TABLE IF NOT EXISTS "automations" (
    "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL, "prompt" TEXT NOT NULL, "mode" TEXT NOT NULL DEFAULT 'build',
    "schedule" TEXT NOT NULL, "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" TEXT NOT NULL DEFAULT 'active', "pausedReason" TEXT,
    "nextRunAt" TIMESTAMP(3), "lastRunAt" TIMESTAMP(3), "lastBuildId" TEXT, "lastResult" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0, "runs" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await c.query(`CREATE INDEX IF NOT EXISTS "automations_status_nextRunAt_idx" ON "automations"("status","nextRunAt")`);
  await c.query(`CREATE INDEX IF NOT EXISTS "automations_workspaceId_idx" ON "automations"("workspaceId")`);
  await c.query(`CREATE TABLE IF NOT EXISTS "workspace_chats" (
    "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await c.query(`CREATE INDEX IF NOT EXISTS "workspace_chats_userId_updatedAt_idx" ON "workspace_chats"("userId","updatedAt")`);
  await c.query(`CREATE TABLE IF NOT EXISTS "workspace_chat_messages" (
    "id" TEXT PRIMARY KEY, "chatId" TEXT NOT NULL REFERENCES "workspace_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "role" TEXT NOT NULL, "content" TEXT NOT NULL, "steps" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await c.query(`CREATE INDEX IF NOT EXISTS "workspace_chat_messages_chatId_createdAt_idx" ON "workspace_chat_messages"("chatId","createdAt")`);
  console.log("ddl14 ok");
  await c.end();
}
main().catch((e) => { console.error("DDL FAILED:", e.message); process.exit(1); });
