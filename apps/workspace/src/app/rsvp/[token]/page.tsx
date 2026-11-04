import type { Metadata } from "next";
import RsvpPage from "@/components/calendar/public/RsvpPage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invitation", robots: { index: false, follow: false } };

/** Public: an outside guest's Yes / No / Maybe page (the link in their invitation email is the key). */
export default async function Page({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ r?: string }> }) {
  const { token } = await params;
  const { r } = await searchParams;
  return <RsvpPage token={token} answer={r === "yes" || r === "no" || r === "maybe" ? r : null} />;
}
