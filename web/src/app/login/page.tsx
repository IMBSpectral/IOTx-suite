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

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

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
  searchParams: Promise<{ redirect?: string; sso_error?: string; error?: string; check?: string }>;
}) {
  const session = await auth();
  const { redirect: raw, sso_error: ssoError, error: authError, check } = await searchParams;
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
        <Link href="/" className="si-brand">
          <BrandMark size={24} radius={7} /> {brand.name}
        </Link>

        <div className="si-form">
          <h1>
            Welcome <em>back.</em>
          </h1>
          <p className="si-muted">Sign in to your company&rsquo;s workspace.</p>

          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: to ?? "/home" });
            }}
          >
            <button className="si-btn si-btn-main">
              <GoogleG />
              Continue with Google
            </button>
          </form>
          {process.env.AUTH_GITHUB_ID && (
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: to ?? "/home" });
              }}
            >
              <button className="si-btn">Continue with GitHub</button>
            </form>
          )}

          <div className="si-or"><span>or with your company account</span></div>

          {/* Work email: single sign-on when the domain has it, otherwise an emailed sign-in link. */}
          <form
            className="si-sso"
            action={async (fd: FormData) => {
              "use server";
              const email = String(fd.get("email") ?? "").trim().toLowerCase();
              const next = to ?? "/home";
              if (await workspaceForEmail(email)) redirect(`/api/sso/start?${new URLSearchParams({ email, next })}`);
              if (emailSignInEnabled()) await signIn("email", { email, redirectTo: next });
              redirect(`/login?sso_error=${encodeURIComponent("Sign in with Google, or ask your administrator to set up company sign-in.")}`);
            }}
          >
            <label htmlFor="sso-email">Work email</label>
            <div>
              <input id="sso-email" name="email" type="email" required placeholder="you@company.com" />
              <button className="si-btn">Continue</button>
            </div>
            {emailSignInEnabled() && <p className="si-hint">We&rsquo;ll use your company&rsquo;s sign-in, or email you a link.</p>}
          </form>
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
