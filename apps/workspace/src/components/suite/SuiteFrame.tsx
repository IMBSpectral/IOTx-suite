"use client";

import { useEffect } from "react";
import type { SuiteShell } from "@/lib/suite";
import { PermsProvider } from "./PermsProvider";
import { BrandProvider } from "./BrandProvider";
import AppearanceSync from "./AppearanceSync";
import Shell from "./Shell";

/** The suite's address for this page in a tab: its frame opens /tab?u=<this page>. */
export const suiteTabUrl = (suite: string) => `${suite}/tab?u=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`;

/**
 * What every Calendar, Tasks, Chat and Meet page gets: permissions, brand and
 * the account's appearance. The suite is a browser, and these pages show in
 * its tabs (same-origin iframes), so they have no chrome of their own: the
 * suite's frame has the tabs, address bar, bell, launcher and avatar. A page
 * opened on its own goes into the suite's frame, in a tab (lib/page.tsx does
 * it on the server; this catches browsers that don't say they're top-level).
 */
export default function SuiteFrame({ s, children }: { s: SuiteShell; active: "calendar" | "tasks" | "teamchat" | "meetings"; chatOn: boolean; children: React.ReactNode }) {
  useEffect(() => {
    if (window.self === window.top && !s.offline) window.location.replace(suiteTabUrl(s.suite));
  }, [s.offline, s.suite]);

  // Escape closes the topmost dialog, the same as clicking outside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const scrims = document.querySelectorAll<HTMLElement>(".ws-modal-scrim");
      const top = scrims[scrims.length - 1];
      if (!top) return;
      e.preventDefault();
      top.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <BrandProvider brand={s.brand}>
      <PermsProvider value={s.shell.perms}>
        <div style={{ height: "100dvh" }}>
          {!s.offline && <AppearanceSync appearance={s.shell.appearance} />}
          <Shell data={s.shell}>{children}</Shell>
        </div>
      </PermsProvider>
    </BrandProvider>
  );
}
