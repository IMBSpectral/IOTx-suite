import "dotenv/config";
import { Client } from "pg";

const SQL = [
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "publishAudience" TEXT NOT NULL DEFAULT 'public'`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "showBadge" BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "seo" JSONB`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "lastChecks" JSONB`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "publishRequestedAt" TIMESTAMP(3)`,
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "publishRequestedById" TEXT`,
  `ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "publishRequiresApproval" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "security_findings" ADD COLUMN IF NOT EXISTS "ignored" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "security_findings" ADD COLUMN IF NOT EXISTS "ignoreReason" TEXT`,
];

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (const q of SQL) await c.query(q);
  console.log(`applied ${SQL.length} statements`);
  await c.end();
}
main().catch((e) => {
  console.error("DDL FAILED:", e.message);
  process.exit(1);
});
