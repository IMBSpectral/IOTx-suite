import { requireMe } from "@/lib/auth";
import { listCommands, runCommand } from "@/lib/chat-apps";
import { body, route } from "@/lib/http";

/**
 * Bots' slash commands:
 * GET  -> { commands: [{ command, description, usage, bot }] }
 * POST { channelId, command, text, parentId? } -> { ephemeral? , message? }
 */
async function GET_() {
  const me = await requireMe("teamchat.open");
  return Response.json({ commands: await listCommands(me) });
}
async function POST_(req: Request) {
  const me = await requireMe("teamchat.open");
  const b = await body<{ channelId?: string; command?: string; text?: string; parentId?: string }>(req);
  return Response.json(await runCommand(me, String(b.channelId ?? ""), String(b.command ?? ""), String(b.text ?? ""), b.parentId || undefined));
}

export const GET = route(GET_);
export const POST = route(POST_);
