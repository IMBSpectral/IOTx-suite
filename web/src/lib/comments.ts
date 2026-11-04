import { db } from "./db";
import { notify, projectAdmins } from "./sharing";

export const REACTIONS = ["👍", "❤️", "🎉", "👀", "✅"] as const;
type Reactions = Record<string, string[]>;

export type CommentView = {
  id: string;
  body: string;
  author: { id: string | null; name: string; guest: boolean; via?: string };
  createdAt: string;
  editedAt: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  mine: boolean;
};
export type ThreadView = CommentView & {
  locator: string | null;
  selector: string | null;
  elementText: string | null;
  /** A picture of the element when the thread started (GET ?shot=<id>). */
  hasShot: boolean;
  resolvedAt: string | null;
  unread: boolean;
  replies: CommentView[];
};

/** Threads for the comments panel, newest activity first. */
export async function listThreads(projectId: string, userId: string) {
  const [rows, visit, links] = await Promise.all([
    db.comment.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      omit: { elementShot: true },
    }),
    db.projectVisit.findUnique({
      where: { userId_projectId: { userId, projectId } },
    }),
    db.previewLink.findMany({
      where: { projectId },
      select: { id: true, name: true },
    }),
  ]);
  const users = await db.user.findMany({
    where: {
      id: {
        in: [
          ...new Set(
            rows.map((r) => r.authorId).filter((x): x is string => !!x),
          ),
        ],
      },
    },
    select: { id: true, name: true, email: true },
  });
  const nameOf = new Map(
    users.map((u) => [u.id, u.name ?? u.email ?? "Someone"]),
  );
  const linkName = new Map(links.map((l) => [l.id, l.name]));
  const readAt = visit?.commentsReadAt?.getTime() ?? 0;

  const view = (r: (typeof rows)[number]): CommentView => {
    const reactions = (r.reactions as Reactions | null) ?? {};
    return {
      id: r.id,
      body: r.body,
      author: r.authorId
        ? {
            id: r.authorId,
            name: nameOf.get(r.authorId) ?? "Someone",
            guest: false,
          }
        : {
            id: null,
            name: r.guestName ?? "Guest",
            guest: true,
            via: r.previewLinkId ? linkName.get(r.previewLinkId) : undefined,
          },
      createdAt: r.createdAt.toISOString(),
      editedAt: r.editedAt?.toISOString() ?? null,
      reactions: Object.entries(reactions)
        .filter(([, who]) => who.length)
        .map(([emoji, who]) => ({
          emoji,
          count: who.length,
          mine: who.includes(userId),
        })),
      mine: r.authorId === userId,
    };
  };

  const threads: ThreadView[] = rows
    .filter((r) => !r.parentId)
    .map((root) => {
      const replies = rows.filter((r) => r.parentId === root.id);
      const latest = Math.max(
        root.createdAt.getTime(),
        ...replies.map((r) => r.createdAt.getTime()),
      );
      const othersLatest = [root, ...replies]
        .filter((r) => r.authorId !== userId)
        .reduce((n, r) => Math.max(n, r.createdAt.getTime()), 0);
      return {
        ...view(root),
        locator: root.locator,
        selector: root.selector,
        elementText: root.elementText,
        hasShot: false,
        resolvedAt: root.resolvedAt?.toISOString() ?? null,
        unread: othersLatest > readAt,
        replies: replies.map(view),
        _latest: latest,
      };
    })
    .sort((a, b) => b._latest - a._latest)
    .map(({ _latest, ...t }) => (void _latest, t));
  // Which threads have a picture, without loading the pictures.
  const shots = new Set(
    (
      await db.comment.findMany({
        where: { projectId, parentId: null, elementShot: { not: null } },
        select: { id: true },
      })
    ).map((r) => r.id),
  );
  return threads.map((t) => ({ ...t, hasShot: shots.has(t.id) }));
}

/** Only small JPEG/PNG data URLs from the preview are kept. */
export function cleanShot(v: unknown): string | null {
  return typeof v === "string" &&
    /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v) &&
    v.length <= 700_000
    ? v
    : null;
}

/**
 * People to tell about a new comment: anyone @mentioned (by name or email
 * among the project's people), everyone already in the thread, and, for a
 * new thread, the project's admins. Never the author.
 */
export async function notifyComment(opts: {
  project: { id: string; workspaceId: string; name: string };
  authorId: string | null;
  authorName: string;
  body: string;
  threadId: string;
}) {
  const { project } = opts;
  const [members, collabs, thread] = await Promise.all([
    db.membership.findMany({
      where: { workspaceId: project.workspaceId },
      include: { user: true },
    }),
    db.collaborator.findMany({ where: { projectId: project.id } }),
    db.comment.findMany({
      where: { OR: [{ id: opts.threadId }, { parentId: opts.threadId }] },
      select: { authorId: true },
    }),
  ]);
  const collabUsers = await db.user.findMany({
    where: { id: { in: collabs.map((c) => c.userId) } },
  });
  const people = [...members.map((m) => m.user), ...collabUsers];
  const text = opts.body.toLowerCase();
  const mentioned = people
    .filter((u) => {
      const handles = [u.email, u.name?.split(" ")[0], u.name]
        .filter(Boolean)
        .map((h) => `@${h!.toLowerCase()}`);
      return handles.some((h) => text.includes(h));
    })
    .map((u) => u.id);
  const participants = thread
    .map((c) => c.authorId)
    .filter((x): x is string => !!x);
  const isNewThread = thread.length === 1;
  const admins = isNewThread ? await projectAdmins(project) : [];
  const to = [...new Set([...mentioned, ...participants, ...admins])].filter(
    (id) => id !== opts.authorId,
  );
  await notify(to, {
    projectId: project.id,
    kind: "comment",
    title: `${opts.authorName} commented on ${project.name}`,
    body: opts.body.slice(0, 140),
    href: `/projects/${project.id}?comments=${opts.threadId}`,
  });
}
