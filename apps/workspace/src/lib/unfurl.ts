import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Link previews: the page's title, description and image (Open Graph tags).
 * Only public addresses are fetched: the address is checked when the
 * connection is made (so a name can't switch to an internal address after
 * the check), redirects are re-checked, and reads stop at 512 KB / 4 s.
 */
export type Preview = { url: string; title: string; description: string; image: string; site: string };

export function privateIp(ip: string) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

export const safeLookup: net.LookupFunction = (host, opts, cb) => {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return (cb as (e: Error | null, a?: string, f?: number) => void)(err);
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => privateIp(a.address));
    if (bad || !list.length) return (cb as (e: Error | null) => void)(new Error("blocked address"));
    if ((opts as { all?: boolean }).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    (cb as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

function get(url: URL, hops = 0): Promise<{ html: string; url: URL } | null> {
  if (!/^https?:$/.test(url.protocol) || (url.port && !["80", "443"].includes(url.port)) || url.username) return Promise.resolve(null);
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && privateIp(url.hostname.replace(/^\[|\]$/g, ""))) return Promise.resolve(null);
  return new Promise((resolve) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(url, { lookup: safeLookup, timeout: 4000, headers: { "user-agent": "IOTxChatBot/1.0 (link preview)", accept: "text/html" } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (hops >= 3) return resolve(null);
        try {
          return void get(new URL(loc, url), hops + 1).then(resolve);
        } catch {
          return resolve(null);
        }
      }
      if (res.statusCode !== 200 || !/text\/html|application\/xhtml/.test(String(res.headers["content-type"] ?? ""))) {
        res.resume();
        return resolve(null);
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        size += c.length;
        chunks.push(c);
        if (size > 512 * 1024) res.destroy();
      });
      res.on("close", () => resolve({ html: Buffer.concat(chunks).toString("utf8"), url }));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ").trim();

function meta(html: string, names: string[]) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, "i");
    const tag = re.exec(html)?.[0];
    const v = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (v) return decode(v);
  }
  return "";
}

export async function unfurl(raw: string): Promise<Preview | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const r = await get(u);
  if (!r) return null;
  const head = r.html.slice(0, 200_000);
  const title = meta(head, ["og:title", "twitter:title"]) || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] ?? "");
  if (!title) return null;
  let image = meta(head, ["og:image", "twitter:image"]);
  try {
    image = image ? new URL(image, r.url).toString() : "";
    if (!image.startsWith("https://")) image = "";
  } catch {
    image = "";
  }
  return {
    url: raw,
    title: title.slice(0, 200),
    description: meta(head, ["og:description", "description", "twitter:description"]).slice(0, 300),
    image,
    site: (meta(head, ["og:site_name"]) || r.url.hostname).slice(0, 80),
  };
}
