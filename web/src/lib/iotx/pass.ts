import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { db } from "../db";
import { effective } from "./permissions";
import { manifestById } from "./manifests";
import { openKey } from "./types";

/**
 * The IOTx Suite pass: a short-lived signed token (JWT, HS256) the platform
 * hands an app mounted under the same domain (e.g. /sheets, /tally) so it
 * knows who is signed in and what they may do there, without keeping its own
 * users. Apps verify it with POST /api/iotx/verify (or locally with the shared
 * IOTX_PASS_SECRET) and ask for live decisions with the same endpoint.
 *
 * The signing key is IOTX_PASS_SECRET when set, else derived from AUTH_SECRET,
 * so nothing new has to be configured to try it.
 */

export const PASS_ISSUER = "iotx-suite";
export const PASS_TTL_SECONDS = 300;

function key() {
  const own = process.env.IOTX_PASS_SECRET;
  const base = own || process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!base) throw new Error("Set AUTH_SECRET (or IOTX_PASS_SECRET) to sign IOTx passes.");
  return own ? new TextEncoder().encode(own) : crypto.createHmac("sha256", base).update("iotx-pass-v1").digest();
}

export type PassClaims = {
  sub: string;
  email: string;
  name: string | null;
  ws: string;
  plan: string;
  app: string;
  roles: string[];
  /** The caller's switches for this app only (plus its access key). */
  keys: string[];
  limits: Record<string, number | null>;
  owner: boolean;
};

/** Issue a pass for one app; null when the person can't open it. */
export async function issuePass(userId: string, workspaceId: string, app: string) {
  const m = manifestById(app);
  if (!m) return null;
  const e = await effective(userId, workspaceId);
  if (!e || !e.apps.includes(app)) return null;
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true } });
  const prefix = `${app}.`;
  const claims: Omit<PassClaims, "sub"> = {
    email: u.email,
    name: u.name,
    ws: workspaceId,
    plan: e.plan,
    app,
    roles: e.roles.map((r) => r.name),
    keys: e.keys.filter((k) => k.startsWith(prefix) || k === openKey(app)),
    limits: Object.fromEntries(Object.entries(e.limits).filter(([k]) => k.startsWith(prefix))),
    owner: e.isOwner,
  };
  const token = await new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(PASS_ISSUER)
    .setAudience(app)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${PASS_TTL_SECONDS}s`)
    .setJti(crypto.randomUUID())
    .sign(key());
  return { token, expiresIn: PASS_TTL_SECONDS, claims: { sub: userId, ...claims } };
}

/** Check a pass's signature, issuer and expiry (and audience when given). */
export async function verifyPass(token: string, app?: string): Promise<PassClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: PASS_ISSUER, ...(app ? { audience: app } : {}) });
    return payload as unknown as PassClaims;
  } catch {
    return null;
  }
}
