import { route } from "@/lib/http";
import { tokenMe, upcomingCalls } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

/** The extension's popup: GET (Bearer) -> { meetings: the next 24 hours' calendar entries with a call link }. */
async function GET_(req: Request) {
  const { me } = await tokenMe(req);
  return Response.json({ meetings: await upcomingCalls(me) });
}

export const GET = route(GET_);
