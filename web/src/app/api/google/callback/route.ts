import { auth } from "@/lib/auth";
import { can } from "@/lib/iotx/permissions";
import { finishConnect, GoogleError, readState, redirectUri } from "@/lib/google";
import { MailError } from "@/lib/mail/mailbox";

/**
 * Back from Google, for both kinds of connection started by the same person:
 * Google Drive (Docs, Sheets, Slides) and Gmail mailboxes ("Sign in with Google" in Mail).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const state = readState(url.searchParams.get("state"));
  const target = state?.b ?? "/sheets";
  const forMail = state?.x?.k === "mail";
  const errKey = forMail ? "mail_error" : "google_error";
  const back = (q: string) => new Response(null, { status: 303, headers: { location: `${target}${target.includes("?") ? "&" : "?"}${q}` } });

  // "Continue with Google" in an app built with the Builder: the person isn't a
  // platform user, so there's no session to check. Google vouches for their
  // address; the app gets a one-time code (its completeSignIn() trades it).
  if (state?.x?.k === "app" && state.x.p && state.x.r) {
    const appBack = new URL(state.x.r);
    const toApp = (params: Record<string, string>) => {
      for (const [k, v] of Object.entries(params)) appBack.searchParams.set(k, v);
      return new Response(null, { status: 303, headers: { location: appBack.toString() } });
    };
    const err = url.searchParams.get("error");
    if (err) return toApp({ forge_error: err === "access_denied" ? "You cancelled on Google's screen." : err });
    try {
      const { tokenRequest } = await import("@/lib/google");
      const t = await tokenRequest({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: redirectUri() });
      const claims = t.id_token ? (JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()) as { email?: string; email_verified?: boolean }) : {};
      if (!claims.email || claims.email_verified === false) return toApp({ forge_error: "Google didn't confirm an email address for that account." });
      const { allowedRedirect, issueGoogleCode } = await import("@/lib/forge-identity");
      if (!(await allowedRedirect(state.x.p, appBack.toString()))) return new Response("That return address doesn't belong to the app.", { status: 400 });
      const code = await issueGoogleCode(state.x.p, claims.email, appBack);
      return toApp({ forge_code: code, state: state.x.st ?? "" });
    } catch (e) {
      return toApp({ forge_error: e instanceof Error ? e.message.slice(0, 200) : "Couldn't sign in with Google." });
    }
  }

  const session = await auth();
  if (!state || !session?.user?.id || session.user.id !== state.u) return back(`${errKey}=${encodeURIComponent("That Google connection link expired. Try again.")}`);
  const err = url.searchParams.get("error");
  if (err) return back(`${errKey}=${encodeURIComponent(err === "access_denied" ? "You cancelled on Google's screen." : err)}`);
  const code = url.searchParams.get("code") ?? "";
  try {
    if (forMail) {
      const ws = state.x?.ws ?? "";
      const owner = state.x?.owner ?? null;
      // Permissions are checked again here: they may have changed since the link was made.
      const allowed = owner === state.u ? await can(state.u, ws, "mail.connect") : await can(state.u, ws, "admin.mailboxes");
      if (!allowed) return back(`${errKey}=${encodeURIComponent("You're no longer allowed to connect this mailbox.")}`);
      const { connectGmail } = await import("@/lib/mail/gmail");
      const m = await connectGmail(ws, state.u, owner, code, redirectUri());
      return back(`mail=connected&mailbox=${encodeURIComponent(m.id)}`);
    }
    await finishConnect(state.u, code);
    return back("google=connected");
  } catch (e) {
    const msg = e instanceof GoogleError || e instanceof MailError ? e.message : "Couldn't connect Google.";
    return back(`${errKey}=${encodeURIComponent(msg)}`);
  }
}
