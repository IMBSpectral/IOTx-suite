import Link from "next/link";
import { inviteLinkInfo } from "@/lib/members-extra";
import JoinWorkspaceButton from "@/components/JoinWorkspaceButton";

export const dynamic = "force-dynamic";

/** A workspace invite link: join with the role it gives. */
export default async function JoinWorkspacePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await inviteLinkInfo(token);
  return (
    <main className="grid flex-1 place-items-center p-6 text-center">
      <div className="max-w-sm space-y-3">
        {!info || info.expired ? (
          <>
            <h1 className="text-lg font-semibold">This invite link isn&apos;t active</h1>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              It expired, was used up or was turned off. Ask for a new one.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">Join {info.workspaceName}</h1>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              You&apos;ll join as {info.role === "ADMIN" ? "an admin" : info.role === "VIEWER" ? "a viewer" : "a member"}.
            </p>
            <JoinWorkspaceButton token={token} />
          </>
        )}
        <Link href="/dashboard" className="inline-block text-sm hover:underline">
          Go to your dashboard
        </Link>
      </div>
    </main>
  );
}
