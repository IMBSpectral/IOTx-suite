import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getMe, passUrl } from "@/lib/auth";
import { db } from "@/lib/db";
import { CODE_RE, publicInfo } from "@/lib/meet/meetings";
import MeetRoot from "@/components/meet/MeetRoot";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Meet", robots: { index: false } };

/**
 * /workspace/meet/<code>: anyone with the link. Members of the meeting's
 * workspace join with their session; everyone else as a guest (name only).
 */
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toLowerCase();
  const m = CODE_RE.test(code) ? await db.meeting.findUnique({ where: { code } }) : null;
  if (!m)
    return (
      <div className="mt-root mt-dark">
        <div className="mt-center">
          <h1>There&apos;s no meeting with that code</h1>
          <p>Check the link, or ask the host to send it again.</p>
        </div>
      </div>
    );
  // Uploaded, in-person and captured meetings have no room: their page is the report.
  if (["upload", "inperson", "external"].includes(m.kind)) redirect(`/meet/${m.code}/notes`);
  const me = await getMe();
  const info = await publicInfo(m, me);
  return <MeetRoot info={info} signInUrl={passUrl("meetings", `/meet/${m.code}`)} />;
}
