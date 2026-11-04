import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { connectUrl, googleConfigured } from "@/lib/google";

/** Start connecting Google Drive (Docs, Sheets, Slides): off to Google's consent screen. */
async function GET_(req: Request) {
  const user = await requireUser();
  if (!googleConfigured()) return Response.json({ error: "Google isn't set up on this server." }, { status: 503 });
  const raw = new URL(req.url).searchParams.get("back") ?? "/sheets";
  const back = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/sheets";
  return Response.redirect(connectUrl(user.id, user.email ?? null, back, { pickAccount: true }), 302);
}

export const GET = route(GET_);
