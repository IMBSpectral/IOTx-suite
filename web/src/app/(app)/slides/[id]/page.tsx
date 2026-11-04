import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import SlidesEditor from "@/components/slides/SlidesEditor";

/** One Google Slides presentation, open full width in the Slides editor. */
export default async function SlidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (!data.perms?.apps.includes("slides")) redirect("/home");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="slides">
        <SlidesEditor key={id} id={id} />
      </Shell>
    </main>
  );
}
