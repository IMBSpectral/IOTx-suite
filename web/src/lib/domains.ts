import { resolve4, resolveCname } from "node:dns/promises";

/**
 * Custom domains: where a domain should point, and whether it does yet.
 * Subdomains (www.example.com) use a CNAME to the sites host; apex domains
 * (example.com) use an A record to the server's public IP.
 */
export const CNAME_TARGET = (process.env.PUBLIC_SITES_CNAME ?? process.env.PUBLIC_SITES_HOST ?? "sites.forge.app").replace(/:\d+$/, "");
export const PUBLIC_IP = process.env.FORGE_PUBLIC_IP ?? null;

export type DomainStatus = {
  domain: string;
  status: "active" | "pending_dns" | "misconfigured";
  found: string[];
  expected: { type: "CNAME" | "A"; name: string; value: string };
  message: string;
};

type Lookup = { cname: (d: string) => Promise<string[]>; a: (d: string) => Promise<string[]> };
const real: Lookup = { cname: resolveCname, a: resolve4 };

const isApex = (d: string) => d.split(".").length === 2;

export async function domainStatus(domain: string, lookup: Lookup = real): Promise<DomainStatus> {
  const apex = isApex(domain);
  const expected = apex
    ? { type: "A" as const, name: "@", value: PUBLIC_IP ?? "(your server's public IP)" }
    : { type: "CNAME" as const, name: domain.split(".")[0], value: CNAME_TARGET };
  const safe = (p: Promise<string[]>) => p.then((v) => v).catch(() => [] as string[]);
  const [cnames, as] = await Promise.all([safe(lookup.cname(domain)), safe(lookup.a(domain))]);
  const found = [...cnames.map((c) => `CNAME ${c}`), ...as.map((a) => `A ${a}`)];
  const pointsHere =
    cnames.some((c) => c.replace(/\.$/, "").toLowerCase() === CNAME_TARGET.toLowerCase()) || (!!PUBLIC_IP && as.includes(PUBLIC_IP));
  if (pointsHere) return { domain, status: "active", found, expected, message: "Connected. Visitors reach your published app here." };
  if (!found.length) {
    return { domain, status: "pending_dns", found, expected, message: `Waiting for DNS: add the ${expected.type} record below. Changes can take up to a day to spread.` };
  }
  return { domain, status: "misconfigured", found, expected, message: `The domain points somewhere else (${found.join(", ")}). Change it to the ${expected.type} record below.` };
}
