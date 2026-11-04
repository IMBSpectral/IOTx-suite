import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import Ask from "@/components/meet/read/Ask";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ask · Meet" };

/** Ask across meetings: chat with history over every report the person may see. */
export default async function Page() {
  return readPage("ask", "/meet/ask", () => (
    <div className="rd-page">
      <div className="rd-head"><h2>Ask</h2></div>
      <Ask />
    </div>
  ));
}
