import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import InsightsApp from "@/components/insights/InsightsApp";

/** Insights: AI analytics over any data (?a=<id> opens an analysis). */
export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ a?: string }> }) {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (data.perms && !data.perms.apps.includes("insights")) redirect("/home");
  const { a } = await searchParams;
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0, minHeight: 0 }}>
      <Shell data={data} active="insights">
        <InsightsApp initial={a ?? null} />
      </Shell>
    </main>
  );
}
