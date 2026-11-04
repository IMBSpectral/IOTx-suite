import Sidebar from "@/components/Sidebar";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { currentWorkspace } from "@/lib/workspace";

/** Every build request across the workspace, newest first. */
export default async function ChatsPage() {
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);

  const messages = await db.message.findMany({
    where: { role: "USER", project: { workspaceId: ws.id } },
    orderBy: { createdAt: "desc" },
    take: 60,
    include: {
      project: { select: { id: true, name: true } },
      build: { select: { status: true, creditsUsed: true } },
    },
  });

  return (
    <>
      <Sidebar userId={userId} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <h1 className="mb-1 text-xl font-semibold tracking-tight">Chats</h1>
          <p className="mb-6 text-sm" style={{ color: "var(--muted)" }}>
            Everything you have asked for, across all projects.
          </p>

          {messages.length === 0 ? (
            <p
              className="rounded-xl border border-dashed px-6 py-14 text-center text-sm"
              style={{ color: "var(--muted)" }}
            >
              No requests yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {messages.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/projects/${m.project.id}`}
                    className="block rounded-xl border p-4 transition-colors hover:bg-black/[.02] dark:hover:bg-white/[.03]"
                    style={{ background: "var(--panel)" }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-xs font-medium">
                        {m.project.name}
                      </span>
                      <span className="shrink-0 text-xs" style={{ color: "var(--muted)" }}>
                        {m.createdAt.toLocaleDateString()}
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed">
                      {m.content}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
