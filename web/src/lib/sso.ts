import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Role } from "@prisma/client";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { publicFetch } from "./net";
import { open, seal, type SecretBox } from "./secret-box";
import { domainsOf, audit } from "./workspace-security";
import { assertSeat } from "./members-extra";
import { onNewUser } from "./signup";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { recordLogin } from "./login-log";

/**
 * Single sign-on with OIDC or SAML 2.0 for a workspace. It needs a verified email domain;
 * people with that domain sign in through the company's identity provider and
 * join the workspace automatically, optionally only when they're in a mapped
 * group, with a role from their groups. The setup is checked against the
 * provider's discovery document, and its health is watched.
 */

export type SamlSetup = { entityId: string; ssoUrl: string; cert: string; emailAttr: string; nameAttr: string; metadataUrl?: string };

export type SsoConfig = {
  enabled: boolean;
  /** Missing on setups saved before SAML existed: those are OIDC. */
  protocol?: "oidc" | "saml";
  saml?: SamlSetup | null;
  domain: string;
  issuer: string;
  clientId: string;
  clientSecret: SecretBox | null;
  scopes: string;
  groupsClaim: string;
  allowedGroups: string[];
  groupRoles: Record<string, Role>;
  check: { at: string; ok: boolean; error: string | null } | null;
  lastLoginAt: string | null;
};

export class SsoError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

const PURPOSE = "forge-sso";
const ORIGIN = process.env.EDITOR_ORIGIN ?? "http://localhost:3000";
export const callbackUrl = () => `${ORIGIN}/api/sso/callback`;
/** What the company's IT enters in their identity provider for SAML. */
export const samlSp = () => ({ entityId: `${ORIGIN}/api/sso/saml/metadata`, acsUrl: `${ORIGIN}/api/sso/saml/acs`, metadataUrl: `${ORIGIN}/api/sso/saml/metadata` });
const dir = path.join(PROJECTS_ROOT, "_forge", "sso");
const file = (ws: string) => path.join(dir, `${ws.replace(/[^\w-]/g, "")}.json`);
const RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
const allowLocal = process.env.FORGE_HOOKS_ALLOW_LOCAL === "1";

async function load(ws: string): Promise<SsoConfig | null> {
  const raw = await fs.readFile(file(ws), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as SsoConfig) : null;
}
async function save(ws: string, c: SsoConfig) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file(ws), JSON.stringify(c, null, 2));
}

/** Fetch from the identity provider: public HTTPS only (local addresses only while testing). */
function idpFetch(url: string, init: RequestInit = {}) {
  const u = new URL(url);
  if (allowLocal && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return fetch(u, { ...init, signal: AbortSignal.timeout(10_000) });
  if (u.protocol !== "https:") throw new SsoError("The identity provider must use https://.");
  return publicFetch(u, { ...init, signal: AbortSignal.timeout(10_000) }, 0);
}

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; scopes_supported?: string[] };

async function discover(issuer: string): Promise<Discovery> {
  const res = await idpFetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`).catch((e: Error) => {
    throw new SsoError(`Couldn't reach the identity provider: ${e.message}`);
  });
  if (!res.ok) throw new SsoError(`The identity provider's discovery document answered ${res.status}.`);
  const d = (await res.json().catch(() => null)) as Discovery | null;
  if (!d?.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new SsoError("The discovery document is missing endpoints.");
  if (d.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw new SsoError(`The provider says its issuer is ${d.issuer}, not ${issuer}.`);
  return d;
}

export async function ssoSettings(ws: string) {
  const c = await load(ws);
  const w = await db.workspace.findUniqueOrThrow({ where: { id: ws } });
  return {
    config: c ? { ...c, clientSecret: c.clientSecret ? "set" : null } : null,
    verifiedDomains: domainsOf(w).filter((d) => d.verifiedAt).map((d) => d.domain),
    callbackUrl: callbackUrl(),
    saml: samlSp(),
  };
}

/** Save the setup, then check it against the provider (scopes, endpoints, issuer). */
export async function saveSso(ws: string, input: Record<string, unknown>) {
  const w = await db.workspace.findUniqueOrThrow({ where: { id: ws } });
  const domain = String(input.domain ?? "").trim().toLowerCase();
  if (!domainsOf(w).some((d) => d.verifiedAt && d.domain === domain)) throw new SsoError("Pick a domain this workspace has verified (Settings → Security).");
  if (input.protocol === "saml") return saveSaml(ws, domain, input);
  const issuer = String(input.issuer ?? "").trim().replace(/\/$/, "");
  const clientId = String(input.clientId ?? "").trim();
  if (!issuer || !clientId) throw new SsoError("Enter the issuer URL and client ID.");
  const prev = await load(ws);
  const secret = typeof input.clientSecret === "string" && input.clientSecret ? seal(PURPOSE, input.clientSecret) : (prev?.clientSecret ?? null);
  if (!secret) throw new SsoError("Enter the client secret.");
  const scopes = String(input.scopes ?? "openid email profile").trim();
  if (!scopes.split(/\s+/).includes("openid")) throw new SsoError('Scopes must include "openid".');
  const roles = groupRolesOf(input);
  const c: SsoConfig = {
    enabled: input.enabled !== false,
    protocol: "oidc",
    saml: null,
    domain,
    issuer,
    clientId,
    clientSecret: secret,
    scopes,
    groupsClaim: String(input.groupsClaim ?? "groups").trim() || "groups",
    allowedGroups: Array.isArray(input.allowedGroups) ? (input.allowedGroups as string[]).map((g) => String(g).trim()).filter(Boolean) : [],
    groupRoles: roles,
    check: null,
    lastLoginAt: prev?.lastLoginAt ?? null,
  };
  await save(ws, c);
  return checkSso(ws);
}

function groupRolesOf(input: Record<string, unknown>) {
  const roles: Record<string, Role> = {};
  for (const [g, r] of Object.entries((input.groupRoles ?? {}) as Record<string, string>)) {
    if (!["ADMIN", "MEMBER", "VIEWER"].includes(r)) throw new SsoError(`${g}: the role is admin, member or viewer.`);
    roles[g] = r as Role;
  }
  return roles;
}

/** The IdP's signing certificate as PEM, from PEM or bare base64 as IdPs show it. */
function normalizeCert(raw: string) {
  const body = raw.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!body) throw new SsoError("Paste the identity provider's signing certificate.");
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  try {
    new crypto.X509Certificate(pem);
  } catch {
    throw new SsoError("That signing certificate isn't a valid X.509 certificate.");
  }
  return pem;
}

/** Read an IdP's SAML metadata: its entity ID, redirect sign-in URL and signing certificate. */
async function readIdpMetadata(url: string) {
  const res = await idpFetch(url).catch((e: Error) => {
    throw new SsoError(e instanceof SsoError ? e.message : `Couldn't reach the metadata URL: ${e.message}`);
  });
  if (!res.ok) throw new SsoError(`The metadata URL answered ${res.status}.`);
  const xml = await res.text();
  const entityId = xml.match(/<(?:\w+:)?EntityDescriptor\b[^>]*\bentityID="([^"]+)"/)?.[1];
  const sso = [...xml.matchAll(/<(?:\w+:)?SingleSignOnService\b[^>]*>/g)].map((m) => m[0]);
  const redirect = sso.find((t) => /HTTP-Redirect/.test(t)) ?? sso[0];
  const ssoUrl = redirect?.match(/\bLocation="([^"]+)"/)?.[1];
  const keys = [...xml.matchAll(/<(?:\w+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?KeyDescriptor>/g)];
  const signing = keys.find((k) => !/use="encryption"/.test(k[1]));
  const cert = signing?.[2].match(/<(?:\w+:)?X509Certificate>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/)?.[1];
  if (!entityId || !ssoUrl || !cert) throw new SsoError("That metadata is missing the entity ID, sign-in URL or signing certificate.");
  return { entityId, ssoUrl: ssoUrl.replace(/&amp;/g, "&"), cert: normalizeCert(cert) };
}

async function saveSaml(ws: string, domain: string, input: Record<string, unknown>) {
  const prev = await load(ws);
  const metadataUrl = String(input.metadataUrl ?? "").trim();
  const fromMeta = metadataUrl ? await readIdpMetadata(metadataUrl) : null;
  const entityId = fromMeta?.entityId ?? String(input.entityId ?? "").trim();
  const ssoUrl = fromMeta?.ssoUrl ?? String(input.ssoUrl ?? "").trim();
  if (!entityId || !ssoUrl) throw new SsoError("Enter the identity provider's metadata URL, or its entity ID and sign-in URL.");
  if (!URL.canParse(ssoUrl)) throw new SsoError("The sign-in URL isn't a valid URL.");
  const certIn = fromMeta?.cert ?? (typeof input.cert === "string" && input.cert.trim() ? input.cert : prev?.saml?.cert);
  if (!certIn) throw new SsoError("Paste the identity provider's signing certificate.");
  const c: SsoConfig = {
    enabled: input.enabled !== false,
    protocol: "saml",
    saml: { entityId, ssoUrl, cert: normalizeCert(certIn), emailAttr: String(input.emailAttr ?? "").trim(), nameAttr: String(input.nameAttr ?? "").trim(), ...(metadataUrl ? { metadataUrl } : {}) },
    domain,
    issuer: entityId,
    clientId: "",
    clientSecret: null,
    scopes: "",
    groupsClaim: String(input.groupsClaim ?? "groups").trim() || "groups",
    allowedGroups: Array.isArray(input.allowedGroups) ? (input.allowedGroups as string[]).map((g) => String(g).trim()).filter(Boolean) : [],
    groupRoles: groupRolesOf(input),
    check: null,
    lastLoginAt: prev?.lastLoginAt ?? null,
  };
  samlCache.delete(ws);
  await save(ws, c);
  return checkSso(ws);
}

/** SAML has no discovery document: check the sign-in URL and that the certificate is in date. */
function checkSaml(c: SsoConfig) {
  const u = new URL(c.saml!.ssoUrl);
  if (u.protocol !== "https:" && !(allowLocal && ["127.0.0.1", "localhost"].includes(u.hostname))) throw new SsoError("The sign-in URL must use https://.");
  const until = new Date(new crypto.X509Certificate(c.saml!.cert).validTo).getTime();
  if (until < Date.now()) throw new SsoError(`The signing certificate expired on ${new Date(until).toDateString()}. Paste the new one from the identity provider.`);
  const days = Math.ceil((until - Date.now()) / 86_400_000);
  if (days < 14) throw new SsoError(`The signing certificate expires in ${days} day${days === 1 ? "" : "s"}. Paste the new one from the identity provider.`);
}

/** Validate the provider now (also run by the action center's health watch). */
export async function checkSso(ws: string) {
  const c = await load(ws);
  if (!c) throw new SsoError("SSO isn't set up.", 404);
  try {
    if (c.protocol === "saml") {
      // With a metadata URL, follow the IdP: a rotated certificate or moved sign-in URL is picked up here.
      if (c.saml?.metadataUrl) {
        const m = await readIdpMetadata(c.saml.metadataUrl);
        if (m.cert !== c.saml.cert || m.ssoUrl !== c.saml.ssoUrl || m.entityId !== c.saml.entityId) {
          c.saml = { ...c.saml, ...m };
          c.issuer = m.entityId;
          samlCache.delete(ws);
        }
      }
      checkSaml(c);
      c.check = { at: new Date().toISOString(), ok: true, error: null };
      await save(ws, c);
      return c.check;
    }
    const d = await discover(c.issuer);
    const missing = c.scopes.split(/\s+/).filter((s) => d.scopes_supported && !d.scopes_supported.includes(s));
    if (missing.length) throw new SsoError(`The provider doesn't offer the scope${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`);
    c.check = { at: new Date().toISOString(), ok: true, error: null };
  } catch (e) {
    c.check = { at: new Date().toISOString(), ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await save(ws, c);
  return c.check;
}

export async function disableSso(ws: string) {
  const c = await load(ws);
  if (c) await save(ws, { ...c, enabled: false });
}

/** The workspace that signs in people with this email's domain, if any. */
export async function workspaceForEmail(email: string) {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return null;
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    const ws = f.replace(/\.json$/, "");
    const c = await load(ws);
    if (c?.enabled && c.domain === domain) return ws;
  }
  return null;
}

// ── The sign-in flow ──────────────────────────────────────────────────────

const stateKey = () => crypto.createHash("sha256").update(`sso-state:${process.env.AUTH_SECRET ?? ""}`).digest();
const b64 = (b: Buffer) => b.toString("base64url");

/** Start: the provider's authorize URL, and a signed state cookie for the callback. */
export async function startSso(ws: string, next = "/home") {
  const c = await load(ws);
  if (!c?.enabled) throw new SsoError("SSO isn't on for this workspace.", 404);
  if (c.protocol === "saml") return { url: await startSaml(ws, c, next), cookie: null };
  const d = await discover(c.issuer);
  const verifier = b64(crypto.randomBytes(32));
  const challenge = b64(crypto.createHash("sha256").update(verifier).digest());
  const nonce = b64(crypto.randomBytes(16));
  const state = b64(crypto.randomBytes(16));
  const payload = b64(Buffer.from(JSON.stringify({ ws, verifier, nonce, state, next: next.startsWith("/") && !next.startsWith("//") ? next : "/home", exp: Date.now() + 10 * 60_000 })));
  const sig = b64(crypto.createHmac("sha256", stateKey()).update(payload).digest());
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({ response_type: "code", client_id: c.clientId, redirect_uri: callbackUrl(), scope: c.scopes, state, nonce, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return { url: url.toString(), cookie: `${payload}.${sig}` };
}

function readState(cookie: string | null) {
  const [payload, sig] = (cookie ?? "").split(".");
  if (!payload || !sig) return null;
  const want = b64(crypto.createHmac("sha256", stateKey()).update(payload).digest());
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as { ws: string; verifier: string; nonce: string; state: string; next: string; exp: number };
  return s.exp > Date.now() ? s : null;
}

/** Finish: check everything, then the person's Forge user, membership and session. */
export async function finishSso(params: URLSearchParams, stateCookie: string | null) {
  const s = readState(stateCookie);
  if (!s || params.get("state") !== s.state) throw new SsoError("The sign-in expired or didn't match. Try again.", 401);
  if (params.get("error")) throw new SsoError(`The identity provider said: ${params.get("error_description") ?? params.get("error")}`, 401);
  const c = await load(s.ws);
  if (!c?.enabled || !c.clientSecret) throw new SsoError("SSO isn't on for this workspace.", 404);
  const d = await discover(c.issuer);
  const tokenRes = await idpFetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: params.get("code") ?? "", redirect_uri: callbackUrl(), client_id: c.clientId, client_secret: open(PURPOSE, c.clientSecret), code_verifier: s.verifier }),
  });
  const tokens = (await tokenRes.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!tokenRes.ok || !tokens.id_token) throw new SsoError(`The identity provider refused the sign-in${tokens.error ? `: ${tokens.error}` : ""}.`, 401);
  const jwks = createRemoteJWKSet(new URL(d.jwks_uri));
  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: d.issuer, audience: c.clientId }).catch(() => {
    throw new SsoError("The identity provider's token didn't check out.", 401);
  });
  if (payload.nonce !== s.nonce) throw new SsoError("The sign-in didn't match. Try again.", 401);
  const email = String(payload.email ?? "").toLowerCase();
  if (!email || payload.email_verified === false) throw new SsoError("The identity provider didn't share a verified email address.", 401);
  const groups = Array.isArray(payload[c.groupsClaim]) ? (payload[c.groupsClaim] as unknown[]).map(String) : [];
  return completeSsoSignIn(s.ws, c, { email, name: typeof payload.name === "string" ? payload.name : null, groups }, s.next);
}

/**
 * After the identity provider (OIDC or SAML) has vouched for the person: the
 * domain and group rules, their user, membership and role, and a session.
 */
export async function completeSsoSignIn(ws: string, c: SsoConfig, who: { email: string; name: string | null; groups: string[] }, next: string) {
  const email = who.email.toLowerCase();
  const groups = who.groups;
  if (email.split("@")[1] !== c.domain) throw new SsoError(`Only @${c.domain} accounts can sign in here.`, 403);
  if (c.allowedGroups.length && !groups.some((g) => c.allowedGroups.includes(g))) throw new SsoError("Your account isn't in a group that can use this workspace.", 403);
  let role: Role = "MEMBER";
  for (const g of groups) if (c.groupRoles[g] && RANK[c.groupRoles[g]] > RANK[role]) role = c.groupRoles[g];

  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    user = await db.user.create({ data: { email, name: who.name, emailVerified: new Date() } });
    await onNewUser({ id: user.id, name: user.name, email });
  }
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: ws } } });
  if (!m) {
    await assertSeat(ws);
    await db.membership.create({ data: { userId: user.id, workspaceId: ws, role } });
    await audit(ws, user.id, "member.invited", `${email} joined through SSO as ${role.toLowerCase()}`);
  } else if (m.role !== "OWNER" && RANK[role] > RANK[m.role]) {
    await db.membership.update({ where: { id: m.id }, data: { role } });
  }
  const sessionToken = crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 86_400_000);
  // The identity provider handles its own second factor, so SSO sessions count as verified.
  await db.session.create({ data: { sessionToken, userId: user.id, expires, mfaAt: new Date() } });
  await recordLogin(user.id, "sso");
  await save(ws, { ...c, lastLoginAt: new Date().toISOString() });
  return { sessionToken, expires, workspaceId: ws, next };
}

// ── SAML 2.0 ──────────────────────────────────────────────────────────────

/**
 * One SAML instance per workspace, kept in memory: it remembers the request
 * IDs it sent, so each response must answer a request we made, and only once.
 */
const samlCache = new Map<string, SAML>();
function samlFor(ws: string, c: SsoConfig) {
  let s = samlCache.get(ws);
  if (!s) {
    const sp = samlSp();
    s = new SAML({
      entryPoint: c.saml!.ssoUrl,
      idpIssuer: c.saml!.entityId,
      idpCert: c.saml!.cert,
      issuer: sp.entityId,
      audience: sp.entityId,
      callbackUrl: sp.acsUrl,
      identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: 10 * 60_000,
      acceptedClockSkewMs: 3 * 60_000,
      disableRequestedAuthnContext: true,
    });
    samlCache.set(ws, s);
  }
  return s;
}

/** RelayState: the workspace and where to go after, signed so it can't be changed on the way. */
function relayState(ws: string, next: string) {
  const payload = b64(Buffer.from(JSON.stringify({ ws, next: next.startsWith("/") && !next.startsWith("//") ? next : "/home", exp: Date.now() + 10 * 60_000 })));
  return `${payload}.${b64(crypto.createHmac("sha256", stateKey()).update(`saml:${payload}`).digest())}`;
}
function readRelay(rs: string | null) {
  const [payload, sig] = (rs ?? "").split(".");
  if (!payload || !sig) return null;
  const want = b64(crypto.createHmac("sha256", stateKey()).update(`saml:${payload}`).digest());
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as { ws: string; next: string; exp: number };
  return s.exp > Date.now() ? s : null;
}

function startSaml(ws: string, c: SsoConfig, next: string) {
  return samlFor(ws, c).getAuthorizeUrlAsync(relayState(ws, next), {});
}

/** The IdP's POST to our ACS: check the signed assertion, then sign the person in. */
export async function finishSaml(form: { SAMLResponse?: string | null; RelayState?: string | null }) {
  const r = readRelay(form.RelayState ?? null);
  if (!r) throw new SsoError("The sign-in expired or didn't match. Start again from the sign-in page.", 401);
  const c = await load(r.ws);
  if (!c?.enabled || c.protocol !== "saml" || !c.saml) throw new SsoError("SSO isn't on for this workspace.", 404);
  if (!form.SAMLResponse) throw new SsoError("The identity provider didn't send a SAML response.");
  const { profile } = await samlFor(r.ws, c)
    .validatePostResponseAsync({ SAMLResponse: form.SAMLResponse })
    .catch((e: Error) => {
      throw new SsoError(samlMessage(e), 401);
    });
  if (!profile) throw new SsoError("The identity provider didn't sign anyone in.", 401);
  const attr = (k: string) => {
    const v = k ? (profile as Record<string, unknown>)[k] : undefined;
    return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
  };
  const email = [attr(c.saml.emailAttr)[0], profile.email, profile.mail, profile.nameID].find((v) => typeof v === "string" && /^[^@\s]+@[^@\s]+$/.test(v));
  if (!email) throw new SsoError("The identity provider didn't share an email address. Send it as the NameID or an email attribute.", 401);
  return completeSsoSignIn(r.ws, c, { email: String(email), name: attr(c.saml.nameAttr)[0] ?? null, groups: attr(c.groupsClaim) }, r.next);
}

function samlMessage(e: Error) {
  const m = e.message;
  if (/InResponseTo/i.test(m)) return "This sign-in was already used or didn't start here. Start again from the sign-in page.";
  if (/signature/i.test(m)) return "The identity provider's signature didn't check out. Is the signing certificate up to date?";
  if (/audience/i.test(m)) return "The sign-in was meant for a different service. Check the entity ID set in the identity provider.";
  if (/expired|NotOnOrAfter|NotBefore|subject confirmation/i.test(m)) return "The sign-in expired. Try again.";
  if (/issuer/i.test(m)) return "The response came from a different identity provider than the one set up.";
  return `SAML sign-in failed: ${m}`;
}

/** Our service-provider metadata, for identity providers that import it. */
export function samlMetadata() {
  const sp = samlSp();
  return new SAML({ issuer: sp.entityId, callbackUrl: sp.acsUrl, idpCert: "unused", identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", wantAssertionsSigned: true }).generateServiceProviderMetadata(null);
}
