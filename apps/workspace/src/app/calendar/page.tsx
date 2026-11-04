import type { Metadata } from "next";
import { boot, Frame } from "@/lib/page";
import NoAccess from "@/components/NoAccess";
import CalendarApp from "@/components/calendar/CalendarApp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Calendar" };

export default async function Page() {
  const r = await boot("calendar", "/calendar");
  if ("el" in r) return r.el;
  return (
    <Frame shell={r.shell} active="calendar" me={r.me}>
      {r.me.perms["calendar.open"] ? <CalendarApp boot={r.boot} /> : <NoAccess name="Calendar" />}
    </Frame>
  );
}
