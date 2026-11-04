import "dotenv/config";
import { Client } from "pg";

const SQL = [
  `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "securityConfig" JSONB`,
  `ALTER TABLE "builds" ADD COLUMN IF NOT EXISTS "free" BOOLEAN NOT NULL DEFAULT false`,
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
