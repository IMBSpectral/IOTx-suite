import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import MailApp from "@/components/mail/MailApp";

/** Mail: connected mailboxes, read and sent inside the suite. */
export default async function MailPage() {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (!data.perms?.apps.includes("mail")) redirect("/home");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="mail">
        <MailApp />
      </Shell>
    </main>
  );
}
