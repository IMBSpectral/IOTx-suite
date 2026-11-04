import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import ReadSettings from "@/components/meet/read/ReadSettings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings · Meet" };

export default async function Page() {
  return readPage("settings", "/meet/settings", () => <ReadSettings />);
}
