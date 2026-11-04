import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import DataHub from "@/components/iotx/DataHub";

/** Data Hub: apps sharing and reading each other's data. */
export default async function DataHubPage() {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="datahub">
        <DataHub />
      </Shell>
    </main>
  );
}
