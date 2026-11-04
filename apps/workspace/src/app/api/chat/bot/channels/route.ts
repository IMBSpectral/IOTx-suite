import { botMe } from "@/lib/chat-apps";
import { listChannels } from "@/lib/chat";
import { route } from "@/lib/http";

/** The bot API: GET -> { channels } the bot is in (and its DMs). */
async function GET_(req: Request) {
  const { me } = await botMe(req);
  const all = await listChannels(me);
  return Response.json({ channels: all.filter((c) => c.joined).map((c) => ({ id: c.id, kind: c.kind, name: c.name, topic: c.topic, members: c.memberIds.length })) });
}

export const GET = route(GET_);
