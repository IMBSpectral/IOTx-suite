import { listSuggestions, suggest } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

/**
 * GET ?status=pending|approved|rejected -> { suggestions } (reviewers see all; others their own)
 * POST { docId?, mode?: "append" | "replace", title, body, reason? } -> { suggestion }  (read.suggest)
 */
async function GET_(req: Request) {
  const v = await kbViewer();
  const status = new URL(req.url).searchParams.get("status") ?? "pending";
  return Response.json({ suggestions: await listSuggestions(v, ["pending", "approved", "rejected"].includes(status) ? status : "pending") });
}
async function POST_(req: Request) {
  const v = await kbViewer("read.suggest");
  const b = await req.json().catch(() => ({}));
  return Response.json({ suggestion: await suggest(v, { ...b, source: "person" }) }, { status: 201 });
}

export const GET = kbRoute(GET_);
export const POST = kbRoute(POST_);
