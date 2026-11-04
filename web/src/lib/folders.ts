import { db } from "./db";

type Node = {
  id: string;
  parentId: string | null;
  restricted: boolean;
  member: boolean;
};

/**
 * Folders whose projects someone can't see because of folder-level access:
 * the folder, or a folder above it, is restricted and they aren't one of its
 * members. Workspace owners and admins see everything.
 */
export async function blockedFolderIds(
  userId: string,
  workspaceId: string,
): Promise<string[]> {
  const m = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (m?.role === "OWNER" || m?.role === "ADMIN") return [];
  const rows = await db.folder.findMany({
    where: { workspaceId },
    select: {
      id: true,
      parentId: true,
      restricted: true,
      members: { where: { userId }, select: { userId: true } },
    },
  });
  if (!rows.some((r) => r.restricted)) return [];
  const byId = new Map<string, Node>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        parentId: r.parentId,
        restricted: r.restricted,
        member: r.members.length > 0,
      },
    ]),
  );
  return rows.filter((r) => isBlocked(r.id, byId)).map((r) => r.id);
}

function isBlocked(id: string, byId: Map<string, Node>) {
  const seen = new Set<string>();
  for (
    let cur = byId.get(id);
    cur && !seen.has(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  ) {
    seen.add(cur.id);
    if (cur.restricted && !cur.member) return true;
  }
  return false;
}

