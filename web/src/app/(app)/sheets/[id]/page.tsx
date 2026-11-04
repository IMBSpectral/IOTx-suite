import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import SheetsEditor from "@/components/sheets/SheetsEditor";

/** One Google Sheet, open full width in the Sheets editor. */
export default async function SheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (!data.perms?.apps.includes("sheets")) redirect("/home");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="sheets">
        <SheetsEditor key={id} id={id} />
      </Shell>
    </main>
  );
}
