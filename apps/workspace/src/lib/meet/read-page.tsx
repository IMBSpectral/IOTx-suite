import { boot, Frame, type Boot } from "@/lib/page";
import type { Me } from "@/lib/auth";
import NoAccess from "@/components/NoAccess";
import ReadShell, { type Section } from "@/components/meet/read/ReadShell";

/** A Meet section page (Ask, For You, Coaching…) in the suite shell with the Meet left nav. */
export async function readPage(section: Section, path: string, render: (b: { me: Me; boot: Boot }) => React.ReactNode) {
  const r = await boot("meetings", path);
  if ("el" in r) return r.el;
  return (
    <Frame shell={r.shell} active={"meetings" as "calendar"} me={r.me}>
      {r.me.perms["meetings.open"] ? <ReadShell active={section}>{render({ me: r.me, boot: r.boot })}</ReadShell> : <NoAccess name="Meet" />}
    </Frame>
  );
}
