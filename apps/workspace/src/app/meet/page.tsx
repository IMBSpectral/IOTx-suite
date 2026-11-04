import type { Metadata } from "next";
import { boot, Frame } from "@/lib/page";
import NoAccess from "@/components/NoAccess";
import MeetHome from "@/components/meet/MeetHome";
import ReadShell from "@/components/meet/read/ReadShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Meet" };

/** Meet landing: start an instant meeting, join by code, upcoming meetings from the calendar. In the suite shell. */
export default async function Page() {
  const r = await boot("meetings", "/meet");
  if ("el" in r) return r.el;
  return (
    // The shell highlights the app by its suite id ("meetings").
    <Frame shell={r.shell} active={"meetings" as "calendar"} me={r.me}>
      {r.me.perms["meetings.open"] ? (
        <ReadShell active="meetings">
          <MeetHome canCreate={!!r.me.perms["meetings.create"]} canGuests={!!r.me.perms["meetings.guests"]} />
        </ReadShell>
      ) : (
        <NoAccess name="Meet" />
      )}
    </Frame>
  );
}
