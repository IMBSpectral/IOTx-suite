import crypto from "node:crypto";
import { db } from "./db";
import { bad } from "./http";

/**
 * Web Push to closed browsers and phones (RFC 8030 / 8291 / 8292) with
 * node:crypto only: VAPID keys are made once and kept in push_config, each
 * payload is encrypted (aes128gcm) for the subscription's keys and POSTed to
 * the browser vendor's push service. Endpoints must be on a known push
 * service (or listed in PUSH_EXTRA_HOSTS, for local tests), so this can't be
 * used to make the server call arbitrary addresses. Gone subscriptions
 * (404/410) are deleted; others are dropped after 5 failures in a row.
 */

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
const extraHosts = () => (process.env.PUSH_EXTRA_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export function pushEndpointOk(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (extraHosts().includes(u.host)) return true;
  return u.protocol === "https:" && !u.port && !u.username && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

let keys: { publicKey: string; privateKey: crypto.KeyObject } | null = null;

/** The VAPID key pair (public key as the browser wants it: raw P-256 point, base64url). */
export async function vapid() {
  if (keys) return keys;
  let row = await db.pushConfig.findUnique({ where: { id: "vapid" } });
  if (!row) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)]);
    row = await db.pushConfig.upsert({
      where: { id: "vapid" },
      create: { id: "vapid", publicKey: b64u(raw), privateKey: JSON.stringify(privateKey.export({ format: "jwk" })) },
      update: {},
    });
  }
  keys = { publicKey: row.publicKey, privateKey: crypto.createPrivateKey({ key: JSON.parse(row.privateKey), format: "jwk" }) };
  return keys;
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number) {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  return crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
}

/** RFC 8291: the payload encrypted for one subscription, as the aes128gcm body. */
export function encrypt(payload: Buffer, p256dh: string, auth: string) {
  const ua = unb64u(p256dh);
  const secret = unb64u(auth);
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(ua);
  const ikm = hkdf(secret, shared, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPublic]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

async function vapidHeader(endpoint: string) {
  const k = await vapid();
  const enc = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${process.env.PUSH_CONTACT || "support@imbspectral.online"}` })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: k.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${k.publicKey}`;
}

export type PushMessage = { title: string; body?: string; url?: string; tag?: string };

/** Push to every device this person has subscribed. Never throws; returns how many accepted it. */
export async function pushTo(userId: string, msg: PushMessage) {
  const subs = await db.pushSub.findMany({ where: { userId } });
  let ok = 0;
  for (const s of subs) {
    if (!pushEndpointOk(s.endpoint)) continue;
    try {
      const body = encrypt(Buffer.from(JSON.stringify({ title: msg.title.slice(0, 120), body: (msg.body ?? "").slice(0, 300), url: msg.url ?? "/workspace/chat", tag: msg.tag })), s.p256dh, s.auth);
      const r = await fetch(s.endpoint, {
        method: "POST",
        headers: { authorization: await vapidHeader(s.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" },
        body: new Uint8Array(body),
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 404 || r.status === 410) await db.pushSub.delete({ where: { id: s.id } }).catch(() => null);
      else if (r.ok) {
        ok++;
        await db.pushSub.update({ where: { id: s.id }, data: { lastOkAt: new Date(), failures: 0 } });
      } else await fail(s.id);
    } catch {
      await fail(s.id);
    }
  }
  return ok;
}

async function fail(id: string) {
  const s = await db.pushSub.update({ where: { id }, data: { failures: { increment: 1 } } }).catch(() => null);
  if (s && s.failures >= 5) await db.pushSub.delete({ where: { id } }).catch(() => null);
}

export async function subscribe(user: { userId: string; ws: string }, sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }, agent = "") {
  const endpoint = String(sub.endpoint ?? "");
  const p256dh = String(sub.keys?.p256dh ?? "");
  const auth = String(sub.keys?.auth ?? "");
  if (!pushEndpointOk(endpoint)) bad("That push address isn't from a known browser push service.");
  if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) bad("The subscription keys are missing or malformed.");
  if ((await db.pushSub.count({ where: { userId: user.userId } })) >= 20) await db.pushSub.deleteMany({ where: { userId: user.userId, id: { in: (await db.pushSub.findMany({ where: { userId: user.userId }, orderBy: { createdAt: "asc" }, take: 1 })).map((x) => x.id) } } });
  return db.pushSub.upsert({
    where: { endpoint },
    create: { userId: user.userId, ws: user.ws, endpoint, p256dh, auth, agent: agent.slice(0, 200) },
    update: { userId: user.userId, ws: user.ws, p256dh, auth, agent: agent.slice(0, 200), failures: 0 },
  });
}

export async function unsubscribe(userId: string, endpoint: string) {
  return (await db.pushSub.deleteMany({ where: { userId, endpoint } })).count;
}
