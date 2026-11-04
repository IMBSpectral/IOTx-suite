/**
 * SSO with SAML 2.0 against a mock identity provider run by this test, which
 * signs real assertions with a self-signed certificate: setup and certificate
 * checks, SP metadata, sign-in that joins the workspace, group → role, and
 * refusals for a replayed response, the wrong signing key, the wrong audience,
 * an expired assertion, a tampered RelayState and another domain; a
 * certificate about to expire surfaces in the action center.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle44.mts <devToken>
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import selfsigned from "selfsigned";
import { SignedXml } from "xml-crypto";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const ORIGIN = process.env.EDITOR_ORIGIN ?? BASE;
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

// ── The mock identity provider ────────────────────────────────────────────

const IDP = "https://idp.saml-test.dev/metadata";
const SSO_URL = "https://idp.saml-test.dev/sso";
const SP = `${ORIGIN}/api/sso/saml/metadata`;
const ACS = `${ORIGIN}/api/sso/saml/acs`;
const pem = (days: number) => selfsigned.generate([{ name: "commonName", value: "idp.saml-test.dev" }], { days, keySize: 2048, algorithm: "sha256" });
const idpKeys = pem(365);
const rogueKeys = pem(365);
const iso = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, "Z");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function samlResponse(o: { inResponseTo: string; email: string; groups?: string[]; name?: string; audience?: string; keys?: typeof idpKeys; expired?: boolean }) {
  const now = o.expired ? -60 * 60_000 : 0;
  const notAfter = iso(now + 5 * 60_000);
  const attrs = [
    `<saml:Attribute Name="displayName"><saml:AttributeValue>${esc(o.name ?? "")}</saml:AttributeValue></saml:Attribute>`,
    o.groups?.length ? `<saml:Attribute Name="groups">${o.groups.map((g) => `<saml:AttributeValue>${esc(g)}</saml:AttributeValue>`).join("")}</saml:Attribute>` : "",
  ].join("");
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomUUID()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${ACS}" InResponseTo="${o.inResponseTo}">` +
    `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="_a${crypto.randomUUID()}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(o.email)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo}" NotOnOrAfter="${notAfter}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${notAfter}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  const keys = o.keys ?? idpKeys;
  const sig = new SignedXml({ privateKey: keys.private, publicCert: keys.cert, canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#", signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
  return Buffer.from(sig.getSignedXml()).toString("base64");
}

/** Start at our sign-in, read the AuthnRequest the IdP would receive. */
async function start(email: string) {
  const r = await fetch(`${BASE}/api/sso/start?email=${encodeURIComponent(email)}`, { redirect: "manual" });
  const loc = new URL(r.headers.get("location") ?? "http://x/");
  const req = loc.searchParams.get("SAMLRequest") ? zlib.inflateRawSync(Buffer.from(loc.searchParams.get("SAMLRequest")!, "base64")).toString() : "";
  return { status: r.status, loc, setCookie: r.headers.get("set-cookie"), request: req, id: req.match(/\sID="([^"]+)"/)?.[1] ?? "", relay: loc.searchParams.get("RelayState") ?? "" };
}
/** The browser's POST of the IdP's answer to our ACS. */
async function post(SAMLResponse: string, RelayState: string) {
  const r = await fetch(`${BASE}/api/sso/saml/acs`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://idp.saml-test.dev" }, body: new URLSearchParams({ SAMLResponse, RelayState }) });
  const set = r.headers.getSetCookie?.() ?? [];
  return { end: r.headers.get("location") ?? "", session: set.find((c) => c.startsWith("authjs.session-token="))?.split(";")[0] ?? null, ws: set.find((c) => c.startsWith("forge_ws="))?.split(";")[0] ?? "" };
}
async function signIn(email: string, o: Partial<Parameters<typeof samlResponse>[0]> = {}) {
  const s = await start(email);
  return post(samlResponse({ inResponseTo: s.id, email, ...o }), s.relay);
}

const ws = (await call("/api/workspace")).json.workspace as { id: string };
const before = await db.workspace.findUniqueOrThrow({ where: { id: ws.id }, select: { verifiedDomains: true } });
const PEOPLE = ["ana@saml-test.dev", "ben@saml-test.dev", "cy@saml-test.dev", "dan@saml-test.dev", "eve@elsewhere.dev"];
const setup = (extra: Record<string, unknown> = {}) =>
  call("/api/workspace/sso", { protocol: "saml", domain: "saml-test.dev", entityId: IDP, ssoUrl: SSO_URL, cert: idpKeys.cert, nameAttr: "displayName", groupsClaim: "groups", groupRoles: { "IT Admins": "ADMIN" }, ...extra });

try {
  const domains = (Array.isArray(before.verifiedDomains) ? before.verifiedDomains : []) as object[];
  await db.workspace.update({ where: { id: ws.id }, data: { verifiedDomains: [...domains, { domain: "saml-test.dev", token: "t", verifiedAt: new Date().toISOString() }] } });

  const meta = await fetch(`${BASE}/api/sso/saml/metadata`);
  const metaXml = await meta.text();
  check("SP metadata lists the ACS URL and entity ID", meta.ok && metaXml.includes(`Location="${ACS}"`) && metaXml.includes(`entityID="${SP}"`), metaXml.slice(0, 160));

  check("a certificate that isn't one is refused", (await setup({ cert: "not a certificate" })).status === 400);
  check("the IdP sign-in URL is required", (await setup({ ssoUrl: "" })).status === 400);
  const saved = await setup();
  check("setup checks out", saved.status === 200 && saved.json.check?.ok === true, JSON.stringify(saved.json));
  const settings = (await call("/api/workspace/sso")).json;
  check("settings show SAML and the values to give the IdP", settings.config?.protocol === "saml" && settings.saml?.acsUrl === ACS && settings.saml?.entityId === SP);

  const s = await start("ana@saml-test.dev");
  check("sign-in sends the person to the IdP with a SAML request and no state cookie", s.status === 302 && s.loc.origin + s.loc.pathname === SSO_URL && !!s.id && s.request.includes(ACS) && !s.setCookie, s.loc.toString().slice(0, 120));

  const firstResponse = samlResponse({ inResponseTo: s.id, email: "Ana@saml-test.dev", name: "Ana Silva" });
  const a = await post(firstResponse, s.relay);
  check("a signed assertion signs the person in and lands on Home", a.end === "/home" && !!a.session && a.ws === `forge_ws=${ws.id}`, a.end);
  const me = a.session ? (await call("/api/workspace", undefined, `${a.session}; ${a.ws}`)).json.workspace : null;
  const ana = await db.user.findUnique({ where: { email: "ana@saml-test.dev" } });
  const m = ana && (await db.membership.findUnique({ where: { userId_workspaceId: { userId: ana.id, workspaceId: ws.id } } }));
  check("and joins the workspace as a member, with the name from the IdP", me?.id === ws.id && m?.role === "MEMBER" && ana?.name === "Ana Silva", JSON.stringify({ me: me?.id === ws.id, role: m?.role, name: ana?.name }));

  const replay = await post(firstResponse, s.relay);
  check("the same response can't be used twice", replay.end.startsWith("/login?sso_error=") && !replay.session, decodeURIComponent(replay.end));

  await signIn("ben@saml-test.dev", { groups: ["IT Admins", "Everyone"] });
  const ben = await db.user.findUnique({ where: { email: "ben@saml-test.dev" } });
  check("an IdP group maps to a role", !!ben && (await db.membership.findUnique({ where: { userId_workspaceId: { userId: ben.id, workspaceId: ws.id } } }))?.role === "ADMIN");

  const rogue = await signIn("cy@saml-test.dev", { keys: rogueKeys });
  check("an assertion signed with another key is refused", rogue.end.startsWith("/login?sso_error=") && !rogue.session && /signature/i.test(decodeURIComponent(rogue.end)), decodeURIComponent(rogue.end));
  const aud = await signIn("cy@saml-test.dev", { audience: "https://some-other-app.example/saml" });
  check("an assertion meant for another service is refused", aud.end.startsWith("/login?sso_error=") && !aud.session, decodeURIComponent(aud.end));
  const old = await signIn("cy@saml-test.dev", { expired: true });
  check("an expired assertion is refused", old.end.startsWith("/login?sso_error=") && !old.session, decodeURIComponent(old.end));
  const t = await start("cy@saml-test.dev");
  const forged = await post(samlResponse({ inResponseTo: t.id, email: "cy@saml-test.dev" }), t.relay.replace(/^./, (ch) => (ch === "e" ? "f" : "e")));
  check("a tampered RelayState is refused", forged.end.startsWith("/login?sso_error=") && !forged.session);
  const eve = await signIn("ana@saml-test.dev", { email: "eve@elsewhere.dev" });
  check("an account from another domain is refused", eve.end.startsWith("/login?sso_error=") && /saml-test\.dev/.test(decodeURIComponent(eve.end)) && !eve.session);
  check("no stray users were created by refused sign-ins", !(await db.user.findUnique({ where: { email: "cy@saml-test.dev" } })) && !(await db.user.findUnique({ where: { email: "eve@elsewhere.dev" } })));

  await setup({ allowedGroups: ["Engineering"] });
  const dan = await signIn("dan@saml-test.dev", { groups: ["Sales"] });
  check("with allowed groups, others can't sign in", dan.end.startsWith("/login?sso_error=") && /group/.test(decodeURIComponent(dan.end)));
  const dan2 = await signIn("dan@saml-test.dev", { groups: ["Engineering"] });
  check("and people in them can", dan2.end === "/home" && !!dan2.session);

  // Metadata URL: the setup comes from the IdP's metadata, and a rotated certificate is followed on the next check.
  let metaCert = idpKeys.cert;
  const bare = (p: string) => p.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, "");
  const metaServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/samlmetadata+xml" });
    res.end(
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${bare(metaCert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${SSO_URL}/post"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SSO_URL}"/>` +
        `</md:IDPSSODescriptor></md:EntityDescriptor>`,
    );
  });
  await new Promise<void>((r) => metaServer.listen(4798, "127.0.0.1", () => r()));
  try {
    const viaMeta = await call("/api/workspace/sso", { protocol: "saml", domain: "saml-test.dev", metadataUrl: "http://127.0.0.1:4798/metadata", groupsClaim: "groups" });
    const cfg = (await call("/api/workspace/sso")).json.config;
    check("a metadata URL fills in the entity ID, redirect sign-in URL and certificate", viaMeta.json.check?.ok === true && cfg?.saml?.entityId === IDP && cfg?.saml?.ssoUrl === SSO_URL && bare(cfg?.saml?.cert ?? "") === bare(idpKeys.cert), JSON.stringify(viaMeta.json));
    const rotated = pem(365);
    metaCert = rotated.cert;
    await call("/api/workspace/sso", { action: "check" });
    const after = await signIn("dan@saml-test.dev", { keys: rotated });
    check("when the IdP rotates its certificate, the next check picks it up and sign-in keeps working", after.end === "/home" && !!after.session, decodeURIComponent(after.end));
    const oldKey = await signIn("dan@saml-test.dev");
    check("and the old key no longer works", oldKey.end.startsWith("/login?sso_error="));
  } finally {
    metaServer.close();
  }

  const soon = pem(5);
  const expiring = await setup({ cert: soon.cert });
  const anomalies = (await call("/api/workspace/action-center")).json.anomalies as { title: string; detail: string }[];
  check("a certificate about to expire fails the check and shows in the action center", expiring.json.check?.ok === false && /expires in/.test(expiring.json.check?.error ?? "") && anomalies.some((x) => /SSO/.test(x.title)), expiring.json.check?.error);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  await fs.rm(path.join(ROOT, "_forge", "sso", `${ws.id}.json`), { force: true });
  await db.workspace.update({ where: { id: ws.id }, data: { verifiedDomains: before.verifiedDomains ?? [] } });
  for (const e of PEOPLE) {
    const u = await db.user.findUnique({ where: { email: e }, include: { memberships: true } });
    if (!u) continue;
    for (const m of u.memberships) if (m.workspaceId !== ws.id && m.role === "OWNER") await db.workspace.delete({ where: { id: m.workspaceId } }).catch(() => undefined);
    await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
  }
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
