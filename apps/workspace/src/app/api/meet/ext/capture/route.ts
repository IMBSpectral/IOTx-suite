import { body, route } from "@/lib/http";
import { startCapture, tokenMe } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

/**
 * The extension starts recording a call for notes.
 * POST (Bearer) { title?, platform?: meet|zoom|teams|other, url, participants?: string[], eventId?, mime? }
 *   -> 201 { captureId, meetingId, code, title, platform, eventId, reportUrl }
 */
async function POST_(req: Request) {
  const { me, token } = await tokenMe(req);
  return Response.json(await startCapture(me, token.id, await body(req)), { status: 201 });
}

export const POST = route(POST_);
