import dns from "node:dns/promises";
import net from "node:net";

/** Refuse loopback, private and link-local targets: no reaching inside. */
export async function assertPublicUrl(raw: string | URL) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https addresses are allowed.");
  if (u.hostname === "localhost" || u.hostname.endsWith(".localhost")) throw new Error("That address isn't public.");
  const addrs = await dns.lookup(u.hostname, { all: true });
  for (const { address } of addrs) {
    const v4 = net.isIPv4(address) ? address.split(".").map(Number) : null;
    const privateV4 =
      v4 &&
      (v4[0] === 10 || v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254) ||
        (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168) ||
        (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127));
    const privateV6 = net.isIPv6(address) && /^(::1|::ffff:|fc|fd|fe80)/i.test(address);
    if (privateV4 || privateV6) throw new Error("That address isn't public.");
  }
  return u;
}

/**
 * fetch() to public addresses only. Redirects are followed by hand so every
 * hop is checked: a public URL can't bounce the request somewhere private.
 */
export async function publicFetch(raw: string | URL, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url = await assertPublicUrl(raw);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    url = await assertPublicUrl(new URL(location, url));
    // A redirect after a POST becomes a GET, as browsers do.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method && init.method !== "GET")) {
      init = { ...init, method: "GET", body: undefined };
    }
  }
  throw new Error("Too many redirects.");
}
