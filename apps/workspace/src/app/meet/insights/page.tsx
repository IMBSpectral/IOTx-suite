import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import { isReadAdmin } from "@/lib/meet/read";
import Policy from "@/components/meet/read/Policy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Meeting Policy · Meet" };

export default async function Page() {
  return readPage("insights", "/meet/insights", ({ me }) => <Policy admin={isReadAdmin(me)} />);
}
