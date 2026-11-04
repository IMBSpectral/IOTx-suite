import Sidebar from "@/components/Sidebar";
import Composer from "@/components/Composer";
import WhatsNew from "@/components/WhatsNew";
import AnnouncementBanner from "@/components/AnnouncementBanner";
import WorkspaceClaims from "@/components/WorkspaceClaims";
import WelcomePrompt from "@/components/WelcomePrompt";
import FeatureChecklist from "@/components/FeatureChecklist";
import Link from "next/link";
import ProjectThumb from "@/components/ProjectThumb";
import { auth } from "@/lib/auth";
import { currentWorkspace } from "@/lib/workspace";
import { listProjects } from "@/lib/projects";
import { listLibrary } from "@/lib/library";
import { dashboardNudge } from "@/lib/nudges";
import { formatDistanceToNow } from "date-fns";
import { redirect } from "next/navigation";
import { effectiveForRequest } from "@/lib/iotx/permissions";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>;
}) {
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);
  // IOTx Suite: the Builder dashboard is for people with the Builder switch; everyone else chats from Home.
  const perms = await effectiveForRequest(userId, ws.id);
  if (perms && !perms.keys.includes("builder.open")) redirect("/home");
  const canCreate = !perms || perms.keys.includes("builder.project.create");
  // "Where you left off": what you opened last, else the workspace's latest.
  const opened = await listProjects({
    userId,
    workspaceId: ws.id,
    view: "recent",
    take: 6,
  });
  const projects = opened.length
    ? opened
    : await listProjects({ userId, workspaceId: ws.id, view: "all", take: 6 });
  // Assets strip: the newest images in those projects (scaffold icons left out).
  const assets = (
    await Promise.all(
      projects.map((p) =>
        listLibrary(p.id)
          .then((items) =>
            items
              .filter(
                (i) =>
                  i.kind === "image" &&
                  !/favicon|placeholder|^icon[-.]/i.test(i.name),
              )
              .map((i) => ({ ...i, projectId: p.id, projectName: p.name })),
          )
          .catch(() => []),
      ),
    )
  )
    .flat()
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, 8);
  const nudge = await dashboardNudge(userId, ws.id, projects).catch(() => null);
  // A link like /dashboard?prompt=… arrives with the box already filled in.
  const { prompt } = await searchParams;

  const firstName = session?.user?.name?.split(" ")[0];

  return (
    <>
      <Sidebar userId={userId} />
      <main className="relative flex-1 overflow-y-auto">
        <div
          aria-hidden
          className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-[560px]"
        />
        <div className="relative mx-auto w-full max-w-5xl px-8 pb-16 pt-[14vh]">
          <AnnouncementBanner />
          <WorkspaceClaims />
          <WelcomePrompt />
          <FeatureChecklist />
          <div className="mx-auto max-w-[672px]">
            <h1 className="text-center text-[34px] font-semibold leading-tight tracking-[-0.02em]">
              {firstName
                ? `What are you building, ${firstName}?`
                : "What are you building?"}
            </h1>
            {nudge && (
              <p
                className="mt-2 text-center text-sm"
                style={{ color: "var(--muted)" }}
                data-testid="dashboard-nudge"
              >
                {nudge.text}
                {nudge.href && nudge.cta && (
                  <>
                    {" "}
                    <Link
                      href={nudge.href}
                      className="font-medium underline"
                      style={{ color: "var(--text)" }}
                    >
                      {nudge.cta}
                    </Link>
                  </>
                )}
              </p>
            )}

            <div className="mt-7">
              {canCreate ? (
                <Composer initialPrompt={(prompt ?? "").slice(0, 4000)} />
              ) : (
                <div className="rounded-3xl border p-5 text-sm" style={{ background: "var(--panel)", color: "var(--muted)" }}>
                  Creating projects isn&apos;t turned on for your role. You can open the projects shared with you, or ask an admin.
                </div>
              )}
              <WhatsNew />
            </div>
          </div>

          <div className="mt-20">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">
                {opened.length ? "Where you left off" : "Recent projects"}
              </h2>
              <Link
                href="/dashboard/projects"
                className="text-xs hover:underline"
                style={{ color: "var(--muted)" }}
              >
                View all
              </Link>
            </div>

            {projects.length === 0 ? (
              <div
                className="rounded-xl border border-dashed px-6 py-14 text-center text-sm"
                style={{ color: "var(--muted)" }}
              >
                Your projects will appear here.
              </div>
            ) : (
              <ul className="grid gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/projects/${p.id}`}
                      className="card-lift group block rounded-xl p-1"
                    >
                      <ProjectThumb
                        id={p.id}
                        name={p.name}
                        emoji={p.emoji}
                        kind={p.kind}
                        live={!!p.publishedAt}
                      />
                      <div className="px-1 pt-2.5">
                        <p className="truncate text-sm font-medium">{p.name}</p>
                        <p
                          className="mt-0.5 flex items-center gap-1.5 truncate text-[13px]"
                          style={{ color: "var(--muted)" }}
                        >
                          {p.unpublishedChanges ? (
                            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-px text-[11px] font-medium text-amber-700 dark:text-amber-300">
                              Unpublished changes
                            </span>
                          ) : p.publishedAt ? (
                            <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-px text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                              Live
                            </span>
                          ) : null}
                          <span className="truncate">
                            {p.viewedAt
                              ? `Opened ${formatDistanceToNow(new Date(p.viewedAt), { addSuffix: true })}`
                              : `Edited ${formatDistanceToNow(new Date(p.updatedAt), { addSuffix: true })}`}
                          </span>
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {assets.length > 0 && (
              <section aria-label="Recent assets" className="mt-8">
                <h3
                  className="mb-2 text-xs font-medium"
                  style={{ color: "var(--muted)" }}
                >
                  Recent assets
                </h3>
                <ul className="flex gap-2 overflow-x-auto pb-1">
                  {assets.map((a) => (
                    <li key={`${a.projectId}:${a.key}`} className="shrink-0">
                      <Link
                        href={`/projects/${a.projectId}?tab=files`}
                        title={`${a.name} · ${a.projectName}`}
                        className="block h-20 w-28 overflow-hidden rounded-lg border bg-black/[.03]"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/projects/${a.projectId}/library?key=${encodeURIComponent(a.key)}`}
                          alt={a.name}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
