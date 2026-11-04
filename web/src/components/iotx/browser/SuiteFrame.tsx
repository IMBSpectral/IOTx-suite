"use client";

import { useSyncExternalStore } from "react";
import type { ShellData } from "@/lib/iotx/shell";
import AppearanceSync from "../AppearanceSync";
import Browser from "./Browser";

const noop = () => () => {};

/**
 * The suite's outer interface for every (app) page. The top window gets the
 * browser frame (tabs, toolbar, sidebar), and each tab shows its page in a
 * same-origin iframe; a page inside a tab gets no chrome at all.
 *
 * The server tells them apart by Sec-Fetch-Dest ("document" for a top-level
 * load, "iframe" inside a tab), so neither flashes the wrong layout. In the
 * browser, window.top settles it (old browsers, client-side refreshes).
 */
export default function SuiteFrame({ data, userId, top, children }: { data: ShellData; userId: string; top: boolean; children: React.ReactNode }) {
  const embedded = useSyncExternalStore(noop, () => window.self !== window.top, () => !top);
  if (!embedded) return <Browser data={data} userId={userId} />;
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppearanceSync appearance={data.appearance} />
      <div className="app-shell flex min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
