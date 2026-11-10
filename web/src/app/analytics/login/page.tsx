import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signIn, auth } from "@/lib/auth";
import { workspaceForEmail } from "@/lib/sso";
import { emailSignInEnabled } from "@/lib/email-signin";
import "../../login/login.css";
import "@/components/insights/insights.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in · Insights" };

/** Sign-in for Insights on its own: same accounts as the suite, Insights' own page and destination. */
export default async function InsightsLogin({ searchParams }: { searchParams: Promise<{ redirect?: string; pw_error?: string; sso_error?: string; check?: string; email?: string }> }) {
  const { redirect: raw, pw_error: pwError, sso_error: ssoError, check, email: lastEmail } = await searchParams;
  const to = raw && raw.startsWith("/analytics") && !raw.startsWith("//") ? raw : "/analytics";
  const session = await auth();
  if (session?.user) redirect(to);
  if ((session as unknown as { mfaPending?: boolean } | null)?.mfaPending) redirect(`/login/mfa?redirect=${encodeURIComponent(to)}`);

  return (
    <main className="si">
      <section className="si-form-side">
        <span className="si-brand">
          <span className="ins-sa-logo">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
              <circle cx="19" cy="6" r="2.5" />
            </svg>
          </span>
          Insights
        </span>
        <div className="si-form">
          <h1>
            Your data, <em>explained.</em>
          </h1>
          <p className="si-muted">Sign in to Insights, your AI analyst.</p>
          <form className="si-sso si-pw" method="post" action="/api/password-login">
            <input type="hidden" name="next" value={to} />
            <input type="hidden" name="page" value="/analytics/login" />
            <label htmlFor="pw-email">Email</label>
            <input id="pw-email" name="email" type="email" required autoComplete="username" placeholder="you@company.com" defaultValue={lastEmail ?? ""} />
            <label htmlFor="pw-password">Password</label>
            <input id="pw-password" name="password" type="password" required autoComplete="current-password" />
            <button className="si-btn si-btn-main">Sign in</button>
          </form>
          {pwError && (
            <p className="si-error" role="alert">
              {pwError}
            </p>
          )}
          {emailSignInEnabled() && (
            <>
              <div className="si-or">
                <span>or get a sign-in link</span>
              </div>
              <form
                className="si-sso"
                action={async (fd: FormData) => {
                  "use server";
                  const email = String(fd.get("email") ?? "").trim().toLowerCase();
                  if (await workspaceForEmail(email)) redirect(`/api/sso/start?${new URLSearchParams({ email, next: to })}`);
                  await signIn("email", { email, redirectTo: to });
                }}
              >
                <label htmlFor="sso-email">Work email</label>
                <div>
                  <input id="sso-email" name="email" type="email" required placeholder="you@company.com" />
                  <button className="si-btn">Email me a link</button>
                </div>
              </form>
            </>
          )}
          {check === "email" && (
            <p className="si-ok" role="status">
              Check your inbox: we&rsquo;ve sent you a sign-in link.
            </p>
          )}
          {ssoError && (
            <p className="si-error" role="alert">
              {ssoError}
            </p>
          )}
        </div>
        <footer className="si-foot">
          <span className="si-terms">
            By continuing you agree to the <a href="/terms">terms of service</a> and <a href="/privacy">privacy policy</a>.
          </span>
        </footer>
      </section>
      <section className="si-art ins-login-art" aria-label="Insights">
        <div className="si-art-copy">
          <p>Drop in any spreadsheet or document. Get a live board, forecasts and the reasons behind every number.</p>
        </div>
        <div className="ins-login-cards" aria-hidden="true">
          <div className="ins-login-card">
            <small>Revenue forecast</small>
            <b>₹7.95 Cr / month</b>
            <span className="ins-acc good">High accuracy · 6% error</span>
          </div>
          <div className="ins-login-card">
            <small>What drives lead time</small>
            <div className="ins-login-bars">
              <i style={{ width: "56%" }} />
              <i style={{ width: "40%" }} />
              <i style={{ width: "4%" }} />
            </div>
          </div>
          <div className="ins-login-card warn">
            <small>Finding</small>
            <b>Pune × Crankshaft: +3.4 days</b>
          </div>
        </div>
      </section>
    </main>
  );
}
