import { book, bookingSlots } from "@/lib/cal-plus";
import { HttpError } from "@/lib/auth";
import { route } from "@/lib/http";

type Ctx = { params: Promise<{ slug: string }> };

/** Public booking page (no sign-in): GET ?from=YYYY-MM-DD&days= -> { page, days: [{ day, slots }] } · POST { start, name, email, note?, answers? } */
async function GET_(req: Request, ctx: Ctx) {
  const q = new URL(req.url).searchParams;
  const r = await bookingSlots((await ctx.params).slug, q.get("from") ?? undefined, Math.max(1, Math.min(31, Number(q.get("days")) || 14)));
  if (!r) throw new HttpError(404, "This booking page isn't available.");
  return Response.json(r, { headers: { "cache-control": "no-store" } });
}

// A small per-address limit keeps the public form from being used to flood a calendar.
const recent = new Map<string, number[]>();
async function POST_(req: Request, ctx: Ctx) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (hits.length >= 10) throw new HttpError(429, "Too many bookings from here. Try again later.");
  recent.set(ip, [...hits, now]);
  return Response.json(await book((await ctx.params).slug, (await req.json().catch(() => ({}))) as never, req), { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
