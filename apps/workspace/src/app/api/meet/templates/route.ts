import { db } from "@/lib/db";
import { HttpError, requireMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { cleanTemplate, listTemplates } from "@/lib/meet/report";

export const dynamic = "force-dynamic";

/**
 * Report templates: the built-ins plus this workspace's own.
 * GET -> { templates: [{ id, name, instructions, sections: [{ title, prompt }], builtin, mine }] }
 * POST { name, instructions, sections: [{ title, prompt }] } -> 201 { template }   (AI notes switch)
 * PATCH { id, name, instructions, sections }  /  DELETE ?id=   (whoever made it, or the workspace owner)
 */
async function GET_() {
  const me = await requireMe(MEET_KEYS.open);
  const own = await db.meetTemplate.findMany({ where: { ws: me.ws }, select: { id: true, createdBy: true } });
  const ts = await listTemplates(me.ws);
  return Response.json({ templates: ts.map((t) => ({ ...t, mine: !t.builtin && (me.owner || own.find((o) => o.id === t.id)?.createdBy === me.userId) })) });
}

async function POST_(req: Request) {
  const me = await requireMe([MEET_KEYS.open, MEET_KEYS.aiNotes]);
  const t = cleanTemplate(await body(req));
  if ((await db.meetTemplate.count({ where: { ws: me.ws } })) >= 100) throw new HttpError(409, "This workspace has 100 templates already.");
  const row = await db.meetTemplate.create({ data: { ws: me.ws, ...t, createdBy: me.userId } });
  return Response.json({ template: { id: row.id, name: row.name, instructions: row.instructions, sections: row.sections, builtin: false, mine: true } }, { status: 201 });
}

async function own(id: string) {
  const me = await requireMe([MEET_KEYS.open, MEET_KEYS.aiNotes]);
  const t = await db.meetTemplate.findUnique({ where: { id: String(id ?? "") } });
  if (!t || t.ws !== me.ws) throw new HttpError(404, "Not found");
  if (t.createdBy !== me.userId && !me.owner) throw new HttpError(403, "Only the person who made this template can change it.");
  return t;
}

async function PATCH_(req: Request) {
  const b = await body<{ id?: string; name?: string; instructions?: string; sections?: unknown }>(req);
  const t = await own(String(b.id ?? ""));
  const row = await db.meetTemplate.update({ where: { id: t.id }, data: cleanTemplate(b) });
  return Response.json({ template: { id: row.id, name: row.name, instructions: row.instructions, sections: row.sections, builtin: false, mine: true } });
}

async function DELETE_(req: Request) {
  const t = await own(new URL(req.url).searchParams.get("id") ?? "");
  await db.meetTemplate.delete({ where: { id: t.id } });
  // Meetings that used it fall back to the general template next time.
  await db.meeting.updateMany({ where: { ws: t.ws, template: t.id }, data: { template: "general" } });
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
