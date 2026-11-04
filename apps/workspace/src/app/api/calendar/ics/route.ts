import { requireMe } from "@/lib/auth";
import { exportCalendar, HOLIDAYS, importIcs, refreshSubscriptions, subscribe } from "@/lib/cal-plus";
import { bad, route } from "@/lib/http";

/**
 * GET ?calendarId= -> the calendar as an .ics file · GET ?holidays=1 -> { countries }
 * POST multipart { file, calendarId } -> import · POST json { url | country, name?, color? } -> subscribe · POST json { refresh: calendarId }
 */
async function GET_(req: Request) {
  const me = await requireMe("calendar.open");
  const q = new URL(req.url).searchParams;
  if (q.get("holidays")) return Response.json({ countries: Object.keys(HOLIDAYS) });
  const { name, ics } = await exportCalendar(me, q.get("calendarId") ?? "");
  return new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.ics` } });
}

async function POST_(req: Request) {
  const me = await requireMe(["calendar.open", "calendar.create"]);
  if ((req.headers.get("content-type") ?? "").includes("multipart")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) bad("Choose an .ics file.");
    if (file.size > 5_000_000) bad("That file is too big (5 MB at most).");
    return Response.json(await importIcs(me, String(form?.get("calendarId") ?? ""), await file.text()));
  }
  const b = (await req.json().catch(() => ({}))) as { url?: string; country?: string; name?: string; color?: string; refresh?: string };
  if (b.refresh) return Response.json({ refreshed: await refreshSubscriptions(b.refresh) });
  return Response.json(await subscribe(me, b), { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
