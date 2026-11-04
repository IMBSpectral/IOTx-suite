import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { loadChannel, postMessage } from "@/lib/chat";
import { bad, body, route, str } from "@/lib/http";
import { createMeeting, meetingUrl, MEET_KEYS } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";

/**
 * POST { channelId } -> "Start a call" from a Team Chat channel or DM: an
 * instant meeting for the channel's members, announced in the channel. The
 * meeting's notes are posted later as a reply to that message.
 */
async function POST_(req: Request) {
  const me = await requireMe(["teamchat.open", MEET_KEYS.open]);
  const b = await body<{ channelId?: string }>(req);
  const channelId = str(b.channelId, 100);
  if (!channelId) bad("channelId is required");
  const { ch } = await loadChannel(me, channelId, { write: true });
  const members = await db.channelMember.findMany({ where: { channelId: ch.id } });
  let title = `Call in #${ch.name}`;
  if (ch.kind === "dm") {
    const other = members.find((x) => x.userId !== me.userId);
    const u = other ? await db.user.findUnique({ where: { id: other.userId } }) : null;
    title = `Call with ${me.name}${u ? ` and ${u.name ?? u.email}` : ""}`;
  }
  const m = await createMeeting(me, { title, channelId: ch.id, invitees: members.map((x) => x.userId), allowGuests: false });
  const url = meetingUrl(req, m.code);
  const msg = await postMessage(me, ch.id, { body: `📹 ${me.name} started a call: ${title}\nJoin: ${url}` });
  await db.meeting.update({ where: { id: m.id }, data: { messageId: msg.id } });
  return Response.json({ meeting: { code: m.code, title: m.title, url }, messageId: msg.id }, { status: 201 });
}

export const POST = route(POST_);
