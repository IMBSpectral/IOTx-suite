import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { currentWorkspace } from "@/lib/workspace";
import { appsFor } from "@/lib/iotx/permissions";
import { getBrand } from "@/lib/brand";
import InsightsApp from "@/components/insights/InsightsApp";
import "@/components/insights/insights.css";

export const metadata: Metadata = { title: "Insights" };

/**
 * Insights on its own: the same app as /insights in the suite, full screen, without the
 * suite's tabs and sidebar. Same sign-in, workspace, permissions and analyses.
 */
export default async function StandaloneInsights({ searchParams }: { searchParams: Promise<{ a?: string }> }) {
  const { a } = await searchParams;
  const session = await auth();
  if (!session?.user?.id) redirect(`/analytics/login?redirect=${encodeURIComponent(`/analytics${a ? `?a=${a}` : ""}`)}`);
  const ws = await currentWorkspace(session.user.id).catch(() => null);
  if (!ws) redirect("/welcome");
  if (!(await appsFor(session.user.id, ws.id)).includes("insights")) redirect("/home");
  const brand = getBrand();
  return (
    <div className="ins-standalone">
      <header className="ins-sa-bar">
        <Link href="/analytics" className="ins-sa-brand">
          <span className="ins-sa-logo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
              <circle cx="19" cy="6" r="2.5" />
            </svg>
          </span>
          Insights
        </Link>
        <span className="ins-sa-ws">{ws.name}</span>
        <a className="ins-sa-link" href={`/insights${a ? `?a=${a}` : ""}`}>
          Open in {brand.shortName}
        </a>
      </header>
      <main className="ins-sa-main">
        <InsightsApp initial={a ?? null} />
      </main>
    </div>
  );
}
