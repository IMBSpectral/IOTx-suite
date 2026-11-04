import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import OfficeHome from "@/components/google/OfficeHome";

/** Slides home: start a new presentation, or open a recent one in the editor (/slides/<id>). */
export default async function SlidesPage() {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (!data.perms?.apps.includes("slides")) redirect("/home");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="slides">
        <Suspense>
          <OfficeHome kind="slides" />
        </Suspense>
      </Shell>
    </main>
  );
}
