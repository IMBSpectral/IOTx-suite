import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { shellData } from "@/lib/iotx/shell";
import { currentWorkspace } from "@/lib/workspace";
import Shell from "@/components/iotx/Shell";
import FilesApp from "@/components/iotx/FilesApp";

/** Files: the company's own file storage. */
export default async function DrivePage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await auth();
  const userId = session!.user!.id;
  const data = await shellData(userId);
  if (!data) redirect("/welcome");
  if (!data.perms?.apps.includes("files")) redirect("/home");
  const ws = await currentWorkspace(userId);
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: ws.id } }, select: { role: true } });
  const { view } = await searchParams;
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="files">
        <FilesApp admin={m?.role === "OWNER" || m?.role === "ADMIN"} initialView={view === "shared" || view === "trash" ? view : "mine"} />
      </Shell>
    </main>
  );
}
