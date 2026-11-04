import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/platform-admin";
import AnnouncementsAdmin from "@/components/AnnouncementsAdmin";
import FreeBuildHourAdmin from "@/components/FreeBuildHourAdmin";

/** Settings for the whole Forge install, for platform admins (FORGE_ADMIN_EMAILS). */
export default async function PlatformSettingsPage() {
  const session = await auth();
  if (!isPlatformAdmin(session?.user?.email)) notFound();
  return (
    <div className="space-y-10">
      <FreeBuildHourAdmin />
      <AnnouncementsAdmin />
    </div>
  );
}
