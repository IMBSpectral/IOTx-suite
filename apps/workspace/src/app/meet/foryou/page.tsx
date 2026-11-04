import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import ForYou from "@/components/meet/read/ForYou";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "For You · Meet" };

export default async function Page() {
  return readPage("foryou", "/meet/foryou", ({ me }) => <ForYou canTasks={!!me.perms["tasks.create"] && !!me.perms["tasks.open"]} />);
}
