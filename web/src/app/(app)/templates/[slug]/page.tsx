import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import TemplateStart from "@/components/TemplateStart";
import { auth } from "@/lib/auth";
import { RETIRED_TEMPLATES, TEMPLATES, findTemplate } from "@/lib/templates";

/** A template's detail page: what it is, who it's for, what it includes. */
export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ replaced?: string }>;
}) {
  const { slug } = await params;
  const retired = RETIRED_TEMPLATES[slug];
  if (retired?.replacedBy) redirect(`/templates/${retired.replacedBy}?replaced=${encodeURIComponent(slug)}`);
  const session = await auth();
  if (retired) {
    return (
      <>
        <Sidebar userId={session!.user!.id} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-xl px-6 py-24 text-center">
            <h1 className="text-xl font-semibold">The {retired.name} template was removed</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              It&apos;s no longer available. Projects already made from it aren&apos;t affected.
            </p>
            <Link href="/dashboard/projects" className="btn-primary mt-6 inline-block rounded-lg px-4 py-2 text-sm">
              Browse templates
            </Link>
          </div>
        </main>
      </>
    );
  }
  const t = findTemplate(slug);
  if (!t) notFound();
  const replaced = RETIRED_TEMPLATES[(await searchParams).replaced ?? ""];
  const related = TEMPLATES.filter((x) => x.category === t.category && x.slug !== t.slug).slice(0, 3);

  return (
    <>
      <Sidebar userId={session!.user!.id} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-12">
          <Link href="/dashboard/projects" className="text-xs hover:underline" style={{ color: "var(--muted)" }}>
            ← All templates
          </Link>
          {replaced && (
            <p role="status" className="mt-4 rounded-lg border px-3 py-2 text-xs" style={{ background: "var(--panel)" }}>
              The {replaced.name} template was replaced by {t.name}. You&apos;ve been taken to the new one.
            </p>
          )}
          <p className="mt-6 text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            {t.category}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t.name}</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            {t.blurb}
          </p>

          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            <section>
              <h2 className="text-sm font-medium">Designed for</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                {t.designedFor}
              </p>
              <h2 className="mt-5 text-sm font-medium">Features and capabilities</h2>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm" style={{ color: "var(--muted)" }}>
                {t.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <h2 className="mt-5 text-sm font-medium">Technology stack</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                React, TypeScript, Vite, Tailwind CSS and shadcn/ui-style components.
              </p>
            </section>
            <section className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
              <h2 className="text-sm font-medium">Start from this template</h2>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Pick a style; the agent builds the app and you can change anything afterwards.
              </p>
              <TemplateStart slug={t.slug} name={t.name} />
            </section>
          </div>

          {related.length > 0 && (
            <section className="mt-10">
              <h2 className="text-sm font-medium">More {t.category.toLowerCase()}</h2>
              <ul className="mt-2 grid gap-2 sm:grid-cols-3">
                {related.map((r) => (
                  <li key={r.slug}>
                    <Link href={`/templates/${r.slug}`} className="block rounded-xl border p-3 text-sm hover:bg-black/[.02]">
                      {r.name}
                      <span className="mt-0.5 block text-xs" style={{ color: "var(--muted)" }}>
                        {r.blurb}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </>
  );
}
