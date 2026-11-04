import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { addMembers, getMessage, isAdmin, joinChannel, leaveChannel, loadChannel, markRead, memberPrefs, removeMember, typing, updateChannel } from "@/lib/chat";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET  -> { channel, pins, canManage, admin }
 * POST { action, ... }:
 *   read { unreadFrom? } · join · leave · typing { parentId? }
 *   topic { topic } · update { name?, topic?, description?, archived?, retentionDays? }
 *   add { memberIds } · remove { userId } · prefs { muted?, notifyLevel?, starred? }
 */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  const { ch, member } = await loadChannel(me, (await ctx.params).id);
  const members = await db.channelMember.findMany({ where: { channelId: ch.id } });
  const pinRows = await db.message.findMany({ where: { channelId: ch.id, pinned: true, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true } });
  const pins = await Promise.all(pinRows.map((p) => getMessage(me, p.id)));
  return Response.json({
    channel: { ...ch, memberIds: members.map((m) => m.userId), joined: !!member },
    pins,
    canManage: ch.createdBy === me.userId || isAdmin(me),
    admin: isAdmin(me),
  });
}

async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  const id = (await ctx.params).id;
  const b = await body<Record<string, any>>(req);
  switch (b.action) {
    case "read":
      return Response.json(await markRead(me, id, b.unreadFrom ? String(b.unreadFrom) : undefined));
    case "join":
      return Response.json(await joinChannel(me, id));
    case "leave":
      return Response.json(await leaveChannel(me, id));
    case "typing":
      return Response.json(await typing(me, id, b.parentId ? String(b.parentId) : undefined));
    case "topic":
      await updateChannel(me, id, { topic: b.topic });
      return Response.json({ ok: true });
    case "update":
      return Response.json({ channel: await updateChannel(me, id, b) });
    case "add":
      return Response.json(await addMembers(me, id, (b.memberIds ?? []).map(String)));
    case "remove":
      return Response.json(await removeMember(me, id, String(b.userId ?? "")));
    case "prefs":
      return Response.json(await memberPrefs(me, id, b));
    default:
      await loadChannel(me, id);
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
