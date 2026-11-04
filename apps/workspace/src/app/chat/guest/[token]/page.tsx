import type { Metadata } from "next";
import { guestByToken } from "@/lib/chat-guests";
import GuestJoin from "@/components/chat/GuestJoin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Join Chat", robots: { index: false, follow: false } };

/** Public: a guest's invitation or sign-in link (the token is the key; it works once). */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await guestByToken(token);
  return <GuestJoin token={token} invite={found ? { email: found.g.email, name: found.g.name, channels: found.channels, inviter: found.inviter, returning: !!found.g.userId } : null} />;
}
