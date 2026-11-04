import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { loadChannel } from "@/lib/chat";
import { summarizeThread } from "@/lib/ai";
import { route } from "@/lib/http";

/** POST -> { summary, messages, since }: AI catch-up on what I haven't read (at least the last day; a week if it's quiet). Needs teamchat.ai. */
async function POST_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe(["teamchat.open", "teamchat.ai"]);
  const { ch, member } = await loadChannel(me, (await ctx.params).id);
  const dayAgo = new Date(Date.now() - 86400_000);
  let since = member && member.lastReadAt < dayAgo ? member.lastReadAt : dayAgo;
  const recent = await db.message.count({ where: { channelId: ch.id, createdAt: { gt: since }, deletedAt: null, system: false } });
  if (recent < 3) since = new Date(Date.now() - 7 * 86400_000);
  const rows = await db.message.findMany({ where: { channelId: ch.id, createdAt: { gt: since }, deletedAt: null, system: false }, orderBy: { createdAt: "asc" }, take: 400 });
  if (rows.length < 2) return Response.json({ error: "There isn't enough recent conversation here to catch up on." }, { status: 400 });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((x) => x.userId))] } } });
  const who = (id: string) => users.find((u) => u.id === id)?.name ?? "Someone";
  const summary = await summarizeThread(
    me,
    rows.map((x) => ({ who: who(x.userId), when: x.createdAt.toISOString().slice(0, 16).replace("T", " "), text: (x.parentId ? "(in a thread) " : "") + x.body })),
    ch.kind === "dm" ? "a direct message" : `#${ch.name}`,
    "channel",
  );
  return Response.json({ summary, messages: rows.length, since });
}

export const POST = route(POST_);
