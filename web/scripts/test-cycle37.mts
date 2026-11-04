/**
 * IOTx Suite permissions: the 2-in-1 Builder switch (chat without it, Plan /
 * Build / publish / Cloud / code / connectors refused by the server), finer
 * builder switches, deny wins, temporary grants that expire, custom roles from
 * templates given to a person and to a group, monthly credit limits, "Preview
 * as", the owner keeping everything, the audit trail, the app pass and the
 * appearance settings.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle37.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const OWNER = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(p: string, body?: unknown, c = OWNER, method?: string) {
  const init: RequestInit = body === undefined && !method ? { headers: { cookie: c } } : { method: method ?? "POST", headers: { cookie: c, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) };
  let r: Response;
  try {
    r = await fetch(`${BASE}${p}`, init);
  } catch {
    await sleep(500);
    r = await fetch(`${BASE}${p}`, init);
  }
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any>, headers: r.headers };
}

const ws = (await call("/api/workspace")).json.workspace as { id: string };
const MEMBER = `authjs.session-token=${users["member@localhost"]}; forge_ws=${ws.id}`;
const memberUser = await db.user.findUniqueOrThrow({ where: { email: "member@localhost" } });
const started = new Date();
const perm = (c = MEMBER) => call("/api/permissions", undefined, c);
const admin = async () => (await call("/api/permissions?admin=1")).json as { roles: { id: string; key: string; builtin: string | null; perms: Record<string, boolean> }[]; overrides: { id: string }[] };
const act = (b: Record<string, unknown>, c = OWNER) => call("/api/permissions", b, c);
const created: string[] = [];
const createAs = async (c: string, name: string) => {
  const r = await call("/api/projects", { name, force: true }, c);
  if (r.json.project?.id) created.push(r.json.project.id);
  return r;
};
let memberRoleId = "";
let customRoleId = "";
let groupId = "";

try {
  // ── Owner and defaults
  const me = (await perm(OWNER)).json;
  check("the owner has everything, including Builder and managing roles", me.me.isOwner && me.me.keys.includes("builder.open") && me.me.keys.includes("admin.roles") && me.canManage);
  const st = await admin();
  check("built-in roles exist: Owner, Admin, Member, Guest", ["owner", "admin", "member", "guest"].every((b) => st.roles.some((r) => r.builtin === b)));
  memberRoleId = st.roles.find((r) => r.builtin === "member")!.id;
  const guestRoleId = st.roles.find((r) => r.builtin === "guest")!.id;
  const ownerRoleId = st.roles.find((r) => r.builtin === "owner")!.id;
  await act({ action: "resetRole", roleId: memberRoleId });
  const m0 = (await perm()).json.me;
  check("existing members keep the Builder switch and its features by default", m0.builtin === "member" && ["builder.open", "builder.build", "builder.plan", "builder.publish", "builder.project.create"].every((k) => m0.keys.includes(k)));
  check("members can't manage roles", (await perm()).json.canManage === false && (await call("/api/permissions?admin=1", undefined, MEMBER)).status === 403);
  check("a member can't change a role", (await act({ action: "updateRole", roleId: memberRoleId, set: { "admin.roles": true } }, MEMBER)).status === 403);
  check("Ledger/Books are folded into one Tally app with a voucher matrix", m0.apps.includes("tally") && !m0.apps.includes("ledger") && !m0.apps.includes("books") && st.roles.find((r) => r.builtin === "admin")!.perms["tally.voucher.sales.delete"] === true);

  const pid = (await createAs(OWNER, "C37 permissions")).json.project?.id as string;
  check("the owner creates a project", !!pid);

  // ── Builder off: chat only
  check("turning the Builder switch off for Member saves", (await act({ action: "updateRole", roleId: memberRoleId, set: { "builder.open": false } })).status === 200);
  const m1 = (await perm()).json.me;
  check("without Builder the member keeps Ask IOTx but loses every builder feature", m1.keys.includes("home.ask") && !m1.keys.some((k: string) => k.startsWith("builder.")) && !m1.apps.includes("builder"));
  const refused = await createAs(MEMBER, "C37 member should fail");
  check("without Builder, creating a project is refused by the API", refused.status === 403 && refused.json.permission === "builder.open", JSON.stringify(refused.json));
  const b1 = await call(`/api/projects/${pid}/messages`, { content: "Add a footer", mode: "build" }, MEMBER);
  check("Build mode is refused", b1.status === 403 && b1.json.code === "permission_denied", JSON.stringify(b1.json));
  check("Plan mode is refused", (await call(`/api/projects/${pid}/messages`, { content: "Plan a footer", mode: "plan" }, MEMBER)).status === 403);
  check("publishing is refused", (await call(`/api/projects/${pid}/publish`, {}, MEMBER)).status === 403);
  check("turning on Cloud is refused", (await call(`/api/projects/${pid}/cloud`, { action: "enable" }, MEMBER)).status === 403);
  check("the SQL editor is refused", (await call(`/api/projects/${pid}/cloud/admin`, { action: "sql", sql: "select 1" }, MEMBER)).status === 403);
  check("editing code is refused", (await call(`/api/projects/${pid}/files`, { path: "src/x.ts", content: "x" }, MEMBER, "PUT")).status === 403);
  check("visual edits are refused", (await call(`/api/projects/${pid}/quick-edit`, { selector: "h1", text: "x" }, MEMBER)).status === 403);
  check("connecting a connector is refused", (await call("/api/workspace/connectors", { action: "connect", kind: "openai", values: {} }, MEMBER)).status === 403);
  check("the Builder dashboard sends them Home", (await fetch(`${BASE}/dashboard`, { headers: { cookie: MEMBER }, redirect: "manual" })).headers.get("location")?.includes("/home") === true);
  // The suite is a browser: a top-level load is the frame (tabs, toolbar, apps sidebar); a page inside a tab has no chrome.
  const page = async (p: string, c: string, dest: "iframe" | "document") => (await (await fetch(`${BASE}${p}`, { headers: { cookie: c, "sec-fetch-dest": dest } })).text()).replace(/<!-- -->/g, "");
  const home = await page("/home", MEMBER, "iframe");
  check("Home is the New Tab page: search everything and ask the AI, without Build", home.includes('class="ix-start"') && home.includes("Search IOTx or ask anything") && home.includes("Ask AI") && !home.includes('data-mode="build"'));
  check("…inside a tab it has no suite chrome, no apps grid and no Builder for them", !home.includes("ixb-strip") && !home.includes("ix-start-apps") && !home.includes('href="/dashboard"'));
  const frame = await page("/home", MEMBER, "document");
  check("…the top window is the browser frame: tab strip, toolbar with the address bar, the apps sidebar", frame.includes('class="ixb-strip"') && frame.includes("Address and search bar") && frame.includes('aria-label="New tab (Alt+T)"') && frame.includes('class="ixb-side"'));
  check("…the sidebar has no Builder for them, and nothing opens a browser tab", frame.includes('data-app="calendar"') && !frame.includes('data-app="builder"') && !/target="_blank"/.test(frame) && !frame.includes('class="ix-start"'));
  const chat = await call("/api/assistant", { content: "Reply with only the word OK." }, MEMBER);
  check("they can still chat with the AI", chat.status === 200 && typeof chat.json.reply?.content === "string", JSON.stringify(chat.json).slice(0, 300));
  if (chat.json.chatId) await call("/api/assistant", { action: "delete", chatId: chat.json.chatId }, MEMBER);

  // ── Builder back on
  await act({ action: "updateRole", roleId: memberRoleId, set: { "builder.open": true } });
  const ok = await createAs(MEMBER, "C37 member project");
  check("turning Builder back on restores project creation", ok.status === 201, JSON.stringify(ok.json));
  const homeB = await page("/home", MEMBER, "document");
  check("and the sidebar lists the Builder app again (it opens in a suite tab)", /data-app="builder"[^>]*href="\/dashboard"|href="\/dashboard"[^>]*data-app="builder"/.test(homeB));
  const chatB = await (await fetch(`${BASE}/home/chat?new=1`, { headers: { cookie: MEMBER } })).text();
  check("and AI Chat offers Plan and Build again (the 2-in-1 prompt)", chatB.includes('data-mode="build"') && chatB.includes('data-mode="plan"'));

  // ── Finer switches
  await act({ action: "updateRole", roleId: memberRoleId, set: { "builder.publish": false } });
  const pub = await call(`/api/projects/${pid}/publish`, {}, MEMBER);
  check("with Publish off, publishing is refused (with the switch named)", pub.status === 403 && pub.json.permission === "builder.publish");
  await act({ action: "updateRole", roleId: memberRoleId, set: { "builder.plan": false } });
  check("with Plan mode off, Plan is refused", (await call(`/api/projects/${pid}/messages`, { content: "Plan it", mode: "plan" }, MEMBER)).json.permission === "builder.plan");
  await act({ action: "updateRole", roleId: memberRoleId, limits: { "builder.credits.monthly": 0 } });
  const lim = await call(`/api/projects/${pid}/messages`, { content: "Add a footer", mode: "build" }, MEMBER);
  check("a monthly AI credit limit of 0 stops builds", lim.status === 402 && lim.json.code === "limit_reached", JSON.stringify(lim.json));
  await act({ action: "updateRole", roleId: memberRoleId, limits: { "builder.credits.monthly": null } });
  await act({ action: "updateRole", roleId: memberRoleId, set: { "builder.project.delete": false } });
  const del = await call(`/api/projects/${ok.json.project.id}`, undefined, MEMBER, "DELETE");
  check("with Delete projects off, deleting is refused", del.status === 403 || del.status === 404, `${del.status}`);
  check("subdomains need their own switch", (await call(`/api/projects/${pid}`, { subdomain: "c37-sub-x" }, MEMBER, "PATCH")).status === 200);
  await act({ action: "updateRole", roleId: memberRoleId, set: { "builder.domain.subdomain": false } });
  check("…and are refused without it", (await call(`/api/projects/${pid}`, { subdomain: "c37-sub-y" }, MEMBER, "PATCH")).json.permission === "builder.domain.subdomain");
  await act({ action: "resetRole", roleId: memberRoleId });

  // ── Deny wins
  const deny = await act({ action: "override", userId: memberUser.id, key: "builder.project.create", effect: "deny", reason: "c37" });
  check("an admin can deny one person a switch", deny.status === 201);
  check("a deny wins over the role's grant", (await createAs(MEMBER, "C37 denied")).status === 403);
  await act({ action: "removeOverride", id: deny.json.override.id });
  check("removing the deny restores it", (await createAs(MEMBER, "C37 after deny")).status === 201);

  // ── Temporary grant
  await act({ action: "updateRole", roleId: memberRoleId, set: { "builder.open": false } });
  const until = new Date(Date.now() + 4000).toISOString();
  const grant = await act({ action: "override", userId: memberUser.id, key: "builder.open", effect: "grant", expiresAt: until, reason: "until Friday" });
  check("a temporary grant gives Builder back", grant.status === 201 && (await createAs(MEMBER, "C37 temp grant")).status === 201);
  await sleep(5500);
  check("…and expires on its own", (await createAs(MEMBER, "C37 temp expired")).status === 403);
  check("a grant in the past is refused", (await act({ action: "override", userId: memberUser.id, key: "builder.open", effect: "grant", expiresAt: new Date(Date.now() - 1000).toISOString() })).status === 400);
  await act({ action: "removeOverride", id: grant.json.override.id });

  // ── Custom role from a template, given to the person, then to a group
  const role = await act({ action: "createRole", template: "builder", name: "C37 Builder" });
  customRoleId = role.json.role?.id;
  check("a role can be created from a template", role.status === 201 && role.json.role.kind === "template");
  const blank = await act({ action: "createRole", name: "C37 Blank" });
  check("a new custom role starts with Ask only, Builder off", blank.status === 201 && blank.json.role.perms["home.ask"] === true && !blank.json.role.perms["builder.open"]);
  await act({ action: "deleteRole", roleId: blank.json.role.id });
  await act({ action: "assign", roleId: customRoleId, subjectType: "user", subjectId: memberUser.id });
  const mr = (await perm()).json.me;
  check("roles add up: the template role brings Builder back", mr.roles.length === 2 && mr.keys.includes("builder.build") && (await createAs(MEMBER, "C37 via role")).status === 201);
  check("…without the template's risky switches", !mr.keys.includes("builder.cloud.sql") && !mr.keys.includes("builder.project.delete"));
  check("…and with its credit limit", mr.limits["builder.credits.monthly"] === 500);
  await act({ action: "unassign", roleId: customRoleId, subjectType: "user", subjectId: memberUser.id });
  check("taking the role away refuses again", (await createAs(MEMBER, "C37 unassigned")).status === 403);
  await call("/api/workspace/members-extra", { action: "saveGroup", name: "C37 group", members: [memberUser.id] });
  groupId = ((await call("/api/workspace/members-extra")).json.groups as { id: string; name: string }[]).find((g) => g.name === "C37 group")!.id;
  await act({ action: "assign", roleId: customRoleId, subjectType: "group", subjectId: groupId });
  check("a role given to a group applies to its members", (await createAs(MEMBER, "C37 via group")).status === 201);
  await act({ action: "unassign", roleId: customRoleId, subjectType: "group", subjectId: groupId });
  check("built-in roles can't be deleted", (await act({ action: "deleteRole", roleId: memberRoleId })).status === 400);
  await act({ action: "resetRole", roleId: memberRoleId });

  // ── Preview as
  const pv = await act({ action: "preview", roleId: guestRoleId });
  const cookie = pv.headers.get("set-cookie")?.match(/iotx_preview=[^;]+/)?.[0] ?? "";
  check("Preview as sets a preview cookie", pv.status === 200 && !!cookie);
  const PREVIEW = `${OWNER}; ${cookie}`;
  const pvMe = (await perm(PREVIEW)).json.me;
  check("previewing as Guest shows Guest's apps and switches", pvMe.preview?.name === "Guest" && !pvMe.keys.includes("builder.open") && pvMe.apps.includes("chat"));
  check("…and the server acts as Guest would", (await createAs(PREVIEW, "C37 preview")).status === 403);
  check("…while managing roles still works for the real owner", (await call("/api/permissions?admin=1", undefined, PREVIEW)).status === 200);
  check("a member can't preview roles", (await act({ action: "preview", roleId: ownerRoleId }, MEMBER)).status === 403);
  check("without the cookie the owner is back to everything", (await createAs(OWNER, "C37 owner again")).status === 201);

  // ── Owner always has everything
  check("the Owner role can't be changed", (await act({ action: "updateRole", roleId: ownerRoleId, set: { "builder.open": false } })).status === 400);
  const owner = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
  check("the owner can't be denied", (await act({ action: "override", userId: owner.id, key: "builder.publish", effect: "deny" })).status === 400);

  // ── Audit
  const changes = await db.auditEvent.count({ where: { workspaceId: ws.id, kind: "permissions.changed", createdAt: { gte: started } } });
  const refusals = await db.auditEvent.count({ where: { workspaceId: ws.id, kind: "permissions.refused", createdAt: { gte: started } } });
  check("every change is in the audit log", changes >= 10, `${changes}`);
  check("refusals are in the audit log too", refusals >= 1, `${refusals}`);

  // ── App pass
  const pass = await call("/api/iotx/pass?app=tally", undefined, MEMBER);
  check("a member gets a short-lived pass for Tally", pass.status === 200 && pass.json.expiresIn === 300 && pass.json.claims.keys.includes("tally.open"));
  const v = await call("/api/iotx/verify", { token: pass.json.token, app: "tally", keys: ["tally.voucher.sales.create", "tally.voucher.sales.delete"] }, "");
  check("apps verify the pass and get live decisions", v.status === 200 && v.json.valid && v.json.decisions["tally.voucher.sales.create"] === true && v.json.decisions["tally.voucher.sales.delete"] === false);
  check("a tampered pass is rejected", (await call("/api/iotx/verify", { token: pass.json.token.slice(0, -3) + "abc" }, "")).status === 401);
  check("no pass for an app the role can't open", (await call("/api/iotx/pass?app=admin", undefined, MEMBER)).status === 403);

  // ── Appearance
  const ap = await call("/api/account/appearance", { theme: "dark", accent: "custom", accentCustom: "#ffee00", shellBg: { kind: "color", color: "#202020", dim: 0 } }, MEMBER);
  check("appearance is saved to the account", ap.status === 200 && ap.json.appearance.theme === "dark" && ap.json.appearance.accentCustom === "#ffee00");
  const light = ap.json.paint.palettes.light as Record<string, string>;
  check("a too-light custom accent is darkened to read in the light theme", light["--accent"] !== "#ffee00" && light["--on-accent"] !== undefined);
  check("a bad colour is ignored", (await call("/api/account/appearance", { accentCustom: "red" }, MEMBER)).json.appearance.accentCustom === "#ffee00");
  await call("/api/account/appearance", { theme: "system", accent: "indigo", accentCustom: null, shellBg: { kind: "none" } }, MEMBER);
} finally {
  await act({ action: "preview", roleId: null });
  if (memberRoleId) await act({ action: "resetRole", roleId: memberRoleId });
  if (customRoleId) await act({ action: "deleteRole", roleId: customRoleId });
  for (const o of (await admin()).overrides) await act({ action: "removeOverride", id: o.id });
  if (groupId) await call("/api/workspace/members-extra", { action: "deleteGroup", id: groupId });
  for (const id of created) await call(`/api/projects/${id}?permanent=1`, undefined, OWNER, "DELETE");
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
