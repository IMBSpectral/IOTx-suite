import { HubError, readShare } from "@/lib/datahub";

/**
 * Data Hub gateway: an app reads data another app shared with it.
 *   GET /api/hub/<share>?column=eq.value&order=col.desc&limit=100   header x-hub-key: <the reading app's key>
 * Read-only, at most 1,000 rows per call. Any origin (the key is the permission).
 */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "x-hub-key, content-type", "cache-control": "no-store" };

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request, { params }: { params: Promise<{ share: string }> }) {
  const { share } = await params;
  const url = new URL(req.url);
  const key = req.headers.get("x-hub-key") ?? url.searchParams.get("key");
  url.searchParams.delete("key");
  try {
    return Response.json(await readShare(share, key, url.searchParams), { headers: CORS });
  } catch (e) {
    if (e instanceof HubError) return Response.json({ error: e.message }, { status: e.status, headers: CORS });
    console.error("[hub]", e);
    return Response.json({ error: "Couldn't read that data right now." }, { status: 500, headers: CORS });
  }
}
