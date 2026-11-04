import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "monitoring" JSONB`);
  console.log("ddl13 ok");
  await c.end();
}
main().catch((e) => { console.error("DDL FAILED:", e.message); process.exit(1); });
