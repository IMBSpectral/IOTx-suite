import Sidebar from "@/components/Sidebar";
import HelpCenter from "@/components/HelpCenter";
import { auth } from "@/lib/auth";
import { listProjects } from "@/lib/projects";
import { currentWorkspace } from "@/lib/workspace";

export default async function HelpPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);
  const projects = await listProjects({ userId, workspaceId: ws.id, take: 50 });
  return (
    <>
      <Sidebar userId={userId} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-10">
          <h1 className="mb-5 text-xl font-semibold tracking-tight">Help</h1>
          <HelpCenter initialQuery={q} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
        </div>
      </main>
    </>
  );
}
