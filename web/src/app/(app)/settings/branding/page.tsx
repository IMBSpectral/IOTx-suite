import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { getBrand } from "@/lib/brand";
import BrandingPanel from "@/components/BrandingPanel";

/** Settings → Branding: the platform's name, logo and copy (platform admins). */
export default async function BrandingSettingsPage() {
  const session = await auth();
  if (!isPlatformAdmin(session?.user?.email)) notFound();
  return <BrandingPanel initial={getBrand()} />;
}
