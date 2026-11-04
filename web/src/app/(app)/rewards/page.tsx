import Sidebar from "@/components/Sidebar";
import RewardsPanel from "@/components/RewardsPanel";
import { auth } from "@/lib/auth";
import { getBrand } from "@/lib/brand";

export default async function RewardsPage() {
  const session = await auth();
  const brand = getBrand();
  return (
    <>
      <Sidebar userId={session!.user!.id} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-10">
          <h1 className="text-xl font-semibold tracking-tight">Explore {brand.shortName}. Earn bonuses.</h1>
          <p className="mb-6 mt-1 text-sm" style={{ color: "var(--muted)" }}>
            Try what {brand.shortName} can do and collect free credits.
          </p>
          <RewardsPanel />
        </div>
      </main>
    </>
  );
}
