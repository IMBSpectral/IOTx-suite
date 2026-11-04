import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import Recommendations from "@/components/meet/read/Recommendations";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Recommendations · Meet" };

export default async function Page() {
  return readPage("recommendations", "/meet/recommendations", () => <Recommendations />);
}
