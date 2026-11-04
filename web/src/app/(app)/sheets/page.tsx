import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import SheetsHome from "@/components/sheets/SheetsHome";

/** Sheets home: start a new spreadsheet, or open a recent one in the editor (/sheets/<id>). */
export default async function SheetsPage() {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (!data.perms?.apps.includes("sheets")) redirect("/home");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="sheets">
        <Suspense>
          <SheetsHome />
        </Suspense>
      </Shell>
    </main>
  );
}
