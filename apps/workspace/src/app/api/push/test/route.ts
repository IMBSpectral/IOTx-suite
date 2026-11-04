import { requireMe } from "@/lib/auth";
import { pushTo } from "@/lib/push";
import { route } from "@/lib/http";

/** POST -> sends a test notification to this person's devices: { delivered }. */
async function POST_() {
  const me = await requireMe();
  return Response.json({ delivered: await pushTo(me.userId, { title: "Notifications are on", body: "You'll get mentions and direct messages here, even with Chat closed.", url: "/workspace/chat", tag: "test" }) });
}

export const POST = route(POST_);
