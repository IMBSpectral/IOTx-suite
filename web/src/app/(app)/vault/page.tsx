import VaultPanel from "@/components/VaultPanel";

export default async function VaultPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const { site } = await searchParams;
  return (
    <main className="flex-1 overflow-y-auto">
      <VaultPanel site={site} />
    </main>
  );
}
