import { db } from "@/lib/db";
import { HttpError, requireMe } from "@/lib/auth";
import { bad, body, route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";

/**
 * Custom vocabulary: names and terms transcripts and reports should spell right.
 * GET -> { terms: [{ id, term, note }] }
 * POST { term, note? } | { terms: string[] }  (AI notes switch)  ·  DELETE ?id=
 */
async function GET_() {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json({ terms: await db.meetVocab.findMany({ where: { ws: me.ws }, orderBy: { term: "asc" }, select: { id: true, term: true, note: true } }) });
}

async function POST_(req: Request) {
  const me = await requireMe([MEET_KEYS.open, MEET_KEYS.aiNotes]);
  const b = await body<{ term?: string; note?: string; terms?: string[] }>(req);
  const wanted = (b.terms ?? [b.term ?? ""]).map((t) => String(t).replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 100);
  if (!wanted.length) bad("Enter a word or name.");
  const have = await db.meetVocab.findMany({ where: { ws: me.ws }, select: { term: true } });
  if (have.length + wanted.length > 500) throw new HttpError(409, "The vocabulary holds up to 500 terms.");
  const fresh = [...new Set(wanted)].filter((t) => !have.some((h) => h.term.toLowerCase() === t.toLowerCase()));
  if (fresh.length) await db.meetVocab.createMany({ data: fresh.map((term) => ({ ws: me.ws, term, note: wanted.length === 1 ? String(b.note ?? "").trim().slice(0, 200) : "" })) });
  return Response.json({ added: fresh.length, terms: await db.meetVocab.findMany({ where: { ws: me.ws }, orderBy: { term: "asc" }, select: { id: true, term: true, note: true } }) }, { status: 201 });
}

async function DELETE_(req: Request) {
  const me = await requireMe([MEET_KEYS.open, MEET_KEYS.aiNotes]);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const r = await db.meetVocab.deleteMany({ where: { id, ws: me.ws } });
  if (!r.count) throw new HttpError(404, "Not found");
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
