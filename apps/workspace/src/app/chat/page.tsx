import type { Metadata } from "next";
import { boot, Frame } from "@/lib/page";
import NoAccess from "@/components/NoAccess";
import ChatApp from "@/components/chat/ChatApp";
import GuestFrame from "@/components/chat/GuestFrame";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat" };

export default async function Page() {
  const r = await boot("teamchat", "/chat");
  if ("el" in r) return r.el;
  if (r.me.guest)
    return (
      <GuestFrame name={r.me.name} email={r.me.email}>
        <ChatApp boot={r.boot} />
      </GuestFrame>
    );
  return (
    <Frame shell={r.shell} active="teamchat" me={r.me}>
      {r.me.perms["teamchat.open"] ? <ChatApp boot={r.boot} /> : <NoAccess name="Chat" />}
    </Frame>
  );
}
