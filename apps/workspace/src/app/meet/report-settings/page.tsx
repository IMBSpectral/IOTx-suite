import type { Metadata } from "next";
import { readPage } from "@/lib/meet/read-page";
import ReportSettings from "@/components/meet/ReportSettings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Report templates · Meet" };

/** Meet settings for reports: templates and custom vocabulary. */
export default async function Page() {
  return readPage("settings", "/meet/report-settings", ({ me }) => <ReportSettings canEdit={!!me.perms["meetings.ai_notes"]} />);
}
