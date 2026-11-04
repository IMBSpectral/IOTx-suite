import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`ALTER TABLE "builds" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'build'`);
  console.log("builds.mode added");
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
