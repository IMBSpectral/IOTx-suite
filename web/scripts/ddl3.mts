import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`ALTER TABLE "builds" ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3)`);
  await c.query(`ALTER TABLE "builds" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0`);
  console.log("builds.heartbeatAt + builds.attempts added");
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
