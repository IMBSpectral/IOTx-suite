import { buildVersion, readSiteFile, versionBuilt } from "@/lib/publish";
import { getBrand } from "@/lib/brand";
import { resolveVersionView } from "@/lib/version-views";

/**
 * A past version of an app at version--<token>.localhost (rewritten here by
 * proxy.ts). If its build was cleaned up, it offers to rebuild it.
 */
type Ctx = { params: Promise<{ token: string; path?: string[] }> };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function page(status: number, title: string, body: string, extra = "") {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
      `<body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:system-ui,sans-serif;background:#fafaf9;color:#1c1917">` +
      `<div style="text-align:center;max-width:380px;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">${esc(title)}</h1><p style="color:#78716c;margin:0 0 16px">${body}</p>${extra}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

const REBUILD =
  `<form method="post" action="/__forge/rebuild"><button style="padding:8px 14px;border:0;border-radius:8px;background:#1c1917;color:#fff">Rebuild this version</button></form>`;

async function GET_(req: Request, { params }: Ctx) {
  const { token, path = [] } = await params;
  const view = await resolveVersionView(token);
  if (!view) return page(410, "Link expired", `Open the version again from History in ${getBrand().name}.`);
  if (!(await versionBuilt(view.projectId, view.sha))) {
    return page(404, "Preview not available", "Older previews are cleaned up to save storage. Rebuild it to view this version.", REBUILD);
  }
  const rel = path.join("/");
  if (rel && rel !== "index.html") {
    const file = await readSiteFile(view.projectId, view.sha, rel);
    if (file) {
      return new Response(new Uint8Array(file.bytes), {
        headers: { "content-type": file.type, "cache-control": "no-cache", "x-content-type-options": "nosniff" },
      });
    }
    if (/\.[a-z0-9]{1,5}$/i.test(rel)) return new Response("Not found", { status: 404 });
  }
  const index = await readSiteFile(view.projectId, view.sha, "index.html");
  if (!index) return page(404, "Preview not available", "Rebuild it to view this version.", REBUILD);
  const html = index.bytes.toString("utf8").replace("<head>", '<head><meta name="robots" content="noindex">');
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

async function POST_(req: Request, { params }: Ctx) {
  const { token, path = [] } = await params;
  if (path.join("/") !== "__forge/rebuild") return new Response("Method not allowed", { status: 405 });
  const view = await resolveVersionView(token);
  if (!view) return page(410, "Link expired", `Open the version again from History in ${getBrand().name}.`);
  const r = await buildVersion(view.projectId, view.sha).catch((e: Error) => ({ ok: false, error: e.message }));
  if (!r.ok) return page(503, "Couldn't rebuild this version", esc(r.error ?? "Try again shortly."), REBUILD);
  return new Response(null, { status: 303, headers: { location: "/" } });
}

export const GET = GET_;
export const POST = POST_;
