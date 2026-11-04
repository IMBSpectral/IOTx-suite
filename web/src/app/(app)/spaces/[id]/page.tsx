import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import SpaceView from "@/components/iotx/SpaceView";

/** A dashboard (its apps as modules) or a folder (what is kept in it), from the sidebar. */
export default async function SpacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="spaces">
        <Suspense>
          <SpaceView id={id} />
        </Suspense>
      </Shell>
    </main>
  );
}
