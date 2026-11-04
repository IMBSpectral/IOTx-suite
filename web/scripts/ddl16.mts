import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`ALTER TABLE "projects"
    ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'app',
    ADD COLUMN IF NOT EXISTS "designSystemId" TEXT,
    ADD COLUMN IF NOT EXISTS "designSystemVersion" INTEGER,
    ADD COLUMN IF NOT EXISTS "dsVersion" INTEGER NOT NULL DEFAULT 0`);
  console.log("ddl16 ok");
  await c.end();
}
main().catch((e) => { console.error("DDL FAILED:", e.message); process.exit(1); });
