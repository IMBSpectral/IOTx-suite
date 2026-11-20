import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import GDriveApp from "@/components/iotx/GDriveApp";

/** Google Drive: the person's own Drive, through their Google connection. */
export default async function GDrivePage({ searchParams }: { searchParams: Promise<{ file?: string }> }) {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (!data.perms?.apps.includes("gdrive")) redirect("/home");
  const { file } = await searchParams;
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="gdrive">
        <GDriveApp initialFile={file} />
      </Shell>
    </main>
  );
}
