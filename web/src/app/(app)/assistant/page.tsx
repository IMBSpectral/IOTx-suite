import Sidebar from "@/components/Sidebar";
import AssistantPanel from "@/components/AssistantPanel";
import { auth } from "@/lib/auth";
import { currentWorkspace } from "@/lib/workspace";
import { listProjects } from "@/lib/projects";
import { listUploads } from "@/lib/uploads";

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  const { prompt } = await searchParams;
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);
  const projects = await listProjects({ userId, workspaceId: ws.id, take: 100 });
  // Chat files across the workspace, newest first, for "Add a file".
  const files = (
    await Promise.all(projects.slice(0, 50).map(async (p) => (await listUploads(p.id)).map((f) => ({ projectId: p.id, uploadId: f.id, name: f.name, at: f.at }))))
  )
    .flat()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 100);
  return (
    <>
      <Sidebar userId={userId} />
      <main className="flex min-w-0 flex-1 flex-col">
        <AssistantPanel projects={projects.map((p) => ({ id: p.id, name: p.name }))} files={files} initialPrompt={(prompt ?? "").slice(0, 2000)} />
      </main>
    </>
  );
}
