import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { BrandMark } from "@/components/BrandProvider";
import MfaChallenge from "@/components/MfaChallenge";
import "../login.css";

export const dynamic = "force-dynamic";

/** The second sign-in step: a code from the authenticator app (or a recovery code). */
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  const session = (await auth()) as unknown as { user?: { id: string }; mfaPending?: boolean } | null;
  const { redirect: raw } = await searchParams;
  const to = raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/home";
  if (session?.user) redirect(to);
  if (!session?.mfaPending) redirect("/login");

  return (
    <main className="si" style={{ gridTemplateColumns: "1fr" }}>
      <section className="si-form-side" style={{ alignItems: "center" }}>
        <div className="si-form" style={{ maxWidth: 380 }}>
          <BrandMark size={44} />
          <h1 style={{ fontSize: 34, marginTop: 22 }}>Two-step verification</h1>
          <p className="si-muted">Enter the 6-digit code from your authenticator app.</p>
          <MfaChallenge next={to} />
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button className="si-btn" style={{ marginTop: 18, border: 0, color: "#6a6e8a" }}>Sign in with a different account</button>
          </form>
        </div>
      </section>
    </main>
  );
}
