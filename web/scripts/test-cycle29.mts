/**
 * "Continue with Forge" for app users (consent, codes bound to the app's
 * address, single use, turned off), the login page refusing outside
 * redirects, SCIM provisioning (create, filter, group roles, deprovision,
 * owners protected, token rotation, welcome email) and access-request emails.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle29.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT!;
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0";
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
const call = async (p: string, body?: unknown, c = cookie, method?: string) => {
  const r = await fetchRetry(`${BASE}${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie: c, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const outbox = async () => (await fs.readFile(path.join(ROOT, "_forge", "outbox.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string });
let pid = "";
const scimEmails: string[] = [];

try {
  // ── Continue with Forge
  pid = ((await call("/api/projects", { name: "C29 member portal", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const p = await db.project.findUniqueOrThrow({ where: { id: pid }, select: { subdomain: true } });
  const site = `http://${p.subdomain}.localhost:3000`;
  const page = await fetchRetry(`${BASE}/oauth/forge?project=${pid}&redirect_uri=${encodeURIComponent(site + "/account")}&state=s1`, { headers: { cookie } });
  const html = await page.text();
  check("the consent page names the app and the email it will share", page.status === 200 && html.includes("Sign in to") && html.includes("C29 member portal") && html.includes("dev@localhost"));
  const evil = await (await fetchRetry(`${BASE}/oauth/forge?project=${pid}&redirect_uri=${encodeURIComponent("https://evil.example/")}&state=s1`, { headers: { cookie } })).text();
  check("requests sending people to another address are stopped", evil.includes("address the app doesn"));
  const anon = await fetchRetry(`${BASE}/oauth/forge?project=${pid}&redirect_uri=${encodeURIComponent(site)}`, { redirect: "manual" });
  check("signed-out people are sent to log in first, then back", anon.status >= 300 && anon.status < 400 && /\/login\?redirect=%2Foauth%2Fforge/.test(anon.headers.get("location") ?? ""), anon.headers.get("location") ?? "");
  check("a code can't be issued for an outside address", (await call("/api/oauth/forge", { projectId: pid, redirectUri: "https://evil.example/" })).status === 400);
  const code = (await call("/api/oauth/forge", { projectId: pid, redirectUri: site + "/account" })).json.code as string;
  const exchange = (c: string, origin = site) =>
    fetchRetry(`${BASE}/cloud/v1/${pid}/auth/forge`, { method: "POST", headers: { apikey: anonKey, origin, "user-agent": UA, "content-type": "application/json" }, body: JSON.stringify({ code: c }) });
  const ok = await exchange(code);
  const okJson = (await ok.json()) as { user: { email: string }; token: string };
  check("the app trades the code for a session as that person", ok.status === 200 && okJson.user.email === "dev@localhost" && !!okJson.token);
  check("a code works once", (await exchange(code)).status === 401);
  const code2 = (await call("/api/oauth/forge", { projectId: pid, redirectUri: site + "/account" })).json.code as string;
  check("a code only works from the address it was made for", (await exchange(code2, "https://evil.example")).status === 401);
  await call(`/api/projects/${pid}/cloud/admin`, { action: "setAuth", auth: { forge: false } });
  check("with Continue with Forge off, no codes are issued", (await call("/api/oauth/forge", { projectId: pid, redirectUri: site })).status === 403);

  // ── Login redirect (IOTx Suite lands on /home since cycle 37)
  const lr = await fetchRetry(`${BASE}/login?redirect=${encodeURIComponent("https://evil.example/phish")}`, { headers: { cookie }, redirect: "manual" });
  check("the login page won't redirect to outside sites", (lr.headers.get("location") ?? "").endsWith("/home"), lr.headers.get("location") ?? "");
  const lr2 = await fetchRetry(`${BASE}/login?redirect=${encodeURIComponent("//evil.example")}`, { headers: { cookie }, redirect: "manual" });
  check("including protocol-relative ones", (lr2.headers.get("location") ?? "").endsWith("/home"));

  // ── SCIM
  const tok = (await call("/api/workspace/scim", { action: "rotate" })).json.token as string;
  await call("/api/workspace/scim", { action: "settings", defaultRole: "MEMBER", groupRoles: { "IT Admins": "ADMIN" }, welcomeEmail: true });
  const scim = (p2: string, method = "GET", body?: unknown, t = tok) =>
    fetchRetry(`${BASE}/scim/v2/${p2}`, { method, headers: { authorization: `Bearer ${t}`, "content-type": "application/scim+json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  check("SCIM needs the token", (await fetchRetry(`${BASE}/scim/v2/Users`)).status === 401);
  check("it describes itself", (((await (await scim("ServiceProviderConfig")).json()) as { patch: { supported: boolean } }).patch.supported) === true);
  const email = `scim-${Date.now().toString(36)}@example.com`;
  scimEmails.push(email);
  const before = (await outbox()).length;
  const created = await scim("Users", "POST", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: email, name: { givenName: "Sam", familyName: "Lee" }, active: true });
  const u = (await created.json()) as { id: string; active: boolean };
  const ws = (await call("/api/workspace")).json.workspace as { id: string };
  const role = async () => (await db.membership.findUnique({ where: { userId_workspaceId: { userId: u.id, workspaceId: ws.id } } }))?.role ?? null;
  check("the identity provider can add a person, with the default role", created.status === 201 && (await role()) === "MEMBER");
  const mail = (await outbox()).slice(before).find((m) => m.to === email);
  check("they get a welcome email", !!mail && /added to/.test(mail.subject));
  const found = (await (await scim(`Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`)).json()) as { totalResults: number };
  check("people can be found by userName", found.totalResults === 1);
  check("adding them twice is a conflict", (await scim("Users", "POST", { userName: email })).status === 409);
  const g = (await (await scim("Groups", "POST", { displayName: "IT Admins", members: [{ value: u.id }] })).json()) as { id: string };
  check("a mapped group raises their role", (await role()) === "ADMIN");
  await scim(`Groups/${g.id}`, "PATCH", { Operations: [{ op: "remove", path: `members[value eq "${u.id}"]` }] });
  check("leaving the group drops it back", (await role()) === "MEMBER");
  await scim(`Users/${u.id}`, "PATCH", { Operations: [{ op: "replace", value: { active: false } }] });
  check("deactivating removes them from the workspace", (await role()) === null);
  const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
  check("owners can't be removed by provisioning", (await scim(`Users/${dev.id}`, "DELETE")).status === 400);
  await scim(`Groups/${g.id}`, "DELETE");
  const tok2 = (await call("/api/workspace/scim", { action: "rotate" })).json.token as string;
  check("rotating the token retires the old one", (await scim("Users", "GET", undefined, tok)).status === 401 && (await scim("Users", "GET", undefined, tok2)).status === 200);
  await call("/api/workspace/scim", { action: "disable" });
  check("turning provisioning off stops it", (await scim("Users", "GET", undefined, tok2)).status === 401);

  // ── Access request emails
  const restricted = ((await call("/api/projects", { name: "C29 private", force: true })).json.project as { id: string }).id;
  await db.project.update({ where: { id: restricted }, data: { restricted: true } });
  const req = (await call(`/api/projects/${restricted}/access-requests`, { kind: "edit" }, `authjs.session-token=${users["outsider@localhost"]}`)).json as { request?: { id: string }; id?: string };
  const reqId = req.request?.id ?? req.id ?? (await db.accessRequest.findFirst({ where: { projectId: restricted } }))!.id;
  const n = (await outbox()).length;
  await call(`/api/projects/${restricted}/access-requests`, { requestId: reqId, decision: "approve" }, cookie, "PATCH");
  check("the requester gets an email with the outcome", (await outbox()).slice(n).some((m) => m.to === "outsider@localhost" && /You can now edit/.test(m.subject)));
  await fetch(`${BASE}/api/projects/${restricted}?permanent=1`, { method: "DELETE", headers: { cookie } });
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const e of scimEmails) await db.user.deleteMany({ where: { email: e } }).catch(() => undefined);
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
