/**
 * Give someone a password (making the account if needed), and optionally put
 * them in a workspace:
 *   npx tsx scripts/set-password.mts <email> <password> [--name "Full name"] [--workspace <id|name>] [--role OWNER|ADMIN|MEMBER] [--new-workspace "Company name"]
 * Prints what it did, never the password.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { setPassword } from "../src/lib/password-login";

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const [emailRaw, password] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!emailRaw || !password) {
  console.error('usage: npx tsx scripts/set-password.mts <email> <password> [--name "Full name"] [--workspace <id|name>] [--role OWNER|ADMIN|MEMBER] [--new-workspace "Company name"]');
  process.exit(1);
}
const email = emailRaw.trim().toLowerCase();
const name = flag("--name");
const role = (flag("--role") ?? "MEMBER").toUpperCase();
if (!["OWNER", "ADMIN", "MEMBER", "VIEWER"].includes(role)) throw new Error("--role must be OWNER, ADMIN, MEMBER or VIEWER");

let user = await db.user.findUnique({ where: { email } });
if (!user) {
  user = await db.user.create({ data: { email, name: name ?? null, emailVerified: new Date() } });
  console.log(`made the account ${email}`);
} else if (name && !user.name) await db.user.update({ where: { id: user.id }, data: { name } });
const err = await setPassword(user.id, password);
if (err) throw new Error(err);
console.log(`password set for ${email}`);

let wsId: string | null = null;
const wsRef = flag("--workspace");
const newWs = flag("--new-workspace");
if (newWs) {
  const slug = `${newWs.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`;
  const ws = await db.workspace.create({ data: { name: newWs, slug } as never });
  wsId = ws.id;
  console.log(`made the workspace "${newWs}"`);
} else if (wsRef) {
  const ws = (await db.workspace.findUnique({ where: { id: wsRef } })) ?? (await db.workspace.findFirst({ where: { name: { equals: wsRef, mode: "insensitive" } } }));
  if (!ws) throw new Error(`no workspace "${wsRef}"`);
  wsId = ws.id;
}
if (wsId) {
  await db.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: wsId } },
    create: { userId: user.id, workspaceId: wsId, role: role as never },
    update: { role: role as never },
  });
  console.log(`${email} is ${role.toLowerCase()} of that workspace`);
}
const memberships = await db.membership.findMany({ where: { userId: user.id }, include: { workspace: { select: { name: true } } } });
console.log(`workspaces: ${memberships.map((m) => `${m.workspace.name} (${m.role.toLowerCase()})`).join(", ") || "none yet (they'll get their own on first sign-in)"}`);
await db.$disconnect();
