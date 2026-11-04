import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { shellData } from "@/lib/iotx/shell";
import { manifestById } from "@/lib/iotx/manifests";
import Shell from "@/components/iotx/Shell";
import ComingSoon from "@/components/iotx/ComingSoon";

/** An app from the launcher: live apps open where they live; the rest show Coming soon inside the shell. */
export default async function AppPage({ params }: { params: Promise<{ app: string }> }) {
  const { app } = await params;
  const m = manifestById(app);
  if (!m) notFound();
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  const opens = !data.perms || data.perms.apps.includes(app);
  if (opens && m.status === "live" && m.href) redirect(m.href);
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active={app}>
        {opens ? (
          <ComingSoon appId={app} />
        ) : (
          <div className="ix-soon">
            <h1>{m.name} isn&apos;t turned on for your role</h1>
            <p style={{ color: "var(--ix-muted)" }}>An admin can turn it on under Roles &amp; permissions.</p>
            <Link className="ix-btn" href="/home">
              Back to Home
            </Link>
          </div>
        )}
      </Shell>
    </main>
  );
}
