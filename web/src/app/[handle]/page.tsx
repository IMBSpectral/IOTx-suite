import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

/** Public profile: only projects the owner marked public are listed. */
export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  // The segment can arrive encoded ("%40name"), so decode before looking for the @.
  const segment = decodeURIComponent((await params).handle);
  if (!segment.startsWith("@")) notFound();
  const handle = segment.slice(1);

  const user = await db.user.findFirst({
    where: { OR: [{ handle }, { id: handle }] },
    select: { id: true, name: true, handle: true, image: true, profilePublic: true, linkedinUrl: true },
  });
  // A private profile doesn't exist to anyone else.
  if (!user || !user.profilePublic) notFound();

  const projects = await db.project.findMany({
    where: {
      visibility: "PUBLIC",
      deletedAt: null,
      workspace: { memberships: { some: { userId: user.id } } },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, description: true, subdomain: true, publishedAt: true },
  });

  const display = user.name ?? user.handle ?? "Builder";

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)" }}>
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <header className="flex items-center gap-4">
          <div
            className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-lg font-semibold text-white"
            style={{ background: "var(--accent)" }}
          >
            {display.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{display}</h1>
            {user.handle && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                @{user.handle}
                {user.linkedinUrl && (
                  <>
                    {" · "}
                    <a href={user.linkedinUrl} rel="noopener noreferrer nofollow" target="_blank" className="underline">
                      LinkedIn
                    </a>
                  </>
                )}
              </p>
            )}
          </div>
        </header>

        <h2 className="mb-3 mt-10 text-sm font-medium">
          Public projects{" "}
          <span style={{ color: "var(--muted)" }}>({projects.length})</span>
        </h2>

        {projects.length === 0 ? (
          <p
            className="rounded-xl border border-dashed px-6 py-14 text-center text-sm"
            style={{ color: "var(--muted)" }}
          >
            Nothing public yet.
          </p>
        ) : (
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={p.publishedAt ? `/live/${p.subdomain}` : "#"}
                  className="block rounded-xl border p-4 transition-colors hover:bg-black/[.02] dark:hover:bg-white/[.03]"
                  style={{ background: "var(--panel)" }}
                >
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                    {p.publishedAt ? "Live" : "Not published"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
