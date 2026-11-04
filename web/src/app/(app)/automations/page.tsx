import Sidebar from "@/components/Sidebar";
import AutomationsPanel from "@/components/AutomationsPanel";
import { auth } from "@/lib/auth";
import { currentWorkspace } from "@/lib/workspace";
import { listProjects } from "@/lib/projects";

export default async function AutomationsPage() {
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);
  const projects = await listProjects({ userId, workspaceId: ws.id, take: 100 });
  return (
    <>
      <Sidebar userId={userId} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <h1 className="mb-1 text-xl font-semibold tracking-tight">Automations</h1>
          <AutomationsPanel projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
        </div>
      </main>
    </>
  );
}
