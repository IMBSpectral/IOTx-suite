import type { Metadata } from "next";
import BookPage from "@/components/calendar/public/BookPage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Book a time" };

/** Public booking page: anyone picks a free slot on the owner's calendar. */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <BookPage slug={(await params).slug} />;
}
