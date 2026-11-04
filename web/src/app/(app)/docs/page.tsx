import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import OfficeHome from "@/components/google/OfficeHome";

/** Docs home: start a new document, or open a recent one in the editor (/docs/<id>). */
export default async function DocsPage() {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (!data.perms?.apps.includes("docs")) redirect("/home");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="docs">
        <Suspense>
          <OfficeHome kind="docs" />
        </Suspense>
      </Shell>
    </main>
  );
}
