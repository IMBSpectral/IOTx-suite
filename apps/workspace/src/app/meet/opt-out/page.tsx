import type { Metadata } from "next";
import OptOut from "@/components/meet/read/OptOut";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Don't summarise me" };

/** Public: people outside the workspace ask not to be transcribed or summarised (confirmed by email). No sign-in. */
export default function Page() {
  return <OptOut />;
}
