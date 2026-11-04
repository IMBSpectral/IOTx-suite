import Sidebar from "@/components/Sidebar";
import ProjectBrowser from "@/components/ProjectBrowser";
import { auth } from "@/lib/auth";
import { CATEGORIES, TEMPLATES, personasOf } from "@/lib/templates";

export default async function ProjectsPage() {
  const session = await auth();
  const userId = session!.user!.id;

  return (
    <>
      <Sidebar userId={userId} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-10">
          <h1 className="mb-6 text-xl font-semibold tracking-tight">Projects</h1>
          <ProjectBrowser
            categories={CATEGORIES}
            templates={TEMPLATES.map((t) => ({ slug: t.slug, name: t.name, category: t.category, blurb: t.blurb, personas: personasOf(t.slug) }))}
          />
        </div>
      </main>
    </>
  );
}
