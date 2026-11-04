import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import Daily from "@/components/meet/read/Daily";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Daily Read · Meet" };

export default async function Page() {
  return readPage("daily", "/meet/daily", () => <Daily />);
}
