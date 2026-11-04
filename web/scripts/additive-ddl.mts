import "dotenv/config";
import { Client } from "pg";

// Purely additive: two new tables and one new column with a default.
// Nothing is dropped, renamed, or retyped, so no existing row is at risk.
const DDL = [
  `CREATE TABLE IF NOT EXISTS "build_events" (
     "id"      TEXT PRIMARY KEY,
     "buildId" TEXT NOT NULL,
     "seq"     INTEGER NOT NULL,
     "type"    TEXT NOT NULL,
     "payload" JSONB NOT NULL,
     "at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `ALTER TABLE "build_events" DROP CONSTRAINT IF EXISTS "build_events_buildId_fkey"`,
  `ALTER TABLE "build_events" ADD CONSTRAINT "build_events_buildId_fkey"
     FOREIGN KEY ("buildId") REFERENCES "builds"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "build_events_buildId_seq_key" ON "build_events"("buildId","seq")`,
  `CREATE INDEX IF NOT EXISTS "build_events_buildId_seq_idx" ON "build_events"("buildId","seq")`,

  `CREATE TABLE IF NOT EXISTS "knowledge" (
     "id"        TEXT PRIMARY KEY,
     "projectId" TEXT NOT NULL,
     "content"   TEXT NOT NULL,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_projectId_key" ON "knowledge"("projectId")`,
  `ALTER TABLE "knowledge" DROP CONSTRAINT IF EXISTS "knowledge_projectId_fkey"`,
  `ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_projectId_fkey"
     FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE`,

  `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'build'`,
];

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (const sql of DDL) {
    await c.query(sql);
    console.log("ok:", sql.split("\n")[0].slice(0, 72));
  }
  const { rows } = await c.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name IN ('build_events','knowledge')`,
  );
  console.log("tables present:", rows.map((r) => r.table_name).sort().join(", "));
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
