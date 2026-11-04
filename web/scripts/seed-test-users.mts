/**
 * Test users for sharing: an outsider with their own workspace, and a MEMBER
 * of the dev workspace. Prints a session token for each. Development only;
 * run with the dev server stopped (the local database takes one connection).
 */
import "dotenv/config";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const id = () => `t${randomUUID().replace(/-/g, "").slice(0, 24)}`;

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const dev = await c.query(`SELECT m."workspaceId" FROM memberships m JOIN users u ON u.id = m."userId" WHERE u.email = 'dev@localhost' LIMIT 1`);
  const devWs = dev.rows[0]?.workspaceId;
  const out: Record<string, string> = {};

  for (const [email, name, joinDev] of [
    ["outsider@localhost", "Olive Outsider", false],
    ["member@localhost", "Max Member", true],
  ] as const) {
    let u = (await c.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0];
    if (!u) {
      u = { id: id() };
      await c.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [u.id, email, name]);
      const ws = id();
      await c.query(`INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`, [ws, `${name}'s workspace`, `ws-${ws.slice(1, 8)}`]);
      await c.query(`INSERT INTO memberships (id, "userId", "workspaceId", role, "createdAt") VALUES ($1, $2, $3, 'OWNER', now() - interval '1 day')`, [id(), u.id, ws]);
    }
    if (joinDev && devWs) {
      await c.query(
        `INSERT INTO memberships (id, "userId", "workspaceId", role, "createdAt") VALUES ($1, $2, $3, 'MEMBER', now())
         ON CONFLICT ("userId", "workspaceId") DO NOTHING`,
        [id(), u.id, devWs],
      );
    }
    const token = randomUUID();
    await c.query(`INSERT INTO sessions (id, "sessionToken", "userId", expires) VALUES ($1, $2, $3, now() + interval '30 days')`, [id(), token, u.id]);
    out[email] = token;
  }
  console.log(JSON.stringify(out));
  await c.end();
}
main().catch((e) => { console.error("SEED FAILED:", e.message); process.exit(1); });
