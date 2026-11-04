import type { Metadata } from "next";
import GuestJoin from "@/components/chat/GuestJoin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat for guests", robots: { index: false, follow: false } };

/** Public: a guest asks for a new sign-in link. */
export default async function Page({ searchParams }: { searchParams: Promise<{ signedout?: string }> }) {
  const { signedout } = await searchParams;
  return <GuestJoin token="" invite={null} signedOut={!!signedout} />;
}
