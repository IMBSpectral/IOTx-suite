"use client";

import { useEffect, useState } from "react";
import { overlayFor, type Appearance, type ThemeChoice } from "@/lib/iotx/appearance";
import type { ShellData } from "@/lib/iotx/shell";
import { usePerms } from "./PermsProvider";
import { useBrand } from "@/components/BrandProvider";
import { Icon } from "./icons";
import { useLook } from "./TopActions";

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

/** The account's background (image or colour, with its veil), behind the start page and apps. */
function Background({ look }: { look: Appearance }) {
  const mode = useResolvedMode(look.theme);
  const bg = look.shellBg;
  if (bg.kind === "none") return null;
  return (
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
  );
}

/**
 * A page's canvas inside a suite tab: the account's background behind it and
 * the page at full size. The suite's chrome (tabs, toolbar, sidebar) is the
 * browser frame around the tabs (components/iotx/browser), not part of the page.
 */
export default function Shell({ data, children }: { data: ShellData; children: React.ReactNode; active?: string; activeChat?: string | null }) {
  const look = useLook(data.appearance);
  const hasBg = look.shellBg.kind !== "none";
  return (
    <div className={`ix ix-root ix-approot ${hasBg ? "has-bg" : ""}`} style={{ position: "relative" }}>
      <Background look={look} />
      <div className="ix-canvas">
        <div className="ix-content">{children}</div>
      </div>
    </div>
  );
}

/** "Previewing as …" across the top while an admin previews a role. */
export function PreviewBanner() {
  const perms = usePerms();
  const brand = useBrand();
  const [busy, setBusy] = useState(false);
  if (!perms.preview) return null;
  return (
    <div className="ix ix-banner" role="status" style={{ position: "fixed", top: 0, left: 0, right: 0 }}>
      <Icon name="eye" size={15} />
      Previewing {brand.name} as <b>{perms.preview.name}</b>. Buttons and the server act as this role would.
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await fetch("/api/permissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", roleId: null }) });
          window.location.reload();
        }}
      >
        Exit preview
      </button>
    </div>
  );
}
