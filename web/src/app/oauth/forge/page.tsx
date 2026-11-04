import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCloud } from "@/lib/cloud";
import { authSettings } from "@/lib/cloud-auth";
import { allowedRedirect } from "@/lib/forge-identity";
import ForgeConsent from "@/components/ForgeConsent";
import { getBrand } from "@/lib/brand";

export const dynamic = "force-dynamic";

/** "Continue with Forge" consent: an app built on Forge asks to sign you in. */
export default async function ForgeSignInPage({ searchParams }: { searchParams: Promise<{ project?: string; redirect_uri?: string; state?: string }> }) {
  const q = await searchParams;
  const session = await auth();
  if (!session?.user) {
    const back = `/oauth/forge?${new URLSearchParams(q as Record<string, string>).toString()}`;
    redirect(`/login?redirect=${encodeURIComponent(back)}`);
  }
  const project = q.project ? await db.project.findUnique({ where: { id: q.project }, select: { id: true, name: true } }) : null;
  const cfg = project ? await getCloud(project.id) : null;
  const target = project && q.redirect_uri ? await allowedRedirect(project.id, q.redirect_uri) : null;
  const problem = !project || !cfg?.enabled
    ? "This app couldn't be found."
    : !authSettings(cfg).forge
      ? `This app doesn't offer Continue with ${getBrand().name}.`
      : !target
        ? "This sign-in request came from an address the app doesn't use, so it was stopped."
        : null;

  return (
    <main className="grid min-h-screen place-items-center px-6" style={{ background: "var(--bg)" }}>
      <div className="w-full max-w-sm rounded-2xl border p-6" style={{ background: "var(--panel)" }}>
        {problem ? (
          <p className="text-sm" role="alert">
            {problem}
          </p>
        ) : (
          <ForgeConsent
            projectId={project!.id}
            appName={project!.name}
            email={session!.user!.email ?? ""}
            redirectUri={target!.toString()}
            state={q.state ?? ""}
          />
        )}
      </div>
    </main>
  );
}
