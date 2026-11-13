import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import Fleet from "@/components/iotx/Fleet";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { isFleetControl } from "@/lib/fleet";

/** Admin → Deployments: every server, its deploy log and its AI usage (control server, platform admins). */
export default async function AdminDeploymentsPage() {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (!isFleetControl() || !isPlatformAdmin(data.user.email)) redirect("/home");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="admin">
        <Fleet />
      </Shell>
    </main>
  );
}
