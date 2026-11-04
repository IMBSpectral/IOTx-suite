import http from "node:http";
import { db } from "./db";
import { listFiles, readFile } from "./repo";
import { normalizeRoute, siteUrl } from "./publish";

/**
 * How each page of a published app looks to link previews and search
 * engines. Crawlers don't run JavaScript, so this fetches the page the way
 * they do and reads what the server sends, then explains why a page can't be
 * previewed (unpublished, private, redirected, behind sign-in).
 */

export type RouteInfo = { path: string; dynamic: boolean; signIn: boolean };
export type RoutePreview = {
  path: string;
  url: string;
  state:
    | "ok"
    | "unpublished"
    | "private"
    | "redirect"
    | "signin"
    | "not_found"
    | "error";
  status?: number;
  location?: string;
  title: string;
  description: string;
  image: string;
  noindex: boolean;
  notes: string[];
};

const GUARD =
  /Protected|RequireAuth|AuthGuard|PrivateRoute|RequireUser|SignedIn|RequireLogin/;
const ROUTE = /path\s*[=:]\s*\{?\s*["'`](\/[^"'`]*)["'`]/g;

/** Routes declared in the app's source (React Router style), home first. */
export async function appRoutes(projectId: string): Promise<RouteInfo[]> {
  const files = (await listFiles(projectId))
    .filter((f) => /^src\/.*\.(t|j)sx?$/.test(f))
    .slice(0, 400);
  const found = new Map<string, RouteInfo>([
    ["/", { path: "/", dynamic: false, signIn: false }],
  ]);
  for (const f of files) {
    const text = await readFile(projectId, f).catch(() => "");
    if (!text.includes("path")) continue;
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(ROUTE)) {
        const p = m[1] === "/" ? "/" : normalizeRoute(m[1]);
        if (p.includes("*")) continue;
        const prev = found.get(p);
        found.set(p, {
          path: p,
          dynamic: p.includes(":"),
          signIn: (prev?.signIn ?? false) || GUARD.test(line),
        });
      }
    }
  }
  return [...found.values()]
    .sort((a, b) =>
      a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path),
    )
    .slice(0, 50);
}

/** Fetch like a link-preview bot: no cookies, no JavaScript, no following redirects. */
function crawl(
  host: string,
  path: string,
): Promise<{ status: number; location?: string; html: string }> {
  const port = Number(process.env.PORT ?? 3000);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: {
          host,
          "user-agent": "facebookexternalhit/1.1 (Forge route preview)",
          accept: "text/html",
        },
        timeout: 15_000,
      },
      (res) => {
        let html = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          if (html.length < 512 * 1024) html += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            html,
          }),
        );
      },
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end();
  });
}

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
function meta(html: string, attr: "name" | "property", key: string) {
  const tag = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*>`, "i").exec(
    html,
  )?.[0];
  return tag ? decode(/content=["']([^"']*)["']/i.exec(tag)?.[1] ?? "") : "";
}

export async function previewRoute(
  projectId: string,
  route: RouteInfo,
): Promise<RoutePreview> {
  const p = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      subdomain: true,
      customDomain: true,
      publishedSha: true,
      publishAudience: true,
    },
  });
  const host = p.customDomain ?? new URL(siteUrl(p.subdomain ?? "x")).host;
  const url =
    (p.customDomain
      ? `https://${p.customDomain}`
      : siteUrl(p.subdomain ?? "")) + (route.path === "/" ? "/" : route.path);
  const base: RoutePreview = {
    path: route.path,
    url,
    state: "ok",
    title: "",
    description: "",
    image: "",
    noindex: false,
    notes: [],
  };
  if (!p.publishedSha || !p.subdomain)
    return {
      ...base,
      state: "unpublished",
      notes: ["Publish the app to give this page a link preview."],
    };
  if (p.publishAudience !== "public") {
    return {
      ...base,
      state: "private",
      notes: [
        "Only signed-in people with access can open this site, so link previews and search engines see nothing. Make the site public to show a preview.",
      ],
    };
  }
  if (route.dynamic)
    base.notes.push(
      "This page's address has a variable part (like :id); the preview shows one example of it.",
    );

  // A dynamic segment gets a stand-in value.
  const path = route.path.replace(/:[^/]+/g, "example");
  const res = await crawl(host, path).catch(() => null);
  if (!res)
    return {
      ...base,
      state: "error",
      notes: ["Couldn't reach the published site."],
    };
  if (res.status >= 300 && res.status < 400) {
    return {
      ...base,
      state: "redirect",
      status: res.status,
      location: res.location,
      notes: [
        `This page redirects to ${res.location ?? "another address"}, so previews show that page instead.`,
      ],
    };
  }
  if (res.status === 404)
    return {
      ...base,
      state: "not_found",
      status: 404,
      notes: ["The published site returns “not found” for this page."],
    };
  if (res.status >= 400)
    return {
      ...base,
      state: "error",
      status: res.status,
      notes: [`The published site answered ${res.status} for this page.`],
    };

  const html = res.html;
  const title =
    meta(html, "property", "og:title") ||
    decode(/<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  const description =
    meta(html, "property", "og:description") ||
    meta(html, "name", "description");
  let image = meta(html, "property", "og:image");
  if (image.startsWith("/")) image = new URL(image, url).toString();
  const noindex = /noindex/i.test(meta(html, "name", "robots"));
  const out: RoutePreview = {
    ...base,
    status: res.status,
    title,
    description,
    image,
    noindex,
  };
  if (route.signIn) {
    out.state = "signin";
    out.notes.push(
      "This page needs sign-in in the app. Link previews show the card below, but visitors who aren't signed in are sent to sign in.",
    );
  }
  if (noindex)
    out.notes.push(
      "Search engines are told not to index this site (robots noindex).",
    );
  if (!description)
    out.notes.push(
      "No description: search engines will pick text from the page, and some link previews show none.",
    );
  if (!image)
    out.notes.push("No share image: links to this page show a text-only card.");
  return out;
}

/** Previews for every page of the app (up to 20), in source order with home first. */
export async function previewRoutes(projectId: string) {
  const routes = (await appRoutes(projectId)).slice(0, 20);
  const out: RoutePreview[] = [];
  for (const r of routes) out.push(await previewRoute(projectId, r));
  // Pages that all show the home page's card are worth telling apart.
  const home = out.find((r) => r.path === "/");
  for (const r of out) {
    if (
      r !== home &&
      home &&
      r.state === "ok" &&
      r.title === home.title &&
      r.description === home.description
    ) {
      r.notes.push(
        "Same card as the home page. Give this page its own title and description below.",
      );
    }
  }
  return out;
}
