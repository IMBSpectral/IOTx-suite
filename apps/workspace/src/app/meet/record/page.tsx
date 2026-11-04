import type { Metadata } from "next";
import { boot, Frame } from "@/lib/page";
import NoAccess from "@/components/NoAccess";
import Recorder from "@/components/meet/Recorder";
import { listTemplates } from "@/lib/meet/report";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Record in person" };

/** In-person recorder: phone-friendly, uploads as it records, then makes a report. */
export default async function Page() {
  const r = await boot("meetings", "/meet/record");
  if ("el" in r) return r.el;
  const ok = !!(r.me.perms["meetings.open"] && r.me.perms["meetings.create"] && r.me.perms["meetings.ai_notes"]);
  const templates = ok ? (await listTemplates(r.me.ws)).map((t) => ({ id: t.id, name: t.name })) : [];
  return (
    <Frame shell={r.shell} active={"meetings" as "calendar"} me={r.me}>
      {ok ? <Recorder templates={templates} /> : <NoAccess name="Meeting recording with AI notes" />}
    </Frame>
  );
}
