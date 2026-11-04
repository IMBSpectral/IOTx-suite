/**
 * Organizations: create from a workspace, add a workspace, admins (only
 * people in the org; never zero), standardized settings pushed to every
 * workspace with enforced keys locked, the org audit log, removing a
 * workspace (never the last).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle31.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fetchRetry: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    await sleep(500);
    return fetch(input, init);
  }
};
const call = async (p: string, body?: unknown, c = cookie) => {
  const r = await fetchRetry(`${BASE}${p}`, body === undefined ? { headers: { cookie: c } } : { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};

const ws = (await call("/api/workspace")).json.workspace as { id: string; name: string };
const before = await db.workspace.findUniqueOrThrow({ where: { id: ws.id }, select: { previewSharing: true, cloudAutoApprove: true, orgId: true, publishRequiresApproval: true } });
let orgId = "";
let extraWs = "";

try {
  check("this workspace starts without an organization", before.orgId === null && (await call("/api/org")).json.org === null);
  const made = await call("/api/org", { action: "create", name: "C31 Holdings" });
  orgId = made.json.id;
  check("a workspace owner can create an organization", made.status === 201);
  let ov = (await call("/api/org")).json as { admin: boolean; org: { admins: { email: string }[]; workspaces: { id: string }[] } };
  check("and is its first admin", ov.admin && ov.org.admins.some((a) => a.email === "dev@localhost") && ov.org.workspaces.length === 1);
  const w2 = await call("/api/org", { action: "createWorkspace", name: "C31 Marketing" });
  extraWs = w2.json.id;
  ov = (await call("/api/org")).json as typeof ov;
  check("admins can add a workspace to the organization", w2.status === 201 && ov.org.workspaces.length === 2);

  check("only people in the organization can be admins", (await call("/api/org", { action: "addAdmin", email: "outsider@localhost" })).status === 400);
  const memberInOrg = await db.membership.count({ where: { user: { email: "member@localhost" }, workspace: { orgId } } });
  if (memberInOrg) {
    check("people in it can", (await call("/api/org", { action: "addAdmin", email: "member@localhost" })).status === 200);
    const m = await db.user.findUniqueOrThrow({ where: { email: "member@localhost" } });
    await call("/api/org", { action: "removeAdmin", userId: m.id });
  }
  const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
  check("the last admin can't be removed", (await call("/api/org", { action: "removeAdmin", userId: dev.id })).status === 400);

  const std = await call("/api/org", { action: "standards", settings: { previewSharing: "signin", cloudAutoApprove: false }, enforced: ["previewSharing"] });
  const both = await db.workspace.findMany({ where: { orgId }, select: { previewSharing: true, cloudAutoApprove: true } });
  check("standard settings are pushed to every workspace", std.status === 200 && both.length === 2 && both.every((w) => w.previewSharing === "signin" && w.cloudAutoApprove === false));
  check("bad values are refused", (await call("/api/org", { action: "standards", settings: { previewSharing: "everyone" }, enforced: [] })).status === 400);
  const locked = await call("/api/workspace/security", { action: "previewSharing", previewSharing: "anyone" });
  check("an enforced setting can't be changed in a workspace", locked.status === 403 && /organization/i.test(locked.json.error), JSON.stringify(locked.json));
  check("one that isn't enforced still can", (await call("/api/workspace/security", { action: "cloudAutoApprove", cloudAutoApprove: true })).status === 200);
  check("the workspace knows what its organization enforces", ((await call("/api/workspace/security")).json.enforcedByOrg as string[]).includes("previewSharing"));

  const audit = (await call("/api/org?view=audit")).json.events as { workspace: string; detail: string }[];
  const names = new Set(audit.map((e) => e.workspace));
  check("the organization audit log covers every workspace", names.has(ws.name) && names.has("C31 Marketing"), [...names].join(", "));

  const memberView = (await call("/api/org", undefined, `authjs.session-token=${users["member@localhost"]}`)).json as { admin?: boolean; org: unknown };
  check("people who aren't org admins don't see its settings", memberView.admin !== true);
  check("a workspace can leave the organization", (await call("/api/org", { action: "removeWorkspace", workspaceId: extraWs })).status === 200);
  check("but not the last one", (await call("/api/org", { action: "removeWorkspace", workspaceId: ws.id })).status === 400);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  await db.workspace.update({ where: { id: ws.id }, data: { orgId: null, previewSharing: before.previewSharing, cloudAutoApprove: before.cloudAutoApprove, publishRequiresApproval: before.publishRequiresApproval } });
  if (extraWs) await db.workspace.delete({ where: { id: extraWs } }).catch(() => undefined);
  if (orgId) await db.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
