import { auth } from "@/lib/auth";
import SettingsSearch from "@/components/SettingsSearch";
import SettingsTabs from "@/components/SettingsTabs";
import { isPlatformAdmin } from "@/lib/platform-admin";

const NAV = [
  { href: "/settings", label: "Workspace" },
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/members", label: "Members" },
  { href: "/settings/roles", label: "Roles & permissions" },
  { href: "/settings/actions", label: "Action center" },
  { href: "/settings/billing", label: "Billing" },
  { href: "/settings/insights", label: "Insights" },
  { href: "/settings/tiers", label: "App tiers" },
  { href: "/settings/mailboxes", label: "Mailboxes" },
  { href: "/settings/connectors", label: "Connectors" },
  { href: "/settings/skills", label: "Skills" },
  { href: "/settings/secrets", label: "Secrets" },
  { href: "/settings/api", label: "API & MCP" },
  { href: "/settings/events", label: "Events" },
  { href: "/settings/browser", label: "Browser" },
  { href: "/settings/sso", label: "SSO" },
  { href: "/settings/provisioning", label: "Provisioning" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/privacy", label: "Privacy" },
  { href: "/settings/memory", label: "Memory" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/preferences", label: "Preferences" },
];

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  // Settings opens with the slim app bar (layout); its own tabs are the navigation.
  return (
    <>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <h1 className="mb-5 text-xl font-semibold tracking-tight">Settings</h1>
          <SettingsSearch />
          <SettingsTabs nav={isPlatformAdmin(session?.user?.email) ? [...NAV, { href: "/settings/branding", label: "Branding" }, { href: "/settings/platform", label: "Platform" }] : NAV} />
          {children}
        </div>
      </main>
    </>
  );
}
