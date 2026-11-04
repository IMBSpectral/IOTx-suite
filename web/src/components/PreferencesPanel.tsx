"use client";

import { setTipsHidden, useTipsHidden } from "./chat/Tips";
import { resetCoachmarks } from "./Coachmark";
import ThemeToggle from "./ThemeToggle";
import AccountPrefs from "./AccountPrefs";

/** Preferences: per-browser ones (theme, tips) and account ones (suggestions, diagnostics, profile). */
export default function PreferencesPanel() {
  const tipsHidden = useTipsHidden();
  return (
    <div className="space-y-6">
      <section id="appearance">
        <h2 className="mb-3 text-sm font-medium">Appearance</h2>
        <div className="flex items-center justify-between gap-4 rounded-xl border p-5" style={{ background: "var(--panel)" }}>
          <span>
            <span className="block text-sm">Theme</span>
            <span className="block text-xs" style={{ color: "var(--muted)" }}>
              System follows your device&apos;s light or dark setting.
            </span>
          </span>
          <div className="w-64">
            <ThemeToggle labels />
          </div>
        </div>
      </section>

      <section id="tips">
        <h2 className="mb-3 text-sm font-medium">Tips &amp; tricks</h2>
        <div className="space-y-3 rounded-xl border p-5" style={{ background: "var(--panel)" }}>
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm">Show tips while the agent works</span>
              <span className="block text-xs" style={{ color: "var(--muted)" }}>
                Short ideas with a one-click prompt, shown during a build.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label="Show tips while the agent works"
              checked={!tipsHidden}
              onChange={(e) => setTipsHidden(!e.target.checked)}
              className="mt-1"
            />
          </label>
          <div className="flex items-center justify-between gap-4 border-t pt-3">
            <span>
              <span className="block text-sm">Feature hints</span>
              <span className="block text-xs" style={{ color: "var(--muted)" }}>
                Show the one-time hints again.
              </span>
            </span>
            <button onClick={resetCoachmarks} className="rounded-lg border px-2.5 py-1 text-xs">
              Reset hints
            </button>
          </div>
        </div>
      </section>
      <AccountPrefs />
    </div>
  );
}
