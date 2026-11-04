/**
 * "Sign-in only" preview links (members and verified domains, via the
 * editor handshake), the signup handler with a referral, the self-host
 * download and the source export's manifest, and private repository import
 * errors. Restores the workspace's preview-link policy afterwards.
 *   npx tsx scripts/test-cycle19.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import http from "node:http";
import JSZip from "jszip";
import { db } from "../src/lib/db";
import { onNewUser } from "../src/lib/signup";
import { REFERRAL_BONUS } from "../src/lib/referrals";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
/** A request with a Host header and no redirect following. */
function raw(host: string, path: string, c = "") {
  return new Promise<{ status: number; location?: string; setCookie?: string[]; body: string }>((ok, bad) => {
    http
      .get({ host: "127.0.0.1", port: 3000, path, headers: { host, ...(c ? { cookie: c } : {}) } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => ok({ status: res.statusCode ?? 0, location: res.headers.location, setCookie: res.headers["set-cookie"], body }));
      })
      .on("error", bad);
  });
}
const projects: string[] = [];
let wsId = "";
let policyBefore = "anyone";
let newUserId = "";

try {
  const mk = async (name: string) => {
    const id = ((await (await fetch(`${BASE}/api/projects`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name, force: true }) })).json()) as { project: { id: string } }).project.id;
    projects.push(id);
    return id;
  };

  // ── Sign-in only preview links ──
  const pid = await mk("Cycle 19 preview");
  wsId = (await db.project.findUniqueOrThrow({ where: { id: pid } })).workspaceId;
  policyBefore = (await db.workspace.findUniqueOrThrow({ where: { id: wsId } })).previewSharing;
  const set = async (v: string) =>
    (await fetch(`${BASE}/api/workspace/security`, { method: "POST", headers: { cookie: `${cookie}; forge_ws=${wsId}`, "content-type": "application/json" }, body: JSON.stringify({ action: "previewSharing", previewSharing: v }) })).status;
  check("the Sign-in only policy can be chosen", (await set("signin")) === 200);
  const link = (await (await fetch(`${BASE}/api/projects/${pid}/preview-links`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Review" }) })).json()) as { url?: string };
  const t = /preview--([a-z0-9]+)\./.exec(link.url ?? "")?.[1] ?? "";
  check("links can still be created", !!t, JSON.stringify(link).slice(0, 120));
  const host = `preview--${t}.localhost:3000`;
  const anon = await raw(host, "/about?x=1");
  check("an anonymous visitor is sent to sign in", anon.status === 302 && !!anon.location?.includes(`/api/preview-auth?token=${t}`) && anon.location.includes(encodeURIComponent("/about?x=1")), anon.location);
  const hand = await fetch(`${BASE}/api/preview-auth?token=${t}&next=/`, { headers: { cookie }, redirect: "manual" });
  const back = hand.headers.get("location") ?? "";
  check("a member is handed back with a short token", hand.status === 302 && back.startsWith(`http://preview--${t}.`) && back.includes("/__forge/auth?token="), back.slice(0, 120));
  const finish = await raw(host, new URL(back).pathname + new URL(back).search);
  const viewer = (finish.setCookie ?? []).find((c) => c.startsWith("forge_preview_viewer="))?.split(";")[0] ?? "";
  check("the handshake sets the viewer cookie", finish.status === 302 && !!viewer);
  const page = await raw(host, "/", viewer);
  check("then the preview opens", page.status === 200 && /<html/i.test(page.body), `${page.status}`);
  const outsider = await fetch(`${BASE}/api/preview-auth?token=${t}&next=/`, { headers: { cookie: `authjs.session-token=${users["outsider@localhost"]}` }, redirect: "manual" });
  check("someone outside the workspace and its domains is refused", outsider.status === 403, String(outsider.status));
  check("a forged viewer cookie is ignored", (await raw(host, "/", "forge_preview_viewer=abc.def.ghi")).status === 302);
  await set("anyone");
  check("back on Anyone with the link, no sign-in is needed", (await raw(host, "/")).status === 200);

  // ── Signup handler with a referral ──
  const referrer = (await db.session.findUniqueOrThrow({ where: { sessionToken: token } })).userId;
  const refWs = (await db.membership.findFirstOrThrow({ where: { userId: referrer, role: "OWNER" }, orderBy: { createdAt: "asc" } })).workspaceId;
  const refBefore = (await db.workspace.findUniqueOrThrow({ where: { id: refWs } })).creditBalance;
  const u = await db.user.create({ data: { email: `referred-${Date.now()}@example.test`, name: "Referred Person" } });
  newUserId = u.id;
  const r = await onNewUser(u, referrer);
  const newWs = await db.workspace.findUniqueOrThrow({ where: { id: r.workspaceId }, include: { memberships: true } });
  check("signup creates the person's workspace with them as owner", newWs.memberships.some((m) => m.userId === u.id && m.role === "OWNER") && newWs.name === "Referred Person's workspace");
  check("a referral credits both sides", r.referred && newWs.creditBalance >= REFERRAL_BONUS && (await db.workspace.findUniqueOrThrow({ where: { id: refWs } })).creditBalance === refBefore + REFERRAL_BONUS);
  check("the referrer is told", !!(await db.notification.findFirst({ where: { userId: referrer, kind: "referral" }, orderBy: { createdAt: "desc" } })));
  const self = await db.user.create({ data: { email: `self-${Date.now()}@example.test` } });
  check("self-referral doesn't pay", !(await onNewUser(self, self.id)).referred);
  await db.workspace.deleteMany({ where: { memberships: { some: { userId: self.id } } } });
  await db.user.delete({ where: { id: self.id } });
  const loginRef = await fetch(`${BASE}/login?ref=${referrer}`, { redirect: "manual" });
  check("a Share Forge link remembers the referrer until signup", (loginRef.headers.get("set-cookie") ?? "").includes(`forge_ref=${referrer}`));
  // Undo the test's own referral credit.
  await db.workspace.update({ where: { id: refWs }, data: { creditBalance: { decrement: REFERRAL_BONUS } } });

  // ── Self-host download and source export ──
  const unpublished = await fetch(`${BASE}/api/projects/${pid}/export?target=selfhost`, { headers: { cookie } });
  check("self-host needs a published build", unpublished.status === 409);
  const src = await JSZip.loadAsync(await (await fetch(`${BASE}/api/projects/${pid}/export`, { headers: { cookie } })).arrayBuffer());
  const pkg = JSON.parse(await src.file("package.json")!.async("string"));
  check("the source export keeps the project's own package.json", !!pkg.dependencies?.["react-router-dom"], Object.keys(pkg.dependencies ?? {}).slice(0, 6).join(","));
  const pub = await fetch(`${BASE}/api/projects/${pid}/publish`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "publish" }) });
  const last = (await pub.text()).split("\n\n").filter((p) => p.startsWith("data: ")).map((p) => JSON.parse(p.slice(6))).at(-1);
  check("published", last?.type === "published", JSON.stringify(last).slice(0, 100));
  const site = await JSZip.loadAsync(await (await fetch(`${BASE}/api/projects/${pid}/export?target=selfhost`, { headers: { cookie } })).arrayBuffer());
  const names = Object.keys(site.files);
  check("the download has the build, a Dockerfile, nginx config and a README", names.includes("dist/index.html") && names.some((n) => n.startsWith("dist/assets/")) && names.includes("Dockerfile") && names.includes("nginx.conf") && names.includes("README.md"), names.slice(0, 8).join(", "));
  check("nginx sends app routes to index.html", (await site.file("nginx.conf")!.async("string")).includes("try_files $uri $uri/ /index.html"));

  // ── Private repository import ──
  const imp = async (body: unknown) => (await (await fetch(`${BASE}/api/projects/import`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { error?: string; project?: { id: string } };
  const priv = await imp({ source: "github", url: "https://github.com/forge-test-nonexistent-org/private-repo-xyz" });
  check("a private (or missing) repo explains how to get in", /private or doesn't exist.*token/i.test(priv.error ?? ""), priv.error);
  const bad = await imp({ source: "github", url: "https://github.com/forge-test-nonexistent-org/private-repo-xyz", token: "ghp_notARealToken000000000000000000000000" });
  check("a token that can't read it says so", /with the token/i.test(bad.error ?? ""), bad.error);
  const pubRepo = await imp({ source: "github", url: "https://github.com/octocat/Hello-World" });
  if (pubRepo.project) projects.push(pubRepo.project.id);
  check("public repos still import", !!pubRepo.project, pubRepo.error);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (wsId) await db.workspace.update({ where: { id: wsId }, data: { previewSharing: policyBefore } });
  if (newUserId) {
    await db.workspace.deleteMany({ where: { memberships: { some: { userId: newUserId } } } });
    await db.user.delete({ where: { id: newUserId } }).catch(() => undefined);
  }
  for (const id of projects) await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
