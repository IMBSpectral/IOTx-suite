import Sidebar from "@/components/Sidebar";
import DeviceApprove from "@/components/DeviceApprove";
import { auth } from "@/lib/auth";

/** Approve a device sign-in (desktop app, CLI) by the code it shows. */
export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const session = await auth();
  const { code } = await searchParams;
  return (
    <>
      <Sidebar userId={session!.user!.id} />
      <main className="flex-1 overflow-y-auto px-4">
        <DeviceApprove initialCode={(code ?? "").slice(0, 12)} />
      </main>
    </>
  );
}
