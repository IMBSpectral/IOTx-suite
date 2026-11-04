import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import RolesAdmin from "@/components/iotx/RolesAdmin";

/** Admin → Roles & permissions inside the shell (the owner, and anyone with "Manage roles and permissions"). */
export default async function AdminRolesPage() {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="admin">
        {data.perms?.canManage ? (
          <RolesAdmin />
        ) : (
          <div className="ix-soon">
            <h1>Roles are managed by the owner</h1>
            <p style={{ color: "var(--ix-muted)" }}>Managing roles needs &quot;Manage roles and permissions&quot;. Ask the workspace owner.</p>
          </div>
        )}
      </Shell>
    </main>
  );
}
