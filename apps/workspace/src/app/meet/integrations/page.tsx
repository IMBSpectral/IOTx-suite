import type { Metadata } from "next";
import { boot, Frame } from "@/lib/page";
import NoAccess from "@/components/NoAccess";
import Integrations from "@/components/meet/Integrations";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Meet integrations" };

/** Meet → Integrations: the browser extension, MCP (API tokens), webhooks and "report ready" auto-share. */
export default async function Page() {
  const r = await boot("meetings", "/meet/integrations");
  if ("el" in r) return r.el;
  const p = r.me.perms;
  return (
    <Frame shell={r.shell} active={"meetings" as "calendar"} me={r.me}>
      {p["meetings.open"] ? <Integrations canChat={!!p["teamchat.open"]} canTasks={!!p["tasks.open"] && !!p["tasks.create"]} canRecord={!!p["meetings.ai_notes"]} /> : <NoAccess name="Meet" />}
    </Frame>
  );
}
