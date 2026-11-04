import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { auth } from "@/lib/auth";
import { requireProject } from "@/lib/workspace";
import { siteAnalytics } from "@/lib/projects";
import { siteUrl } from "@/lib/publish";
import { db } from "@/lib/db";

/** "View analytics for this project": daily visits to the published site. */
export default async function ProjectAnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const userId = session!.user!.id;
  await requireProject(userId, id, "view");
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { name: true, subdomain: true, publishedSha: true } });
  const a = await siteAnalytics(id, 30);
  const prev7 = a.series.slice(-14, -7).reduce((n, d) => n + d.visits, 0);
  const change = prev7 ? Math.round(((a.last7 - prev7) / prev7) * 100) : null;
  const max = Math.max(1, ...a.series.map((d) => d.visits));
  const best = a.series.reduce((b, d) => (d.visits > b.visits ? d : b), a.series[0]);
  const muted = { color: "var(--muted)" };
  const fmt = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <>
      <Sidebar userId={userId} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-10">
          <Link href={`/projects/${id}`} className="text-xs hover:underline" style={muted}>
            ← {p.name}
          </Link>
          <h1 className="mt-3 text-xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm" style={muted}>
            {p.publishedSha ? (
              <>
                Page views of <a href={siteUrl(p.subdomain)} className="underline">{siteUrl(p.subdomain).replace(/^https?:\/\//, "")}</a>, last 30 days.
              </>
            ) : (
              "This project isn't published yet, so there are no visits to show."
            )}
          </p>

          <dl className="mt-6 grid gap-3 sm:grid-cols-3">
            {(
              [
                ["Last 30 days", a.total.toLocaleString()],
                ["Last 7 days", `${a.last7.toLocaleString()}${change === null ? "" : ` (${change >= 0 ? "+" : ""}${change}% vs the week before)`}`],
                ["Busiest day", best && best.visits ? `${fmt(best.day)} · ${best.visits}` : "—"],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
                <dt className="text-xs" style={muted}>{k}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          <figure className="mt-6 rounded-xl border p-4" style={{ background: "var(--panel)" }}>
            <figcaption className="text-xs" style={muted}>Visits per day</figcaption>
            <div className="mt-3 flex h-40 items-end gap-1" role="img" aria-label={`Visits per day over 30 days, ${a.total} in total`}>
              {a.series.map((d) => (
                <div key={d.day} className="group relative flex h-full flex-1 items-end">
                  <div className="w-full rounded-t" style={{ height: `${(d.visits / max) * 100}%`, minHeight: d.visits ? 2 : 0, background: "var(--accent)" }} />
                  <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] group-hover:block" style={{ background: "var(--panel)" }}>
                    {fmt(d.day)}: {d.visits}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px]" style={muted}>
              <span>{fmt(a.series[0].day)}</span>
              <span>Today</span>
            </div>
          </figure>
          <p className="mt-3 text-xs" style={muted}>Counts page loads of the published app (not images or scripts). Visits to custom domains are included.</p>
        </div>
      </main>
    </>
  );
}
