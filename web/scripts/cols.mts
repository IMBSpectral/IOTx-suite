import "dotenv/config";
import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='builds' AND column_name IN ('heartbeatAt','attempts','mode')
      ORDER BY column_name`,
  );
  console.log("present:", rows.map((r) => r.column_name).join(", ") || "(none)");
  await c.end();
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
