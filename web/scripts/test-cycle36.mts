/**
 * SSO with OIDC against a mock identity provider run by this test: setup
 * checked against discovery, PKCE sign-in that joins the workspace, group →
 * role, allowed groups, wrong domain and tampered state refused, health
 * failures surfacing in the action center.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle36.mts <devToken>
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT!;
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (p: string, body?: unknown, c = cookie) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie: c } } : { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};

// ── The mock identity provider
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
let who = { email: "ana@sso-test.dev", groups: [] as string[] };
const codes = new Map<string, { nonce: string; challenge: string; email: string; groups: string[] }>();
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const issuer = `http://127.0.0.1:${port}`;
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  if (u.pathname === "/.well-known/openid-configuration") {
    return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, scopes_supported: ["openid", "email", "profile"] });
  }
  if (u.pathname === "/jwks") return json({ keys: [jwk] });
  if (u.pathname === "/authorize") {
    const code = crypto.randomUUID();
    codes.set(code, { nonce: u.searchParams.get("nonce")!, challenge: u.searchParams.get("code_challenge")!, ...who });
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", u.searchParams.get("state")!);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (u.pathname === "/token") {
    let body = "";
    for await (const ch of req) body += ch;
    const p = new URLSearchParams(body);
    const c = codes.get(p.get("code") ?? "");
    codes.delete(p.get("code") ?? "");
    const verifierOk = c && crypto.createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") === c.challenge;
    if (!c || !verifierOk || p.get("client_secret") !== "s3cret" || p.get("client_id") !== "forge-test") return json({ error: "invalid_grant" }, 400);
    const idToken = await new SignJWT({ email: c.email, email_verified: true, nonce: c.nonce, groups: c.groups, name: "Ana SSO" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience("forge-test")
      .setSubject(c.email)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return json({ id_token: idToken, access_token: "x", token_type: "Bearer" });
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

/** The whole browser dance: start → IdP → callback. Returns where it ends and the session cookie. */
async function signIn(email: string, tamper = false) {
  const start = await fetch(`${BASE}/api/sso/start?email=${encodeURIComponent(email)}`, { redirect: "manual" });
  const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
  const loc = start.headers.get("location") ?? "";
  if (!loc.startsWith("http://127.0.0.1")) return { end: loc, session: null };
  const idp = await fetch(loc, { redirect: "manual" });
  let cb = idp.headers.get("location")!;
  if (tamper) cb = cb.replace(/state=[^&]+/, "state=forged");
  const done = await fetch(cb, { redirect: "manual", headers: { cookie: stateCookie } });
  const set = done.headers.getSetCookie?.() ?? [];
  const session = set.find((c) => c.startsWith("authjs.session-token="))?.split(";")[0] ?? null;
  const ws = set.find((c) => c.startsWith("forge_ws="))?.split(";")[0] ?? "";
  return { end: done.headers.get("location") ?? "", session: session ? `${session}; ${ws}` : null };
}

const ws = (await call("/api/workspace")).json.workspace as { id: string };
const before = await db.workspace.findUniqueOrThrow({ where: { id: ws.id }, select: { verifiedDomains: true } });

try {
  const domains = (Array.isArray(before.verifiedDomains) ? before.verifiedDomains : []) as object[];
  await db.workspace.update({ where: { id: ws.id }, data: { verifiedDomains: [...domains, { domain: "sso-test.dev", token: "t", verifiedAt: new Date().toISOString() }] } });

  check("SSO needs a verified domain", (await call("/api/workspace/sso", { domain: "nope.dev", issuer: `http://127.0.0.1:${port}`, clientId: "forge-test", clientSecret: "s3cret" })).status === 400);
  check("and the openid scope", (await call("/api/workspace/sso", { domain: "sso-test.dev", issuer: `http://127.0.0.1:${port}`, clientId: "forge-test", clientSecret: "s3cret", scopes: "email" })).status === 400);
  const saved = await call("/api/workspace/sso", { domain: "sso-test.dev", issuer: `http://127.0.0.1:${port}`, clientId: "forge-test", clientSecret: "s3cret", groupRoles: { "IT Admins": "ADMIN" } });
  check("setup is checked against the provider", saved.status === 200 && saved.json.check?.ok === true, JSON.stringify(saved.json));
  check("the client secret is never sent back", (await call("/api/workspace/sso")).json.config.clientSecret === "set");

  const a = await signIn("ana@sso-test.dev");
  check("signing in with SSO lands on IOTx Suite Home with a session", a.end === "/home" && !!a.session, a.end);
  const me = (await call("/api/workspace", undefined, a.session!)).json.workspace as { id: string };
  const ana = await db.user.findUniqueOrThrow({ where: { email: "ana@sso-test.dev" } });
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: ana.id, workspaceId: ws.id } } });
  check("and joins the workspace automatically", me.id === ws.id && m?.role === "MEMBER");

  who = { email: "ben@sso-test.dev", groups: ["IT Admins"] };
  await signIn("ben@sso-test.dev");
  const ben = await db.user.findUniqueOrThrow({ where: { email: "ben@sso-test.dev" } });
  check("an IdP group maps to a role", (await db.membership.findUnique({ where: { userId_workspaceId: { userId: ben.id, workspaceId: ws.id } } }))?.role === "ADMIN");

  await call("/api/workspace/sso", { domain: "sso-test.dev", issuer: `http://127.0.0.1:${port}`, clientId: "forge-test", allowedGroups: ["Engineering"], groupRoles: { "IT Admins": "ADMIN" } });
  who = { email: "cy@sso-test.dev", groups: ["Sales"] };
  const cy = await signIn("cy@sso-test.dev");
  check("with allowed groups, others can't sign in", cy.end.startsWith("/login?sso_error=") && !cy.session && /group/.test(decodeURIComponent(cy.end)));
  who = { email: "eve@elsewhere.com", groups: ["Engineering"] };
  const eve = await signIn("ana@sso-test.dev");
  check("an account from another domain is refused", eve.end.startsWith("/login?sso_error=") && /sso-test\.dev/.test(decodeURIComponent(eve.end)));
  who = { email: "dan@sso-test.dev", groups: ["Engineering"] };
  check("a forged state is refused", (await signIn("dan@sso-test.dev", true)).end.startsWith("/login?sso_error="));
  check("unknown domains get a clear message", (await signIn("x@unknown-domain.dev")).end.includes("sso_error"));

  server.close();
  const bad = (await call("/api/workspace/sso", { action: "check" })).json.check as { ok: boolean };
  const anomalies = (await call("/api/workspace/action-center")).json.anomalies as { title: string }[];
  check("when the provider can't be reached, the action center says so", bad.ok === false && anomalies.some((x) => /SSO/.test(x.title)));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  server.close();
  await fs.rm(path.join(ROOT, "_forge", "sso", `${ws.id}.json`), { force: true });
  await db.workspace.update({ where: { id: ws.id }, data: { verifiedDomains: before.verifiedDomains ?? [] } });
  for (const e of ["ana@sso-test.dev", "ben@sso-test.dev", "cy@sso-test.dev", "dan@sso-test.dev"]) {
    const u = await db.user.findUnique({ where: { email: e }, include: { memberships: true } });
    if (!u) continue;
    for (const m of u.memberships) if (m.workspaceId !== ws.id && m.role === "OWNER") await db.workspace.delete({ where: { id: m.workspaceId } }).catch(() => undefined);
    await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
  }
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
