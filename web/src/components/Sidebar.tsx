import Link from "next/link";
import SearchTrigger from "./SearchTrigger";
import NotificationsBell from "./NotificationsBell";
import { db } from "@/lib/db";
import { visibleTo } from "@/lib/projects";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import SidebarLink from "./SidebarLink";
import ThemeToggle from "./ThemeToggle";
import { SIDEBAR_ROW } from "./sidebar-styles";
import { currentWorkspace } from "@/lib/workspace";
import { creditSummary } from "@/lib/billing-cycle";
import { freeBuildHour } from "@/lib/credits";
import CreditNotices from "./CreditNotices";
import { effectiveForRequest } from "@/lib/iotx/permissions";

export default async function Sidebar({
  userId,
  activeProjectId,
}: {
  userId: string;
  activeProjectId?: string;
}) {
  const ws = await currentWorkspace(userId);
  const credits = await creditSummary(ws.id);
  // IOTx Suite: without the Builder switch the Builder's own entries are hidden (the server refuses them too).
  const perms = await effectiveForRequest(userId, ws.id);
  const builder = !perms || perms.keys.includes("builder.open");
  const canCreate = builder && (!perms || perms.keys.includes("builder.project.create"));
  // Background work: the agent keeps going after you leave a project.
  const active = await db.build.groupBy({
    by: ["projectId", "status"],
    where: { status: { in: ["RUNNING", "QUEUED"] }, project: { workspaceId: ws.id, deletedAt: null } },
    _count: { _all: true },
  });
  const activeProjects = active.length
    ? await db.project.findMany({ where: { id: { in: [...new Set(active.map((a) => a.projectId))] } }, select: { id: true, name: true } })
    : [];
  const working = activeProjects.map((p) => ({
    ...p,
    running: active.some((a) => a.projectId === p.id && a.status === "RUNNING"),
    queued: active.filter((a) => a.projectId === p.id && a.status === "QUEUED").reduce((n, a) => n + a._count._all, 0),
  }));
  const me = await db.user.findUnique({ where: { id: userId }, select: { deletionScheduledAt: true } });
  const memberships = await db.membership.findMany({
    where: { userId },
    include: { workspace: { select: { id: true, name: true, plan: true } } },
    orderBy: { createdAt: "asc" },
  });
  const recents = await db.project.findMany({
    where: { workspaceId: ws.id, deletedAt: null, ...(await visibleTo(userId, ws.id)) },
    orderBy: { updatedAt: "desc" },
    take: 6,
    select: { id: true, name: true, emoji: true },
  });

  // Sits on the shell background beside the inset page surface, like Lovable's.
  return (
    <aside className="flex w-64 shrink-0 flex-col px-2 pb-2">
      <div className="flex h-14 items-center gap-1">
        <WorkspaceSwitcher
          current={{ id: ws.id, name: ws.name, plan: ws.plan }}
          workspaces={memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, plan: m.workspace.plan }))}
        />
        <NotificationsBell />
      </div>

      <nav className="space-y-px">
        <SidebarLink href="/home" label="Home" icon="home" exact />
        {canCreate && <SidebarLink href="/dashboard" label="New project" icon="new" exact />}
        <SearchTrigger />
        <SidebarLink href="/assistant" label="Assistant" icon="assistant" />
        <SidebarLink href="/dashboard/projects" label="Projects" icon="projects" />
        <SidebarLink href="/chats" label="Chats" icon="chats" />
        <SidebarLink href="/files" label="Chat files" icon="files" />
        {builder && <SidebarLink href="/automations" label="Automations" icon="automations" />}
        <SidebarLink href="/settings" label="Settings" icon="settings" />
        <SidebarLink href="/help" label="Help" icon="help" />
      </nav>

      <div className="mt-5 min-h-0 flex-1 space-y-px overflow-y-auto">
        {working.length > 0 && (
          <>
            <p className="flex h-7 items-center px-2 text-xs font-medium" style={{ color: "var(--muted)" }}>
              Working now
            </p>
            {working.map((p) => (
              <Link key={`w-${p.id}`} href={`/projects/${p.id}`} className={SIDEBAR_ROW} title={p.running ? "The agent is working on this in the background" : "Queued"}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.running ? "animate-pulse bg-emerald-500" : "bg-amber-500"}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-[11px]" style={{ color: "var(--muted)" }}>
                  {p.running ? "Running" : ""}
                  {p.running && p.queued ? " · " : ""}
                  {p.queued ? `${p.queued} queued` : ""}
                </span>
              </Link>
            ))}
          </>
        )}
        <p className="flex h-7 items-center px-2 text-xs font-medium" style={{ color: "var(--muted)" }}>
          Recents
        </p>
        {recents.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            aria-current={p.id === activeProjectId ? "page" : undefined}
            className={`${SIDEBAR_ROW} ${p.id === activeProjectId ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
          >
            <span className="w-4 shrink-0 text-center text-xs leading-none">{p.emoji ?? ""}</span>
            <span className="truncate">{p.name}</span>
          </Link>
        ))}
        {recents.length === 0 && (
          <p className="px-2 py-1.5 text-sm" style={{ color: "var(--muted)" }}>
            Nothing yet
          </p>
        )}
      </div>

      <div className="space-y-1.5 pt-2">
        {me?.deletionScheduledAt && (
          <Link href="/settings/privacy" className="block rounded-xl border border-red-500/40 px-3 py-2 text-xs hover:bg-red-500/[.06]">
            <span className="block font-medium text-red-600 dark:text-red-400">Account deletion scheduled</span>
            <span style={{ color: "var(--muted)" }}>
              On {me.deletionScheduledAt.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}. Keep your account in Privacy.
            </span>
          </Link>
        )}
        <CreditNotices summary={credits} freeBuildEndsAt={freeBuildHour()?.endsAt ?? null} />
        <ThemeToggle />
        <Link href="/settings/billing" className={`${SIDEBAR_ROW} justify-between`}>
          <span style={{ color: "var(--muted)" }}>Credits</span>
          <span className="font-medium tabular-nums">{credits.balance}</span>
        </Link>
      </div>
    </aside>
  );
}
