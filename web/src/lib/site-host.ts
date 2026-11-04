/**
 * Where published apps live: <sub>.<SITES_HOST>. Locally that's localhost:3000;
 * in production PUBLIC_SITES_HOST is the platform domain (e.g. imbspectral.online),
 * served over HTTPS.
 */
export const SITES_HOST = (process.env.PUBLIC_SITES_HOST ?? "localhost:3000").toLowerCase();
export const SITES_HOSTNAME = SITES_HOST.replace(/:\d+$/, "");
const local = SITES_HOSTNAME === "localhost" || SITES_HOSTNAME.endsWith(".localhost") || /^127\./.test(SITES_HOSTNAME);
export const SITES_PROTOCOL = process.env.FORGE_SITES_PROTOCOL ?? (local ? "http" : "https");

/** Full origin of one label under the sites host: an app, a preview link or a version. */
export const siteOrigin = (label: string) => `${SITES_PROTOCOL}://${label}.${SITES_HOST}`;

/**
 * Subdomains no project may take: platform names, plus any already used by other
 * services on the domain (FORGE_RESERVED_SUBDOMAINS, comma-separated).
 */
export const RESERVED_SUBDOMAINS = new Set([
  "www", "app", "api", "admin", "auth", "login", "mail", "smtp", "imap", "ftp", "status", "docs", "help", "support", "cdn", "static", "assets",
  ...(process.env.FORGE_RESERVED_SUBDOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
]);
