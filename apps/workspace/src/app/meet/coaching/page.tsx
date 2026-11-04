import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import { isReadAdmin } from "@/lib/meet/read";
import Coaching from "@/components/meet/read/Coaching";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Coaching · Meet" };

export default async function Page() {
  return readPage("coaching", "/meet/coaching", ({ me, boot }) => <Coaching admin={isReadAdmin(me)} people={boot.people.filter((p) => p.id !== me.userId)} />);
}
