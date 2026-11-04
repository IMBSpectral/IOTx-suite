import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { loadMessage } from "@/lib/chat";
import { summarizeThread } from "@/lib/ai";
import { route } from "@/lib/http";

/** POST -> { summary } of the thread under this message (Claude Haiku 5.5; needs teamchat.ai). */
async function POST_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe(["teamchat.open", "teamchat.ai"]);
  const { m, ch } = await loadMessage(me, (await ctx.params).id);
  const root = m.parentId ? await db.message.findUniqueOrThrow({ where: { id: m.parentId } }) : m;
  const replies = await db.message.findMany({ where: { parentId: root.id, deletedAt: null }, orderBy: { createdAt: "asc" }, take: 400 });
  const all = [root, ...replies].filter((x) => !x.deletedAt);
  if (all.length < 2) return Response.json({ error: "There's nothing to summarize yet: the thread has no replies." }, { status: 400 });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(all.map((x) => x.userId))] } } });
  const who = (id: string) => users.find((u) => u.id === id)?.name ?? "Someone";
  const summary = await summarizeThread(
    me,
    all.map((x) => ({ who: who(x.userId), when: x.createdAt.toISOString().slice(0, 16).replace("T", " "), text: x.body })),
    ch.kind === "dm" ? "a direct message" : `#${ch.name}`,
  );
  return Response.json({ summary, messages: all.length });
}

export const POST = route(POST_);
