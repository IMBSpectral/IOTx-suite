import { notFound } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import RequestAccess from "@/components/RequestAccess";
import Editor from "@/components/Editor";
import { auth } from "@/lib/auth";
import { requireProject } from "@/lib/workspace";
import { db } from "@/lib/db";
import { previewUrl } from "@/lib/preview";
import {
  turnStatus,
  type Attachment,
  type Mode,
  type Task,
} from "@/components/chat/types";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ chat?: string; draft?: string }>;
}) {
  const { id } = await params;
  const { chat, draft } = await searchParams;
  const session = await auth();
  const userId = session!.user!.id;
  let project;
  try {
    project = await requireProject(userId, id);
  } catch (e) {
    if (!(e instanceof Response)) throw e;
    if (e.status === 404) notFound();
    return (
      <>
        <Sidebar userId={userId} />
        <RequestAccess projectId={id} />
      </>
    );
  }
  if (project.deletedAt) notFound();

  // ?chat=<id> opens one of the project's other chats; otherwise the main chat.
  const chatId =
    chat &&
    (await db.projectChat.findFirst({
      where: { id: chat, projectId: id },
      select: { id: true },
    }))
      ? chat
      : null;
  const [loaded] = await Promise.all([
    db.message
      .findMany({
        where: { projectId: id, chatId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          content: true,
          steps: true,
          mode: true,
          feedback: true,
          attachments: true,
          build: {
            select: {
              id: true,
              status: true,
              creditsUsed: true,
              startedAt: true,
              endedAt: true,
              sha: true,
              undone: true,
            },
          },
        },
      })
      // A failed history load shows an error with Retry instead of an empty chat.
      .catch((e) => {
        console.error("chat history", e);
        return null;
      }),
    // "Recently viewed" on the dashboard.
    db.projectVisit.upsert({
      where: { userId_projectId: { userId, projectId: id } },
      create: { userId, projectId: id },
      update: { at: new Date() },
    }),
  ]);
  const messages = loaded ?? [];

  // A link to a draft (?draft=<id>) that's no longer open explains what happened to it.
  let draftNotice: string | null = null;
  if (draft) {
    const d = await db.draft.findFirst({
      where: { id: draft, projectId: id },
      select: { name: true, status: true, mergedAt: true },
    });
    if (!d)
      draftNotice =
        "This draft is already accepted or deleted. You're looking at the current version.";
    else if (d.status === "MERGED")
      draftNotice = `"${d.name}" was already accepted${d.mergedAt ? ` on ${d.mergedAt.toLocaleDateString()}` : ""}. Its changes are part of the project now.`;
    else if (d.status === "REVERTED")
      draftNotice = `"${d.name}" was discarded. You're looking at the current version.`;
  }
  const initialPreview = await previewUrl(
    id,
    userId,
    project.headSha ?? "init",
  );

  return (
    <>
      <Editor
        key={chatId ?? "main"}
        chatId={chatId}
        draftNotice={draftNotice}
        sidebar={<Sidebar userId={userId} activeProjectId={id} />}
        projectId={id}
        projectName={project.name}
        projectEmoji={project.emoji}
        initialPreview={initialPreview}
        initialPublishedUrl={
          project.publishedSha ? `/live/${project.subdomain}` : null
        }
        initialTasks={(project.tasks as Task[] | null) ?? []}
        initialQueuePaused={project.queuePaused}
        initialIsTemplate={project.isTemplate}
        access={project.access}
        kind={project.kind}
        subdomain={project.subdomain}
        customDomain={project.customDomain}
        historyError={loaded === null}
        initialMessages={messages.map((m) => {
          const b = m.build;
          return {
            id: m.id,
            role:
              m.role === "USER" ? ("user" as const) : ("assistant" as const),
            content: m.content,
            files: Array.isArray(m.steps) ? (m.steps as string[]) : [],
            mode: (m.mode as Mode) ?? "build",
            feedback: (m.feedback as "up" | "down" | null) ?? null,
            attachments: (m.attachments as Attachment[] | null) ?? undefined,
            buildId: b?.id,
            status: turnStatus(b?.status),
            credits: b?.creditsUsed || undefined,
            durationMs:
              b?.startedAt && b?.endedAt
                ? b.endedAt.getTime() - b.startedAt.getTime()
                : undefined,
            sha: b?.sha ?? null,
            undone: b?.undone ?? false,
          };
        })}
      />
    </>
  );
}
