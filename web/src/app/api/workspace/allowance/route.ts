import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { FREE_DAILY_CHATS, freeChatsUsedToday } from "@/lib/credits";

/** Free Ask/Plan turns left today for the composer's hint. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const used = await freeChatsUsedToday(ws.id, user.id);
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Response.json({ freeChatsLeft: Math.max(0, FREE_DAILY_CHATS - used), daily: FREE_DAILY_CHATS, resetsAt: reset.toISOString(), plan: ws.plan });
}

export const GET = route(GET_);
