import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projectAccess } from "@/lib/workspace";
import { ROLE_FOR } from "@/lib/sharing";

/** Invite link: "Anyone with the link can view/edit". Joining adds you as a collaborator. */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await auth();
  const userId = session!.user!.id;

  const project = await db.project.findUnique({ where: { linkToken: token } });
  if (!project || !project.linkAccess || project.deletedAt) {
    return (
      <main className="grid flex-1 place-items-center p-6 text-center">
        <div>
          <h1 className="text-lg font-semibold">This invite link isn&apos;t active</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            It was turned off or reset. Ask the project owner for a new one.
          </p>
          <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium hover:underline">
            Go to your dashboard
          </Link>
        </div>
      </main>
    );
  }

  const want = project.linkAccess === "edit" ? "edit" : "view";
  const have = await projectAccess(userId, project);
  if (have === "admin" || have === want || have === "edit") redirect(`/projects/${project.id}`);

  const [ws, member] = await Promise.all([
    db.workspace.findUnique({ where: { id: project.workspaceId } }),
    db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: project.workspaceId } } }),
  ]);
  if (!member && !ws?.allowExternalCollaborators) {
    return (
      <main className="grid flex-1 place-items-center p-6 text-center">
        <p className="text-sm">This workspace only shares projects with its members.</p>
      </main>
    );
  }

  await db.collaborator.upsert({
    where: { projectId_userId: { projectId: project.id, userId } },
    create: { projectId: project.id, userId, role: ROLE_FOR[want] },
    update: { role: ROLE_FOR[want] },
  });
  redirect(`/projects/${project.id}`);
}
