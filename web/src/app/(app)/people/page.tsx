import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import CompanyStructure from "@/components/iotx/CompanyStructure";

/** People: the company structure (org chart) and the employee directory, for everyone in the workspace. */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  const { view } = await searchParams;
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="people">
        <CompanyStructure initialTab={view === "employees" ? "people" : view === "team" ? "team" : view === "timeoff" ? "timeoff" : view === "worktime" ? "worktime" : view === "reports" ? "reports" : "chart"} />
      </Shell>
    </main>
  );
}
