import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import { cloudDir, CloudError, readSecret } from "./cloud";

/**
 * A branded sending domain for an app's emails (mail.acme.com instead of the
 * provider's shared address), through the app's Resend account: add the
 * domain, publish the DNS records it shows, verify, then the app sends from
 * name@domain. Several domains can be added and switched between. Delivery
 * status for sent emails comes back from the provider.
 */

export type DnsRecord = { record: string; type: string; name: string; value: string; priority?: number; status: string; inDns?: boolean };
export type EmailDomain = { id: string; name: string; status: string; region: string; records: DnsRecord[]; createdAt: string; checkedAt: string | null };
export type DomainState = { domains: EmailDomain[]; active: string | null; localPart: string };

const API = () => (process.env.FORGE_RESEND_API ?? "https://api.resend.com").replace(/\/$/, "");
const file = (projectId: string) => path.join(cloudDir(projectId), "email-domains.json");
const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export async function readDomains(projectId: string): Promise<DomainState> {
  const raw = await fs.readFile(file(projectId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as DomainState) : { domains: [], active: null, localPart: "hello" };
}
async function write(projectId: string, s: DomainState) {
  await fs.mkdir(cloudDir(projectId), { recursive: true });
  await fs.writeFile(file(projectId), JSON.stringify(s, null, 2));
}

async function resend(projectId: string, method: string, p: string, body?: unknown) {
  const key = await readSecret(projectId, "RESEND_API_KEY");
  if (!key) throw new CloudError("Add your Resend API key as the RESEND_API_KEY secret first: the domain is set up in that account.", 400);
  const res = await fetch(`${API()}${p}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => {
    throw new CloudError(`Couldn't reach the email provider: ${e.message}`, 502);
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new CloudError(`The email provider said: ${String(data.message ?? data.error ?? res.status)}`, res.status === 401 || res.status === 403 ? 400 : 502);
  return data;
}

const toRecords = (r: unknown): DnsRecord[] =>
  (Array.isArray(r) ? r : []).map((x: Record<string, unknown>) => ({
    record: String(x.record ?? ""),
    type: String(x.type ?? ""),
    name: String(x.name ?? ""),
    value: String(x.value ?? ""),
    ...(x.priority != null ? { priority: Number(x.priority) } : {}),
    status: String(x.status ?? "not_started"),
  }));

/** Look the records up ourselves, so the page can say which ones DNS already shows while the provider catches up. */
async function lookup(domain: string, r: DnsRecord): Promise<boolean> {
  const host = r.name && r.name !== "@" && !r.name.endsWith(domain) ? `${r.name}.${domain}` : r.name && r.name !== "@" ? r.name : domain;
  try {
    if (r.type === "MX") return (await dns.resolveMx(host)).some((m) => m.exchange.replace(/\.$/, "") === r.value.replace(/\.$/, ""));
    if (r.type === "TXT") return (await dns.resolveTxt(host)).some((t) => t.join("").replace(/\s/g, "") === r.value.replace(/\s/g, ""));
    if (r.type === "CNAME") return (await dns.resolveCname(host)).some((c) => c.replace(/\.$/, "") === r.value.replace(/\.$/, ""));
  } catch {
    return false;
  }
  return false;
}

export async function addDomain(projectId: string, name: string) {
  const domain = name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!HOST.test(domain)) throw new CloudError("Enter a domain like mail.yourcompany.com.");
  const s = await readDomains(projectId);
  if (s.domains.some((d) => d.name === domain)) throw new CloudError(`${domain} is already added.`, 409);
  if (s.domains.length >= 5) throw new CloudError("An app can have up to 5 sending domains. Remove one first.");
  const d = await resend(projectId, "POST", "/domains", { name: domain });
  const entry: EmailDomain = { id: String(d.id), name: domain, status: String(d.status ?? "not_started"), region: String(d.region ?? ""), records: toRecords(d.records), createdAt: new Date().toISOString(), checkedAt: null };
  s.domains.push(entry);
  await write(projectId, s);
  return entry;
}

/** Ask the provider to verify now, then read back the domain's and each record's status, and check DNS ourselves. */
export async function checkDomain(projectId: string, id: string) {
  const s = await readDomains(projectId);
  const entry = s.domains.find((d) => d.id === id);
  if (!entry) throw new CloudError("That domain isn't added to this app.", 404);
  await resend(projectId, "POST", `/domains/${encodeURIComponent(id)}/verify`).catch(() => undefined);
  const d = await resend(projectId, "GET", `/domains/${encodeURIComponent(id)}`);
  entry.status = String(d.status ?? entry.status);
  entry.records = await Promise.all(toRecords(d.records ?? entry.records).map(async (r) => ({ ...r, inDns: await lookup(entry.name, r) })));
  entry.checkedAt = new Date().toISOString();
  // A domain that stopped verifying can't stay the sender.
  if (s.active === id && entry.status !== "verified") s.active = null;
  await write(projectId, s);
  return entry;
}

export async function activateDomain(projectId: string, id: string | null | undefined, localPart?: string) {
  const s = await readDomains(projectId);
  if (localPart !== undefined) {
    const lp = localPart.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(lp)) throw new CloudError("The address before the @ can use letters, numbers, dots, dashes and +.");
    s.localPart = lp;
  }
  if (id !== undefined) {
    if (id) {
      const d = s.domains.find((x) => x.id === id);
      if (!d) throw new CloudError("That domain isn't added to this app.", 404);
      if (d.status !== "verified") throw new CloudError(`${d.name} isn't verified yet. Add its DNS records, then check again.`);
    }
    s.active = id;
  }
  await write(projectId, s);
  return s;
}

export async function removeDomain(projectId: string, id: string) {
  const s = await readDomains(projectId);
  if (!s.domains.some((d) => d.id === id)) throw new CloudError("That domain isn't added to this app.", 404);
  await resend(projectId, "DELETE", `/domains/${encodeURIComponent(id)}`).catch(() => undefined);
  s.domains = s.domains.filter((d) => d.id !== id);
  if (s.active === id) s.active = null;
  await write(projectId, s);
  return s;
}

/** The From address for the app's emails sent through Resend. */
export async function senderAddress(projectId: string, fromName: string) {
  const s = await readDomains(projectId);
  const d = s.domains.find((x) => x.id === s.active && x.status === "verified");
  const name = fromName.replace(/[<>"]/g, "").trim() || "App";
  return d ? `${name} <${s.localPart}@${d.name}>` : `${name} <onboarding@resend.dev>`;
}

export const resendApi = API;

/** The provider's latest event for a sent email (delivered, bounced, complained, opened…). */
export async function deliveryStatus(projectId: string, providerId: string) {
  const d = await resend(projectId, "GET", `/emails/${encodeURIComponent(providerId)}`);
  return typeof d.last_event === "string" ? d.last_event : null;
}
