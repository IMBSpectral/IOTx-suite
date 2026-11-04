import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import Folders from "@/components/meet/read/Folders";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Folders · Meet" };

export default async function Page() {
  return readPage("folders", "/meet/folders", ({ me, boot }) => <Folders people={boot.people} meId={me.userId} />);
}
