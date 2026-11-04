import { canPublish, canReview, createDoc, KINDS, listDocs } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";
import { db } from "@/lib/db";

/**
 * Company knowledge base.
 * GET  ?kind=&tag=&status=&stale=1&text= -> { docs, me, kinds, roles, tags }
 * POST { title, kind, body, tags?, audience?, roleIds?, status?, reviewEveryDays?, ownerId? } -> { doc }  (read.publish)
 */
async function GET_(req: Request) {
  const v = await kbViewer();
  const q = new URL(req.url).searchParams;
  const docs = await listDocs(v, { kind: q.get("kind") ?? undefined, tag: q.get("tag") ?? undefined, status: q.get("status") ?? undefined, stale: q.get("stale") === "1", text: q.get("text") ?? undefined });
  const all = await listDocs(v);
  const roles = await db.permRole.findMany({ where: { workspaceId: v.workspaceId }, select: { id: true, name: true, builtin: true }, orderBy: { name: "asc" } });
  const people = (await db.membership.findMany({ where: { workspaceId: v.workspaceId }, select: { user: { select: { id: true, name: true, email: true } } } })).map((m) => ({ id: m.user.id, name: m.user.name || m.user.email || "Someone" }));
  const pending = canReview(v) ? await db.kbSuggestion.count({ where: { workspaceId: v.workspaceId, status: "pending" } }) : 0;
  return Response.json({
    docs,
    kinds: KINDS,
    tags: [...new Set(all.flatMap((d) => d.tags))].sort(),
    roles,
    people,
    me: { id: v.userId, canPublish: canPublish(v), canReview: canReview(v), canAsk: !!v.e?.keys.includes("read.ask"), canSuggest: !!v.e?.keys.includes("read.suggest"), pending, stale: all.filter((d) => d.stale).length },
  });
}

async function POST_(req: Request) {
  const v = await kbViewer();
  const b = await req.json().catch(() => ({}));
  return Response.json({ doc: await createDoc(v, b) }, { status: 201 });
}

export const GET = kbRoute(GET_);
export const POST = kbRoute(POST_);
