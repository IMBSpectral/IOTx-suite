import PreferencesPanel from "@/components/PreferencesPanel";
import MfaPanel from "@/components/MfaPanel";

export default function PreferencesPage() {
  return (
    <div className="space-y-10">
      <PreferencesPanel />
      <MfaPanel />
    </div>
  );
}
