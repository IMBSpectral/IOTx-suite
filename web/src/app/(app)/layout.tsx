import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PermsProvider } from "@/components/iotx/PermsProvider";
import SuiteFrame from "@/components/iotx/browser/SuiteFrame";
import { shellData } from "@/lib/iotx/shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  // A session still waiting on its two-step code goes to that step, not back to sign-in.
  if (!session?.user?.id) redirect((session as unknown as { mfaPending?: boolean } | null)?.mfaPending ? "/login/mfa" : "/login");
  // What the person can do here (IOTx Suite permissions), for every screen.
  const data = await shellData(session.user.id);
  // The suite is a browser: a top-level page load gets the frame (tabs, toolbar, sidebar), whose
  // tabs load each page in a same-origin iframe; a page inside a tab gets no chrome. The page
  // itself isn't rendered for the frame (its tab loads it).
  const top = (await headers()).get("sec-fetch-dest") === "document";
  return (
    <PermsProvider value={data?.perms ?? null}>
      {data ? (
        <SuiteFrame data={data} userId={session.user.id} top={top}>
          {top ? null : children}
        </SuiteFrame>
      ) : (
        // No workspace yet (onboarding): the page alone.
        <div className="flex h-screen flex-col overflow-hidden">
          <div className="app-shell flex min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
      )}
    </PermsProvider>
  );
}
