import { db } from "@/lib/db";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { blockedFolderIds } from "@/lib/folders";
import { route } from "@/lib/route";

/**
 * Dashboard folders. Folders nest through parentId. Restricted folders the
 * caller can't see are left out; ?access=<id> returns who can see one.
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const blocked = await blockedFolderIds(user.id, ws.id);
  const accessOf = new URL(req.url).searchParams.get("access");
  if (accessOf)
    return Response.json(await folderAccess(accessOf, ws.id, user.id, blocked));
  const folders = await db.folder.findMany({
    where: { workspaceId: ws.id, id: { notIn: blocked } },
    orderBy: { name: "asc" },
    include: {
      _count: { select: { projects: { where: { deletedAt: null } } } },
      hides: { where: { userId: user.id }, select: { userId: true } },
    },
  });
  return Response.json({
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      count: f._count.projects,
      restricted: f.restricted,
      hidden: f.hides.length > 0,
    })),
  });
}

/** "View access": the restricted folder that decides it, and the people who can see inside. */
async function folderAccess(
  id: string,
  workspaceId: string,
  userId: string,
  blocked: string[],
) {
  const folder = await db.folder.findFirst({ where: { id, workspaceId } });
  if (!folder || blocked.includes(id))
    throw new Response("Folder not found", { status: 404 });
  // The nearest restricted folder at or above this one controls access.
  let ruling: typeof folder | null = null;
  for (
    let cur: typeof folder | null = folder;
    cur && !ruling;
    cur = cur.parentId
      ? await db.folder.findUnique({ where: { id: cur.parentId } })
      : null
  ) {
    if (cur.restricted) ruling = cur;
  }
  const memberships = await db.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const members = ruling
    ? (
        await db.folderMember.findMany({
          where: { folderId: ruling.id },
          select: { userId: true },
        })
      ).map((m) => m.userId)
    : [];
  const me = memberships.find((m) => m.userId === userId);
  return {
    folder: { id: folder.id, name: folder.name, restricted: folder.restricted },
    inheritedFrom:
      ruling && ruling.id !== folder.id
        ? { id: ruling.id, name: ruling.name }
        : null,
    canManage: me?.role === "OWNER" || me?.role === "ADMIN",
    people: memberships.map((m) => ({
      id: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      // Without a restriction everyone in the workspace sees it.
      canSee:
        !ruling ||
        m.role === "OWNER" ||
        m.role === "ADMIN" ||
        members.includes(m.userId),
      member: members.includes(m.userId),
    })),
  };
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const { name, parentId } = (await req.json().catch(() => ({}))) as {
    name?: string;
    parentId?: string | null;
  };
  if (!name?.trim())
    return Response.json({ error: "Name is required" }, { status: 400 });
  if (
    parentId &&
    !(await db.folder.findFirst({
      where: { id: parentId, workspaceId: ws.id },
    }))
  ) {
    return Response.json({ error: "Parent folder not found" }, { status: 404 });
  }
  const folder = await db.folder.create({
    data: {
      workspaceId: ws.id,
      name: name.trim().slice(0, 60),
      parentId: parentId || null,
    },
  });
  return Response.json({ folder }, { status: 201 });
}

async function PATCH_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const { id, name, parentId, hidden, restricted, addMember, removeMember } =
    (await req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      parentId?: string | null;
      hidden?: boolean;
      restricted?: boolean;
      addMember?: string;
      removeMember?: string;
    };
  const folder = id
    ? await db.folder.findFirst({ where: { id, workspaceId: ws.id } })
    : null;
  if (!folder || (await blockedFolderIds(user.id, ws.id)).includes(folder.id))
    return Response.json({ error: "Folder not found" }, { status: 404 });
  // Hiding is personal: it only changes your own lists.
  if (hidden !== undefined) {
    if (hidden)
      await db.folderHide.upsert({
        where: { userId_folderId: { userId: user.id, folderId: folder.id } },
        create: { userId: user.id, folderId: folder.id },
        update: {},
      });
    else
      await db.folderHide.deleteMany({
        where: { userId: user.id, folderId: folder.id },
      });
    return Response.json({ ok: true });
  }
  // Who can see a folder is for owners and admins.
  if (restricted !== undefined || addMember || removeMember) {
    await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
    if (addMember) {
      if (
        !(await db.membership.findUnique({
          where: {
            userId_workspaceId: { userId: addMember, workspaceId: ws.id },
          },
        }))
      ) {
        return Response.json(
          { error: "Only people in this workspace can be added." },
          { status: 400 },
        );
      }
      await db.folderMember.upsert({
        where: { folderId_userId: { folderId: folder.id, userId: addMember } },
        create: { folderId: folder.id, userId: addMember },
        update: {},
      });
    }
    if (removeMember)
      await db.folderMember.deleteMany({
        where: { folderId: folder.id, userId: removeMember },
      });
    if (restricted !== undefined)
      await db.folder.update({
        where: { id: folder.id },
        data: { restricted },
      });
    return Response.json({ ok: true });
  }
  const data: { name?: string; parentId?: string | null } = {};
  if (name?.trim()) data.name = name.trim().slice(0, 60);
  if (parentId !== undefined) {
    // Refuse to move a folder into itself or one of its descendants.
    let cursor = parentId;
    while (cursor) {
      if (cursor === folder.id)
        return Response.json(
          { error: "A folder can't go inside itself." },
          { status: 400 },
        );
      cursor =
        (
          await db.folder.findUnique({
            where: { id: cursor },
            select: { parentId: true },
          })
        )?.parentId ?? null;
    }
    data.parentId = parentId || null;
  }
  return Response.json({
    folder: await db.folder.update({ where: { id: folder.id }, data }),
  });
}

/** Deleting a folder keeps its projects: they move up to the parent. */
async function DELETE_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const id = new URL(req.url).searchParams.get("id");
  const folder = id
    ? await db.folder.findFirst({ where: { id, workspaceId: ws.id } })
    : null;
  if (!folder)
    return Response.json({ error: "Folder not found" }, { status: 404 });
  await db.$transaction([
    db.project.updateMany({
      where: { folderId: folder.id },
      data: { folderId: folder.parentId },
    }),
    db.folder.updateMany({
      where: { parentId: folder.id },
      data: { parentId: folder.parentId },
    }),
    db.folder.delete({ where: { id: folder.id } }),
  ]);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
