"use client";
import { useEffect } from "react";

/**
 * Sends the browser to the suite for a sign-in pass. The page's own address
 * (path, query and hash) rides along as `next`, so a deep link such as
 * /tasks?project=…&task=WEB-4 comes back to the same place.
 */
export default function Bounce({ to }: { to: string }) {
  useEffect(() => {
    let dest = to;
    try {
      const u = new URL(to, window.location.href);
      const cb = new URL(u.searchParams.get("redirect") ?? "", window.location.href);
      const here = `${window.location.pathname.replace(/^\/workspace(?=\/|$)/, "") || "/"}${window.location.search}${window.location.hash}`;
      if (here.startsWith("/") && !here.startsWith("//")) {
        cb.searchParams.set("next", here);
        // Same site (production): the suite only accepts a path. Another origin (local dev ports) stays absolute.
        u.searchParams.set("redirect", cb.origin === window.location.origin ? `${cb.pathname}${cb.search}` : cb.toString());
        dest = u.toString();
      }
    } catch {}
    window.location.replace(dest);
  }, [to]);
  return (
    <div className="ws-center">
      <div className="ws-spinner" aria-hidden />
      <p>Signing you in through IOTx…</p>
      <a href={to}>Continue</a>
    </div>
  );
}
