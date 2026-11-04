import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import KnowledgeApp from "@/components/kb/KnowledgeApp";

/** Knowledge: the company knowledge base (?doc=<id> opens an article, ?tab=review the review queue). */
export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ doc?: string; tab?: string }> }) {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  if (data.perms && !data.perms.apps.includes("read")) redirect("/home");
  const { doc, tab } = await searchParams;
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="read">
        <KnowledgeApp initialDoc={doc ?? null} initialTab={tab ?? null} />
      </Shell>
    </main>
  );
}
