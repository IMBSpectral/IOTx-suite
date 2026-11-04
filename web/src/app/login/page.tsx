import { signIn, auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Icon } from "@/components/iotx/icons";
import Link from "next/link";
import { workspaceForEmail } from "@/lib/sso";
import { emailSignInEnabled } from "@/lib/email-signin";
import { getBrand } from "@/lib/brand";
import { BrandMark } from "@/components/BrandProvider";
import "./login.css";

// Reads the session cookie, so it can never be prerendered.
export const dynamic = "force-dynamic";

/** Three app windows floating on the right: what's waiting after sign-in. */
function Collage() {
  return (
    <div className="si-collage" aria-hidden="true">
      <div className="si-win si-win-tally">
        <div className="si-win-bar"><span className="si-dot" style={{ background: "linear-gradient(135deg,#b45309,#facc15)" }}><Icon name="ledger" size={11} /></span>Accounts · Day book</div>
        {[
          ["Sales", "Ashvan Steelworks", "₹1,84,500"],
          ["Receipt", "Kestrel Arcworks", "₹2,40,000"],
          ["Purchase", "Neelgiri Coils", "₹96,200"],
          ["Payment", "Freight", "₹18,750"],
        ].map(([t, p, a]) => (
          <div key={p} className="si-row"><span className={`si-vt si-vt-${t.toLowerCase()}`}>{t}</span><span>{p}</span><b>{a}</b></div>
        ))}
      </div>

      <div className="si-win si-win-builder">
        <div className="si-win-bar"><span className="si-dot" style={{ background: "linear-gradient(135deg,#4f46e5,#8b5cf6)" }}><Icon name="builder" size={11} /></span>Builder · Inventory</div>
        <div className="si-kpis">
          <div><small>Stock value</small><b>₹48.2L</b></div>
          <div><small>Pending POs</small><b>12</b></div>
          <div><small>Low stock</small><b className="si-warn">5</b></div>
        </div>
        <div className="si-bars">
          {[55, 78, 42, 88, 64, 72, 90, 60].map((h, i) => (
            <span key={i} style={{ height: Math.round(h * 0.9) }} />
          ))}
        </div>
      </div>

      <div className="si-win si-win-roles">
        <div className="si-win-bar"><span className="si-dot" style={{ background: "linear-gradient(135deg,#334155,#64748b)" }}><Icon name="admin" size={11} /></span>Roles · Accountant</div>
        {([["Accounts vouchers", true], ["Publish apps", false], ["Export sheets", true]] as [string, boolean][]).map(([n, on]) => (
          <div key={n} className="si-sw-row"><span>{n}</span><span className={`si-sw ${on ? "on" : ""}`}><i /></span></div>
        ))}
      </div>

      <div className="si-toast"><span className="si-live" /> inventory.yourcompany.com is live</div>
    </div>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; sso_error?: string; error?: string; check?: string; pw_error?: string; email?: string }>;
}) {
  const session = await auth();
  const { redirect: raw, sso_error: ssoError, error: authError, check, pw_error: pwError, email: lastEmail } = await searchParams;
  // Only paths on this site: an outside address here would be an open redirect.
  const to = raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : undefined;
  if (session?.user) redirect(to ?? "/home");
  // Signed in, but still owes the two-step code.
  if ((session as unknown as { mfaPending?: boolean } | null)?.mfaPending) redirect(`/login/mfa${to ? `?redirect=${encodeURIComponent(to)}` : ""}`);
  const brand = getBrand();

  return (
    <main className="si">
      {/* ── Sign in ── */}
      <section className="si-form-side">
        <span className="si-brand">
          <BrandMark size={24} radius={7} /> {brand.name}
        </span>

        <div className="si-form">
          <h1>
            Welcome <em>back.</em>
          </h1>
          <p className="si-muted">Sign in to your company&rsquo;s workspace.</p>

          {/* Email and password. */}
          <form className="si-sso si-pw" method="post" action="/api/password-login">
            <input type="hidden" name="next" value={to ?? "/home"} />
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

          <div className="si-or"><span>or get a sign-in link</span></div>

          {/* Work email: single sign-on when the domain has it, otherwise an emailed sign-in link. */}
          <form
            className="si-sso"
            action={async (fd: FormData) => {
              "use server";
              const email = String(fd.get("email") ?? "").trim().toLowerCase();
              const next = to ?? "/home";
              if (await workspaceForEmail(email)) redirect(`/api/sso/start?${new URLSearchParams({ email, next })}`);
              if (emailSignInEnabled()) await signIn("email", { email, redirectTo: next });
              redirect(`/login?sso_error=${encodeURIComponent("Sign-in by email isn't set up on this server yet. Ask your administrator to set up company sign-in or email sign-in.")}`);
            }}
          >
            <label htmlFor="sso-email">Work email</label>
            <div>
              <input id="sso-email" name="email" type="email" required placeholder="you@company.com" />
              <button className="si-btn">Email me a link</button>
            </div>
            {emailSignInEnabled() && <p className="si-hint">We&rsquo;ll use your company&rsquo;s sign-in, or email you a link.</p>}
          </form>
          {process.env.AUTH_GITHUB_ID && (
            <>
              <div className="si-or"><span>or</span></div>
              <form
                action={async () => {
                  "use server";
                  await signIn("github", { redirectTo: to ?? "/home" });
                }}
              >
                <button className="si-btn">Continue with GitHub</button>
              </form>
            </>
          )}
          {check === "email" && (
            <p className="si-ok" role="status">
              Check your inbox: we&rsquo;ve sent you a sign-in link. It works once and expires in 15 minutes.
            </p>
          )}
          {authError === "signup_closed" && (
            <p className="si-error" role="alert">
              New accounts are by invitation. Ask your administrator for an invite link, then open it and sign in.
            </p>
          )}
          {ssoError && (
            <p className="si-error" role="alert">
              {ssoError}
            </p>
          )}
        </div>

        <footer className="si-foot">
          <span><Icon name="lock" size={13} /> Encrypted</span>
          <span><Icon name="admin" size={13} /> Role-based access</span>
          <span><Icon name="files" size={13} /> Hosted in India</span>
          <span className="si-terms">By continuing you agree to the <Link href="/terms">terms of service</Link> and <Link href="/privacy">privacy policy</Link>.</span>
        </footer>
      </section>

      {/* ── What's waiting inside ── */}
      <section className="si-art" aria-label={`Inside ${brand.name}`}>
        <div className="si-art-copy">
          <p>Everything your team needs, already open where you left it.</p>
        </div>
        <Collage />
      </section>
    </main>
  );
}
