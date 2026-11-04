import { auth } from "@/lib/auth";
import { loadAppearance } from "@/lib/iotx/appearance-server";
import AppearanceSettings from "@/components/iotx/AppearanceSettings";

/** Settings → Appearance: theme, accent (presets or a custom colour) and the shell background. */
export default async function AppearancePage() {
  const session = await auth();
  const appearance = await loadAppearance(session!.user!.id);
  return <AppearanceSettings initial={appearance} />;
}
