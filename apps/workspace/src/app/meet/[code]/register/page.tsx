import type { Metadata } from "next";
import { db } from "@/lib/db";
import { CODE_RE } from "@/lib/meet/meetings";
import RegisterForm from "@/components/meet/RegisterForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Register", robots: { index: false } };

/** /workspace/meet/<code>/register: public webinar registration (no sign-in). */
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toLowerCase();
  const m = CODE_RE.test(code) ? await db.meeting.findUnique({ where: { code } }) : null;
  const host = m ? await db.user.findUnique({ where: { id: m.hostId } }) : null;
  if (!m || m.kind !== "webinar")
    return (
      <div className="mt-root mt-dark">
        <div className="mt-center">
          <h1>There&apos;s no webinar here</h1>
          <p>Check the link, or ask the organizer to send it again.</p>
        </div>
      </div>
    );
  return (
    <RegisterForm
      webinar={{
        code: m.code,
        title: m.title,
        host: host?.name ?? host?.email ?? "The host",
        startsAt: m.startsAt ? m.startsAt.toISOString() : null,
        open: m.registration && !m.endedAt,
        approval: m.regApproval,
        registration: m.registration,
      }}
    />
  );
}
