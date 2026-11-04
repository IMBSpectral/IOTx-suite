// COPY of web/src/components/iotx/Shell.tsx: a page's canvas inside a suite tab (the account's
// background behind the page, the page at full size). The suite itself is a browser: its frame
// (tabs, toolbar with the address bar, bell and avatar, the apps sidebar) lives in the suite's top
// window and shows Calendar, Tasks, Chat and Meet in tabs. Differences: the appearance helpers'
// import path. Keep in step with web; see docs/WORKSPACE-STATUS.md.
"use client";

import { useEffect, useState } from "react";
import { overlayFor, type Appearance, type ThemeChoice } from "@/lib/suite-appearance";
import type { SuiteShell } from "@/lib/suite";

type ShellData = SuiteShell["shell"];

function useResolvedMode(theme: ThemeChoice): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">("light");
  useEffect(() => {
    const read = () => setMode(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [theme]);
  return mode;
}

/** The appearance the account has now (the suite's frame forwards changes made there). */
function useLook(initial: Appearance) {
  const [look, setLook] = useState<Appearance>(initial);
  useEffect(() => {
    const onLook = (e: Event) => setLook((e as CustomEvent<Appearance>).detail);
    window.addEventListener("iotx:appearance", onLook);
    return () => window.removeEventListener("iotx:appearance", onLook);
  }, []);
  return look;
}

/** A Calendar, Tasks, Chat or Meet page inside a suite tab: no chrome of its own. */
export default function Shell({ data, children }: { data: ShellData; children: React.ReactNode }) {
  const look = useLook(data.appearance);
  const mode = useResolvedMode(look.theme);
  const bg = look.shellBg;
  return (
    <div className={`ix ix-root ix-approot ${bg.kind !== "none" ? "has-bg" : ""}`} style={{ position: "relative" }}>
      {bg.kind !== "none" && (
        <>
          <div
            className="ix-bg-layer"
            aria-hidden
            style={
              bg.kind === "image" && bg.image
                ? { backgroundImage: `url(${bg.image})`, filter: bg.blur ? `blur(${bg.blur}px)` : undefined, inset: bg.blur ? -bg.blur * 2 : 0 }
                : { background: bg.color }
            }
          />
          <div className="ix-bg-veil" aria-hidden style={{ opacity: overlayFor(bg, mode) }} />
        </>
      )}
      <div className="ix-canvas">
        <div className="ix-content">{children}</div>
      </div>
    </div>
  );
}
