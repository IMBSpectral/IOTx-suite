import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import AiUsage from "@/components/iotx/AiUsage";

/** Admin → AI usage inside the shell (workspace owners and admins; the API checks). */
export default async function AdminAiUsagePage() {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="admin">
        <AiUsage />
      </Shell>
    </main>
  );
}
