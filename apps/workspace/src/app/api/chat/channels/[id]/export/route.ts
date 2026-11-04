import { requireMe } from "@/lib/auth";
import { exportChannel } from "@/lib/chat";
import { route } from "@/lib/http";

/** GET -> the channel's messages as a JSON download (teamchat.admin). */
async function GET_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  const data = await exportChannel(me, (await ctx.params).id);
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${data.channel.name}-export.json"` },
  });
}

export const GET = route(GET_);
