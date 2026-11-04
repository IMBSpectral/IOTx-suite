import Sidebar from "@/components/Sidebar";
import ChatFiles from "@/components/ChatFiles";
import { auth } from "@/lib/auth";
import { currentWorkspace } from "@/lib/workspace";
import { listProjects } from "@/lib/projects";
import { listUploads } from "@/lib/uploads";

/** "Chat files": everything attached in chat across the workspace's projects. */
export default async function ChatFilesPage() {
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);
  const projects = await listProjects({ userId, workspaceId: ws.id, take: 200 });
  const files = (
    await Promise.all(
      projects.map(async (p) => (await listUploads(p.id)).map((f) => ({ ...f, projectId: p.id, projectName: p.name }))),
    )
  )
    .flat()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 500);
  return (
    <>
      <Sidebar userId={userId} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-10">
          <h1 className="text-xl font-semibold tracking-tight">Chat files</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            Everything you&apos;ve attached in chat, across your projects.
          </p>
          <ChatFiles files={files} />
        </div>
      </main>
    </>
  );
}
