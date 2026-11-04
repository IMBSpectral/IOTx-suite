import { readLinked } from "@/lib/linked-sheets";
import { GoogleError } from "@/lib/google";

/**
 * Live values of a Google Sheet linked to an app, for the app's own pages
 * (preview and published, any origin). Only sheets linked to that project
 * can be read; values are cached for 30 seconds.
 */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "cache-control": "no-store" };

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request, { params }: { params: Promise<{ projectId: string; sheetId: string }> }) {
  const { projectId, sheetId } = await params;
  const range = new URL(req.url).searchParams.get("range") ?? undefined;
  try {
    const data = await readLinked(projectId, sheetId, range);
    if (!data) return Response.json({ error: "That sheet isn't linked to this app." }, { status: 404, headers: CORS });
    return Response.json(data, { headers: CORS });
  } catch (e) {
    const msg = e instanceof GoogleError ? e.message : "Couldn't read the sheet right now.";
    return Response.json({ error: msg }, { status: 502, headers: CORS });
  }
}
