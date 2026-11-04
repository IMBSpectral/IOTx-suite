import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { cookies } from "next/headers";
import { recordLogin } from "./login-log";
import { db } from "./db";
import { REFERRAL_COOKIE } from "./referrals";
import { onNewUser } from "./signup";
import { mayCreateAccount } from "./signup-gate";
import { emailSignInEnabled, sendSignInLink } from "./email-signin";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "database" },
  pages: { signIn: "/login", verifyRequest: "/login/check-email" },
  providers: [
    // GitHub sign-in only once its OAuth app is configured.
    ...(process.env.AUTH_GITHUB_ID ? [GitHub({ allowDangerousEmailAccountLinking: true })] : []),
    // Sign in with an emailed link, for people without Google (needs a way to send email).
    ...(emailSignInEnabled()
      ? [{ id: "email", type: "email" as const, name: "Email", maxAge: 15 * 60, from: "", server: "", options: {}, sendVerificationRequest: sendSignInLink }]
      : []),
  ],
  callbacks: {
    // Invitation-only installs (FORGE_SIGNUP_ALLOW): new people need an approved email or an invite link.
    async signIn({ user }) {
      return (await mayCreateAccount(user.email)) ? true : "/login?error=signup_closed";
    },
    async session({ session, user }) {
      // Two-step verification: until this session passes it, it carries no
      // user, so every page and API treats it as signed out (except /login/mfa).
      const s = session as typeof session & { mfaAt?: Date | null };
      const u = user as typeof user & { mfaEnabledAt?: Date | null };
      if (u.mfaEnabledAt && !s.mfaAt) {
        // user must be explicitly undefined: server-side auth() otherwise adds it back.
        return { user: undefined, expires: session.expires, mfaPending: true, mfaUserId: user.id } as unknown as typeof session;
      }
      // Only who is signed in and until when: the stored session row (its token, mfaAt…)
      // must never reach the browser through /api/auth/session.
      return {
        user: { id: user.id, name: session.user?.name ?? null, email: session.user?.email ?? user.email, image: session.user?.image ?? null },
        expires: session.expires,
      } as unknown as typeof session;
    },
  },
  events: {
    // Login history: who signed in, how, from where. Never blocks the sign-in.
    async signIn({ user, account }) {
      if (user.id) await recordLogin(user.id, account?.provider ?? "unknown");
    },
    async createUser({ user }) {
      if (!user.id) return;
      await onNewUser({ id: user.id, name: user.name, email: user.email }, (await cookies()).get(REFERRAL_COOKIE)?.value);
    },
  },
});
