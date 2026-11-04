import { requireMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { meetingUrl, MEET_KEYS, personalRoom } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";

/** GET -> { meeting: { code, url, title } } my personal meeting room (one fixed link). */
async function GET_(req: Request) {
  const me = await requireMe([MEET_KEYS.open, MEET_KEYS.create]);
  const m = await personalRoom(me);
  return Response.json({ meeting: { code: m.code, title: m.title, url: meetingUrl(req, m.code), passcode: m.passcode } });
}

export const GET = route(GET_);
