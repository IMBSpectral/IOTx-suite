import MembersPanel from "@/components/MembersPanel";
import TeamExtras from "@/components/TeamExtras";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { currentWorkspace } from "@/lib/workspace";

export default async function MembersPage() {
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);

  const members = await db.membership.findMany({
    where: { workspaceId: ws.id },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  const me = members.find((m) => m.userId === userId);
  const canManage = me?.role === "OWNER" || me?.role === "ADMIN";

  return (
    <>
    <MembersPanel
      canManage={canManage}
      currentUserId={userId}
      initialMembers={members.map((m) => ({
        id: m.id,
        role: m.role,
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
      }))}
    />
    <TeamExtras />
    </>
  );
}
