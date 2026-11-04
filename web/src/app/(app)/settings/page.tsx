import WorkspaceForm from "@/components/WorkspaceForm";
import AnnouncementsAdmin from "@/components/AnnouncementsAdmin";
import { auth } from "@/lib/auth";
import { currentWorkspace } from "@/lib/workspace";
import { db } from "@/lib/db";

export default async function WorkspaceSettingsPage() {
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);

  const [projects, membership] = await Promise.all([
    db.project.count({ where: { workspaceId: ws.id, deletedAt: null } }),
    db.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: ws.id } },
    }),
  ]);

  const canEdit = membership?.role === "OWNER" || membership?.role === "ADMIN";

  return (
    <div className="space-y-8">
      <WorkspaceForm initialName={ws.name} canEdit={canEdit} />

      <section>
        <h2 className="mb-3 text-sm font-medium">Details</h2>
        <dl
          className="divide-y rounded-xl border text-sm"
          style={{ background: "var(--panel)" }}
        >
          {[
            ["Plan", ws.plan],
            ["Projects", String(projects)],
            ["Your role", membership?.role ?? "—"],
            ["Workspace ID", ws.slug],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between px-4 py-3">
              <dt style={{ color: "var(--muted)" }}>{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      {canEdit && (
        <section>
          <h2 className="mb-1 text-sm font-medium">Announcements for members</h2>
          <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
            A banner everyone in this workspace sees on their dashboard, with an optional link, end date and countdown.
          </p>
          <AnnouncementsAdmin endpoint="/api/workspace/announcements" />
        </section>
      )}
    </div>
  );
}
