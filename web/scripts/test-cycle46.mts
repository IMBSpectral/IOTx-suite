/**
 * Connector requests in the action center (X.14): with "members need approval
 * to connect tools" on, a member's connect becomes a request (credential kept
 * sealed), admins see it, approving connects it with the member's credential,
 * declining drops it, and owners still connect directly.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle46.mts <devToken> <test-users.json>
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, usersFile] = process.argv.slice(2);
const users = JSON.parse(fs.readFileSync(usersFile, "utf8")) as Record<string, string>;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const as = (cookie: string) => async (p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const owner = as(`authjs.session-token=${token}`);
const ws = (await owner("/api/workspace")).json.workspace as { id: string };
const member = as(`authjs.session-token=${users["member@localhost"]}; forge_ws=${ws.id}`);
const memberUser = await db.user.findUniqueOrThrow({ where: { email: "member@localhost" } });
const before = await db.membership.findUnique({ where: { userId_workspaceId: { userId: memberUser.id, workspaceId: ws.id } } });
const reqFile = path.join(process.env.PROJECTS_ROOT!, "_forge", "connector-requests", `${ws.id}.json`);
const reqBefore = fs.existsSync(reqFile) ? fs.readFileSync(reqFile, "utf8") : null;
let kind = "";
const made: string[] = [];

try {
  if (before) await db.membership.update({ where: { id: before.id }, data: { role: "MEMBER" } });
  else await db.membership.create({ data: { userId: memberUser.id, workspaceId: ws.id, role: "MEMBER" } });
  const def = await owner("/api/workspace/connectors", { action: "saveDef", def: { name: "C46 Inventory API", baseUrl: "https://inventory.c46.example/api", headerValue: "Bearer {{token}}" } });
  kind = def.json.def?.kind;
  const field = "token";

  check("members can't change the policy", (await member("/api/workspace/connectors", { action: "policy", approval: true })).status === 403);
  const on = await owner("/api/workspace/connectors", { action: "policy", approval: true });
  check("an owner turns on approval for connectors", on.status === 200 && on.json.approval === true);
  const view = await member("/api/workspace/connectors");
  check("members see that approval is on, without admin controls", view.json.approval === true && view.json.canManage === false);

  const ask = await member("/api/workspace/connectors", { action: "connect", kind, label: "Warehouse", values: { [field]: "sk-member-secret-123" }, scope: "workspace", reason: "Stock levels for the orders app" });
  check("a member's connect becomes a request", ask.status === 202 && ask.json.requested === true && /admins/.test(ask.json.message ?? ""), JSON.stringify(ask.json));
  check("nothing is connected yet", !(await db.connector.findFirst({ where: { workspaceId: ws.id, kind } })));
  const raw = fs.readFileSync(reqFile, "utf8");
  check("the credential is stored sealed, not in plain text", !raw.includes("sk-member-secret-123"));
  check("asking twice is refused", (await member("/api/workspace/connectors", { action: "connect", kind, label: "Warehouse", values: { [field]: "x" }, scope: "workspace" })).status === 400);
  check("the member sees their request waiting", (await member("/api/workspace/connectors")).json.myRequests?.some((r: any) => r.id === ask.json.id && !("values" in r)));
  const note = await db.notification.findFirst({ where: { kind: "connector_request", title: { contains: "C46 Inventory API" } }, orderBy: { createdAt: "desc" } });
  check("admins get a notification linking to the action center", note?.href === "/settings/actions");

  const ac = await owner("/api/workspace/action-center");
  const item = (ac.json.approvals as any[]).find((a) => a.id === ask.json.id);
  check("the request is in the action center with who, what and why", item?.type === "connector" && item.by === "member@localhost" && /C46 Inventory API/.test(item.detail) && /Stock levels/.test(item.detail), JSON.stringify(item));
  check("members can't decide requests", (await member("/api/workspace/action-center", { action: "decideConnector", id: ask.json.id, approve: true })).status === 403);

  const yes = await owner("/api/workspace/action-center", { action: "decideConnector", id: ask.json.id, approve: true });
  const conn = await db.connector.findFirst({ where: { workspaceId: ws.id, kind } });
  made.push(...(conn ? [conn.id] : []));
  check("approving connects it with the member's credential", yes.status === 200 && conn?.label === "Warehouse" && !JSON.stringify(conn?.config).includes("sk-member-secret-123"), JSON.stringify(yes.json));
  check("and the request leaves the action center", !((await owner("/api/workspace/action-center")).json.approvals as any[]).some((a) => a.id === ask.json.id));
  check("the member is told", !!(await db.notification.findFirst({ where: { userId: memberUser.id, kind: "connector_request", title: { contains: "is connected" } } })));

  const ask2 = await member("/api/workspace/connectors", { action: "connect", kind, label: "Second", values: { [field]: "sk-other" }, scope: "workspace" });
  const no = await owner("/api/workspace/action-center", { action: "decideConnector", id: ask2.json.id, approve: false });
  check("declining drops the request and its credential", no.status === 200 && !fs.readFileSync(reqFile, "utf8").includes(ask2.json.id) && !(await db.connector.findFirst({ where: { workspaceId: ws.id, kind, label: "Second" } })));
  check("deciding twice says it was already handled", (await owner("/api/workspace/action-center", { action: "decideConnector", id: ask2.json.id, approve: true })).status === 400);

  const direct = await owner("/api/workspace/connectors", { action: "connect", kind, label: "Owner direct", values: { [field]: "sk-owner" }, scope: "workspace" });
  const d2 = await db.connector.findFirst({ where: { workspaceId: ws.id, kind, label: "Owner direct" } });
  if (d2) made.push(d2.id);
  check("owners still connect directly", direct.status === 201 && !!d2);

  await owner("/api/workspace/connectors", { action: "policy", approval: false });
  const free = await member("/api/workspace/connectors", { action: "connect", kind, label: "Member free", values: { [field]: "sk-free" }, scope: "workspace" });
  const d3 = await db.connector.findFirst({ where: { workspaceId: ws.id, kind, label: "Member free" } });
  if (d3) made.push(d3.id);
  check("with approval off, members connect themselves again", free.status === 201 && !!d3);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (made.length) await db.connector.deleteMany({ where: { id: { in: made } } });
  if (kind) await owner("/api/workspace/connectors", { action: "deleteDef", kind });
  if (reqBefore === null) fs.rmSync(reqFile, { force: true });
  else fs.writeFileSync(reqFile, reqBefore);
  if (before) await db.membership.update({ where: { id: before.id }, data: { role: before.role } });
  else await db.membership.deleteMany({ where: { userId: memberUser.id, workspaceId: ws.id } });
  await db.notification.deleteMany({ where: { kind: "connector_request", title: { contains: "C46 Inventory API" } } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
