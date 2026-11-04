import { requireMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { saveUpload } from "@/lib/meet/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/**
 * POST ?title=&date=&name=  body = the audio or video file itself (up to 2 GB,
 * streamed to disk), content-type = its type.
 *   -> 201 { code, id, bytes, video }  a kind "upload" meeting; its report is being written.
 */
async function POST_(req: Request) {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await saveUpload(me, req), { status: 201 });
}

export const POST = route(POST_);
