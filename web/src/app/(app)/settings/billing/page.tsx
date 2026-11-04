import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { currentWorkspace } from "@/lib/workspace";
import BillingPanel from "@/components/BillingPanel";

const REASON_LABEL: Record<string, string> = {
  MONTHLY_GRANT: "Monthly grant",
  GENERATION: "Build",
  TOPUP: "Top-up",
  REFERRAL: "Referral",
  REFUND: "Refund",
  EXPIRED: "Expired credits",
};

export default async function BillingPage() {
  const session = await auth();
  const userId = session!.user!.id;
  const ws = await currentWorkspace(userId);

  const entries = await db.creditEntry.findMany({
    // Free chat turns are recorded at zero credits; they aren't activity worth listing.
    where: { workspaceId: ws.id, delta: { not: 0 } },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  return (
    <div className="space-y-8">
      <BillingPanel />

      <section>
        <h2 className="mb-3 text-sm font-medium">Recent activity</h2>
        {entries.length === 0 ? (
          <p
            className="rounded-xl border border-dashed px-4 py-10 text-center text-sm"
            style={{ color: "var(--muted)" }}
          >
            No credit activity yet.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border" style={{ background: "var(--panel)" }}>
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span>
                  {REASON_LABEL[e.reason] ?? e.reason}
                  {e.category && (
                    <span className="ml-1.5 text-xs capitalize" style={{ color: "var(--muted)" }}>
                      {e.category === "build_free" ? "free build hour" : e.category === "chat_free" ? "free chat" : e.category}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-4">
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    {e.createdAt.toLocaleDateString()}
                  </span>
                  <span
                    className="w-14 text-right font-medium tabular-nums"
                    style={{ color: e.delta < 0 ? undefined : "var(--accent)" }}
                  >
                    {e.delta > 0 ? `+${e.delta}` : e.delta}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
