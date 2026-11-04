/**
 * Workspace security and account privacy: audit trail, verified domains and
 * invite restriction, workspace scan rules, preview-link policy, security
 * digest, device sign-in approval, sessions, scheduled account deletion,
 * site viewers, custom-domain routing and DNS status, and image compression.
 * Library checks use throwaway rows; HTTP checks need the server and a dev
 * session token, and put back any workspace setting they change.
 *   npx tsx scripts/test-security-admin.mts <devToken>
 */
import "dotenv/config";
import http from "node:http";
import sharp from "sharp";
import { db } from "../src/lib/db";
import {
  addDomain,
  blocks,
  buildDigest,
  inviteAllowed,
  removeDomain,
  rulesOf,
  sendDigest,
  txtRecord,
  verifyDomain,
} from "../src/lib/workspace-security";
import { decide, findPending, normalizeCode, poll, startDeviceAuth } from "../src/lib/device-auth";
import { cancelDeletion, deleteAccount, deletionImpact, runDueDeletions, scheduleDeletion } from "../src/lib/account";
import { domainStatus, CNAME_TARGET } from "../src/lib/domains";
import { canView } from "../src/lib/site-auth";
import { compressImage } from "../src/lib/image-compress";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const rnd = () => Math.random().toString(36).slice(2, 10);
const wsIds: string[] = [];
const userIds: string[] = [];
async function user(email = `t-${rnd()}@example.test`) {
  const u = await db.user.create({ data: { email } });
  userIds.push(u.id);
  return u;
}
async function workspace(ownerId: string) {
  const ws = await db.workspace.create({ data: { name: `Sec test ${rnd()}`, slug: `sec-${rnd()}` } });
  wsIds.push(ws.id);
  await db.membership.create({ data: { userId: ownerId, workspaceId: ws.id, role: "OWNER" } });
  return ws.id;
}
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

let devWs: { id: string; securityRules: unknown; previewSharing: string; verifiedDomains: unknown; inviteVerifiedOnly: boolean; securityDigestAt: Date | null } | null = null;
let pid = "";
const startedAt = new Date();
try {
  // ── Rules ──
  check("default rules block on high", rulesOf(null).blockPublishOn === "high" && rulesOf(null).disabledChecks.length === 0);
  check("unknown checks dropped from rules", rulesOf({ securityRules: { disabledChecks: ["nope"], blockPublishOn: "critical" } }).disabledChecks.length === 0);
  check("blocks(): high blocks CRITICAL and HIGH only", blocks("CRITICAL", "high") && blocks("HIGH", "high") && !blocks("MEDIUM", "high"));
  check("blocks(): critical lets HIGH through", !blocks("HIGH", "critical"));
  check("blocks(): medium blocks MEDIUM", blocks("MEDIUM", "medium") && !blocks("LOW", "medium"));

  // ── Domains ──
  const owner = await user();
  const ws = await workspace(owner.id);
  let refused = "";
  await addDomain(ws, "gmail.com").catch((e) => (refused = e.message));
  check("public email domains refused", /Public email/.test(refused));
  refused = "";
  await addDomain(ws, "not a domain").catch((e) => (refused = e.message));
  check("bad domain refused", /example.com/.test(refused));
  const d = await addDomain(ws, "Acme-Test.example");
  check("domain added, normalised", d.domain === "acme-test.example" && !d.verifiedAt);
  const miss = await verifyDomain(ws, d.domain, async () => [["something-else"]]);
  check("verify fails without the TXT record", !miss.verified);
  const hit = await verifyDomain(ws, d.domain, async () => [["v=spf1"], [txtRecord(d.token).slice(0, 20), txtRecord(d.token).slice(20)]]);
  check("verify passes with the (split) TXT record", hit.verified);
  const ws2 = await workspace(owner.id);
  refused = "";
  await addDomain(ws2, d.domain).catch((e) => (refused = e.message));
  check("a domain verified elsewhere can't be claimed", /Another workspace/.test(refused));
  await db.workspace.update({ where: { id: ws }, data: { inviteVerifiedOnly: true } });
  let w = await db.workspace.findUniqueOrThrow({ where: { id: ws } });
  check("invite restriction: verified domain allowed", inviteAllowed(w, "jo@acme-test.example"));
  check("invite restriction: other domains refused", !inviteAllowed(w, "jo@other.example"));
  await removeDomain(ws, d.domain);
  w = await db.workspace.findUniqueOrThrow({ where: { id: ws } });
  check("removing the last verified domain lifts the restriction", !w.inviteVerifiedOnly);

  // ── Digest ──
  const p = await db.project.create({ data: { workspaceId: ws, name: "Digest app", slug: `digest-${rnd()}`, subdomain: `dg-${rnd()}`, createdById: owner.id, publishedSha: "abc" } });
  await db.securityFinding.create({ data: { projectId: p.id, sha: "abc", rule: "test", severity: "CRITICAL", file: "x.ts", detail: "test" } });
  await db.auditEvent.create({ data: { workspaceId: ws, actorId: owner.id, kind: "member.invited", detail: "Invited someone" } });
  const dg = await buildDigest(ws);
  check("digest counts open critical findings", dg.findings.total === 1 && dg.findings.projects[0]?.name === "Digest app");
  check("digest lists published projects never scanned", dg.neverScanned.includes("Digest app"));
  check("digest includes this week's changes", dg.changes.some((c) => c.detail === "Invited someone"));
  await sendDigest(ws);
  const note = await db.notification.findFirst({ where: { userId: owner.id, kind: "security_digest" } });
  check("digest sent to owners", !!note && /1 open critical\/high finding/.test(note.body ?? ""), note?.body ?? "");

  // ── Device sign-in ──
  const dev = await startDeviceAuth("Forge desktop");
  check("device code format", /^[A-Z]{4}-[A-Z]{4}$/.test(dev.userCode));
  check("code lookup tolerates case and spacing", !!(await findPending(dev.userCode.toLowerCase().replace("-", " "))));
  check("normalizeCode", normalizeCode("bcdf ghjk") === "BCDF-GHJK");
  check("polling before approval: pending", (await poll(dev.deviceCode)).status === "pending");
  await decide(dev.userCode, owner.id, true);
  const got = await poll(dev.deviceCode);
  check("approved: device gets a session", got.status === "approved" && "sessionToken" in got && !!(await db.session.findUnique({ where: { sessionToken: got.sessionToken } })));
  check("session handed over once", (await poll(dev.deviceCode)).status === "expired");
  refused = "";
  await decide(dev.userCode, owner.id, true).catch((e) => (refused = e.message));
  check("a used code can't be approved again", /expired or was already used/.test(refused));
  const dev2 = await startDeviceAuth("CLI");
  await decide(dev2.userCode, owner.id, false);
  check("denied", (await poll(dev2.deviceCode)).status === "denied");
  const dev3 = await startDeviceAuth("Old");
  await db.deviceAuth.update({ where: { deviceCode: dev3.deviceCode }, data: { expiresAt: new Date(Date.now() - 1000) } });
  check("expired codes can't be found", !(await findPending(dev3.userCode)) && (await poll(dev3.deviceCode)).status === "expired");

  // ── Account deletion ──
  const leaver = await user();
  const solo = await workspace(leaver.id);
  await db.project.create({ data: { workspaceId: solo, name: "Solo app", slug: `solo-${rnd()}`, subdomain: `so-${rnd()}`, createdById: leaver.id } });
  const shared = await workspace(leaver.id);
  const heir = await user();
  await db.membership.create({ data: { userId: heir.id, workspaceId: shared, role: "ADMIN" } });
  const impact = await deletionImpact(leaver.id);
  check("impact: solo workspace deleted, shared handed over", impact.deleted.length === 1 && impact.deleted[0].projects === 1 && impact.handedOver.length === 1);
  const at = await scheduleDeletion(leaver.id);
  check("deletion scheduled 14 days out", Math.round((at.getTime() - Date.now()) / 86_400_000) === 14);
  await cancelDeletion(leaver.id);
  check("cancel clears it", !(await db.user.findUniqueOrThrow({ where: { id: leaver.id } })).deletionScheduledAt);
  await scheduleDeletion(leaver.id);
  check("not deleted before the date", (await runDueDeletions(new Date(), leaver.id)) === 0);
  const ran = await runDueDeletions(new Date(Date.now() + 15 * 86_400_000), leaver.id);
  check("deleted after the date", ran === 1 && !(await db.user.findUnique({ where: { id: leaver.id } })));
  check("solo workspace and its projects gone", !(await db.workspace.findUnique({ where: { id: solo } })) && (await db.project.count({ where: { workspaceId: solo } })) === 0);
  const heirRole = await db.membership.findFirst({ where: { workspaceId: shared, userId: heir.id } });
  check("shared workspace passed to the admin", heirRole?.role === "OWNER");
  void deleteAccount;

  // ── Site viewers ──
  const viewer = await user();
  const site = await db.project.create({ data: { workspaceId: ws, name: "Private site", slug: `ps-${rnd()}`, subdomain: `ps-${rnd()}`, createdById: owner.id, publishAudience: "private" } });
  check("stranger can't open a private site", !(await canView(site, viewer.id)));
  await db.siteViewer.create({ data: { projectId: site.id, email: viewer.email } });
  check("site viewer can open it", await canView(site, viewer.id));
  check("workspace owner can open it", await canView(site, owner.id));

  // ── Domain status ──
  const none = async () => [] as string[];
  const st1 = await domainStatus("www.example.test", { cname: async () => [`${CNAME_TARGET}.`], a: none });
  check("CNAME to the sites host: active", st1.status === "active" && st1.expected.type === "CNAME");
  const st2 = await domainStatus("www.example.test", { cname: none, a: none });
  check("no records: waiting for DNS", st2.status === "pending_dns");
  const st3 = await domainStatus("example.test", { cname: none, a: async () => ["203.0.113.9"] });
  check("apex pointing elsewhere: misconfigured, asks for an A record", st3.status === "misconfigured" && st3.expected.type === "A");

  // ── Image compression ──
  const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 200, g: 80, b: 40 } } }).jpeg({ quality: 100 }).toBuffer();
  const small = await compressImage(big, "image/jpeg");
  const dims = small ? await sharp(small).metadata() : null;
  check("big image shrunk to 2560px", !!dims && Math.max(dims.width ?? 0, dims.height ?? 0) === 2560, `${dims?.width}x${dims?.height}`);
  const tiny = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#fff" } }).png().toBuffer();
  check("small images left alone", (await compressImage(tiny, "image/png")) === null);
  check("other types left alone", (await compressImage(Buffer.from("<svg/>"), "image/svg+xml")) === null);

  // ── HTTP ──
  if (token) {
    const created = await fetch(`${BASE}/api/projects`, json("POST", { name: "Security admin test", force: true }));
    pid = ((await created.json()) as { project: { id: string } }).project.id;
    const proj = await db.project.findUniqueOrThrow({ where: { id: pid }, select: { workspaceId: true } });
    devWs = await db.workspace.findUniqueOrThrow({
      where: { id: proj.workspaceId },
      select: { id: true, securityRules: true, previewSharing: true, verifiedDomains: true, inviteVerifiedOnly: true, securityDigestAt: true },
    });

    const sec = await fetch(`${BASE}/api/workspace/security`, { headers: { cookie } });
    const sb = await sec.json();
    check("security settings load", sec.ok && !!sb.digest && Array.isArray(sb.checks) && Array.isArray(sb.log), String(sec.status));

    await fetch(`${BASE}/api/workspace/security`, json("POST", { action: "previewSharing", previewSharing: "password" }));
    const noPw = await fetch(`${BASE}/api/projects/${pid}/preview-links`, json("POST", { name: "Review" }));
    check("password policy: link without a password refused", noPw.status === 400);
    const withPw = await fetch(`${BASE}/api/projects/${pid}/preview-links`, json("POST", { name: "Review", password: "secret123" }));
    check("password policy: link with a password allowed", withPw.status === 201);
    await fetch(`${BASE}/api/workspace/security`, json("POST", { action: "previewSharing", previewSharing: "off" }));
    check("off: no preview links", (await fetch(`${BASE}/api/projects/${pid}/preview-links`, json("POST", { name: "R", password: "secret123" }))).status === 403);
    check("bad policy value refused", (await fetch(`${BASE}/api/workspace/security`, json("POST", { action: "previewSharing", previewSharing: "x" }))).status === 400);

    const rules = await (await fetch(`${BASE}/api/workspace/security`, json("POST", { action: "rules", blockPublishOn: "critical", disabledChecks: [sb.checks[0].id] }))).json();
    check("rules saved", rules.rules?.blockPublishOn === "critical" && rules.rules.disabledChecks.length === 1);
    check("invite restriction needs a verified domain", (await fetch(`${BASE}/api/workspace/security`, json("POST", { action: "inviteVerifiedOnly", on: true }))).status === 400 || !!(devWs.verifiedDomains as unknown[] | null)?.length);

    await db.workspace.update({ where: { id: devWs.id }, data: { verifiedDomains: [{ domain: "forge-test.example", token: "t", verifiedAt: new Date().toISOString() }], inviteVerifiedOnly: true } });
    const badInvite = await fetch(`${BASE}/api/workspace/members`, json("POST", { email: `x-${rnd()}@elsewhere.example` }));
    check("members: outside-domain invite refused", badInvite.status === 403 && /verified-domain/.test((await badInvite.json()).error ?? ""));
    const badCollab = await fetch(`${BASE}/api/projects/${pid}/collaborators`, json("POST", { email: `x-${rnd()}@elsewhere.example` }));
    check("collaborators: outside-domain invite refused", badCollab.status === 403);
    const badViewer = await fetch(`${BASE}/api/projects/${pid}/site-viewers`, json("POST", { email: `x-${rnd()}@elsewhere.example` }));
    check("site viewers: outside-domain refused", badViewer.status === 403);
    await db.workspace.update({ where: { id: devWs.id }, data: { inviteVerifiedOnly: false } });
    const addViewer = await fetch(`${BASE}/api/projects/${pid}/site-viewers`, json("POST", { email: "viewer@forge-test.example" }));
    const av = await addViewer.json();
    check("site viewer added", addViewer.status === 201);
    await fetch(`${BASE}/api/projects/${pid}/publish`, json("PATCH", { audience: "private" }));
    const sv = await (await fetch(`${BASE}/api/projects/${pid}/site-viewers`, { headers: { cookie } })).json();
    check("site members list: inherited + site only", sv.inherited.length >= 1 && sv.viewers.some((v: { email: string }) => v.email === "viewer@forge-test.example"));
    check("site viewer removed", (await fetch(`${BASE}/api/projects/${pid}/site-viewers`, json("DELETE", { viewerId: av.id }))).ok);

    const log = await (await fetch(`${BASE}/api/workspace/security`, { headers: { cookie } })).json();
    const kinds = log.log.map((e: { detail: string }) => e.detail).join(" | ");
    check("audit trail records the changes", /Preview links: password required/.test(kinds) && /Publishing blocked on critical/.test(kinds) && /open the published/.test(kinds), kinds.slice(0, 160));

    // Device sign-in over HTTP, then revoking that session.
    const start = await (await fetch(`${BASE}/api/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"clientName":"Test CLI"}' })).json();
    check("device start is public and returns a verify URL", /\/device\?code=/.test(start.verifyUrl ?? ""));
    const look = await (await fetch(`${BASE}/api/device/approve?code=${start.userCode}`, { headers: { cookie } })).json();
    check("approval page sees which device", look.clientName === "Test CLI");
    check("signed-out approval refused", (await fetch(`${BASE}/api/device/approve`, { method: "POST", body: "{}" })).status === 401);
    await fetch(`${BASE}/api/device/approve`, json("POST", { code: start.userCode, approve: true }));
    const pr = await (await fetch(`${BASE}/api/device/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: start.deviceCode }) })).json();
    check("device receives a working session", pr.status === "approved" && (await fetch(`${BASE}/api/account`, { headers: { cookie: `authjs.session-token=${pr.sessionToken}` } })).ok);
    const acct = await (await fetch(`${BASE}/api/account`, { headers: { cookie } })).json();
    const deviceSessionId = (await db.session.findUnique({ where: { sessionToken: pr.sessionToken } }))?.id;
    const deviceSession = acct.sessions.find((s: { current: boolean; id: string }) => !s.current && s.id === deviceSessionId);
    check("sessions list marks this browser", acct.sessions.some((s: { current: boolean }) => s.current));
    await fetch(`${BASE}/api/account`, json("POST", { action: "revokeSession", id: deviceSession?.id }));
    check("revoked session stops working", (await fetch(`${BASE}/api/account`, { headers: { cookie: `authjs.session-token=${pr.sessionToken}` } })).status === 401);
    check("deletion needs the email typed", (await fetch(`${BASE}/api/account`, json("POST", { action: "scheduleDeletion", confirm: "nope" }))).status === 400);

    // Custom domain routing reaches the hosted route (nothing published there).
    await db.project.update({ where: { id: pid }, data: { customDomain: `app-${rnd()}.example.test` } });
    const host = (await db.project.findUniqueOrThrow({ where: { id: pid } })).customDomain!;
    // fetch() won't send a custom Host header, so ask with node:http.
    const viaDomain = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: "localhost", port: 3000, path: "/", headers: { host } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on("error", reject);
    });
    check("custom domain host is served as a site", viaDomain.status === 404 && viaDomain.body.includes("Nothing published here"), String(viaDomain.status));
    const ds = await (await fetch(`${BASE}/api/projects/${pid}/domain`, { headers: { cookie } })).json();
    check("domain status route", ds.domain === host && ["pending_dns", "misconfigured"].includes(ds.status));
    const editor = await fetch(`${BASE}/login`);
    check("editor host still the editor", editor.ok && (await editor.text()).toLowerCase().includes("forge"));

    // Upload compression end to end.
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(big)], { type: "image/jpeg" }), "big.jpg");
    const up = await (await fetch(`${BASE}/api/projects/${pid}/uploads`, { method: "POST", headers: { cookie }, body: form })).json();
    const a = up.attachments?.[0];
    check("uploaded photo compressed, original kept", !!a?.originalSize && a.size < a.originalSize, `${a?.size} < ${a?.originalSize}`);
  }
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (devWs) {
    await db.workspace.update({
      where: { id: devWs.id },
      data: {
        securityRules: devWs.securityRules ?? undefined,
        previewSharing: devWs.previewSharing,
        verifiedDomains: devWs.verifiedDomains ?? undefined,
        inviteVerifiedOnly: devWs.inviteVerifiedOnly,
        securityDigestAt: devWs.securityDigestAt,
      },
    });
    if (devWs.securityRules == null) await db.$executeRaw`UPDATE workspaces SET "securityRules" = NULL WHERE id = ${devWs.id}`;
    if (devWs.verifiedDomains == null) await db.$executeRaw`UPDATE workspaces SET "verifiedDomains" = NULL WHERE id = ${devWs.id}`;
    // The test's own audit entries stay out of the real trail.
    await db.auditEvent.deleteMany({ where: { workspaceId: devWs.id, createdAt: { gte: startedAt } } });
  }
  if (pid) {
    await db.siteViewer.deleteMany({ where: { projectId: pid } });
    const del = await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
    check("test project deleted", del.ok, String(del.status));
  }
  await db.deviceAuth.deleteMany({ where: { createdAt: { gte: startedAt } } });
  for (const id of wsIds) {
    const ps = await db.project.findMany({ where: { workspaceId: id }, select: { id: true } });
    await db.siteViewer.deleteMany({ where: { projectId: { in: ps.map((x) => x.id) } } });
    await db.auditEvent.deleteMany({ where: { workspaceId: id } });
    await db.workspace.deleteMany({ where: { id } });
  }
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
