import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { browseChannels, channelName, listChannels } from "@/lib/chat";
import { publish } from "@/lib/bus";
import { body, route, str } from "@/lib/http";

/**
 * GET  -> { channels } (public, private I'm in, my DMs; with unread and mention counts)
 * GET  ?browse=1&q=&archived=1 -> { channels } for the channel browser
 * POST { name, kind: "public" | "private", topic?, description?, memberIds? } -> a new channel
 *      (teamchat.channel.create; private also needs teamchat.private)
 */
async function GET_(req: Request) {
  const me = await requireMe("teamchat.open");
  const q = new URL(req.url).searchParams;
  if (q.get("browse")) return Response.json({ channels: await browseChannels(me, { q: q.get("q") ?? "", archived: q.get("archived") === "1" }) });
  return Response.json({ channels: await listChannels(me) });
}

async function POST_(req: Request) {
  const b = await body<{ name?: string; kind?: string; topic?: string; description?: string; memberIds?: string[] }>(req);
  const kind = b.kind === "private" ? "private" : "public";
  const me = await requireMe(kind === "private" ? ["teamchat.open", "teamchat.channel.create", "teamchat.private"] : ["teamchat.open", "teamchat.channel.create"]);
  const name = channelName(b.name);
  if (!name) return Response.json({ error: "Give the channel a name." }, { status: 400 });
  if (await db.channel.findFirst({ where: { ws: me.ws, name, kind: { not: "dm" } } })) return Response.json({ error: `#${name} already exists.` }, { status: 409 });
  const known = await db.member.findMany({ where: { ws: me.ws, userId: { in: (b.memberIds ?? []).slice(0, 500) } } });
  const ids = [...new Set([me.userId, ...known.map((k) => k.userId)])];
  const ch = await db.channel.create({ data: { ws: me.ws, kind, name, topic: str(b.topic, 300), description: str(b.description, 1000), createdBy: me.userId, members: { create: ids.map((userId) => ({ userId })) } } });
  publish(`ws:${me.ws}`, { type: "channel", channelId: ch.id, kind: ch.kind });
  return Response.json({ channel: ch }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
