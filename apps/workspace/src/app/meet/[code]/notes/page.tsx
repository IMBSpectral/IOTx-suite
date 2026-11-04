import type { Metadata } from "next";
import { boot, Frame } from "@/lib/page";
import NotesView from "@/components/meet/NotesView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Meeting notes" };

/** AI notes and recordings of one meeting (host, invitees, members who joined). */
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toLowerCase();
  const r = await boot("meetings", `/meet/${code}/notes`);
  if ("el" in r) return r.el;
  return (
    <Frame shell={r.shell} active={"meetings" as "calendar"} me={r.me}>
      <NotesView code={code} canTasks={!!r.me.perms["tasks.create"]} canChat={!!r.me.perms["teamchat.open"]} />
    </Frame>
  );
}
