"use client";

import { useState } from "react";
import { useEscape } from "./useEscape";
import { Gift, X } from "lucide-react";
import { useBrand } from "@/components/BrandProvider";

/** "Share Forge": a personal invite link; both people get credits on signup. */
export default function ShareForge({ userId, bonus }: { userId: string; bonus: number }) {
  const [open, setOpen] = useState(false);
  const brand = useBrand();
  useEscape(open ? () => setOpen(false) : null);
  const [copied, setCopied] = useState(false);
  const link = typeof window === "undefined" ? "" : `${location.origin}/login?ref=${encodeURIComponent(userId)}`;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-black/[.05] dark:hover:bg-white/[.06]"
      >
        <Gift className="h-4 w-4 shrink-0" style={{ color: "var(--muted)" }} />
        <span className="truncate">Share {brand.shortName}, get {bonus} credits</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-label={`Share ${brand.shortName}`}
            className="w-full max-w-sm rounded-2xl border p-5 shadow-2xl"
            style={{ background: "var(--panel)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Share {brand.shortName}</h2>
              <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 hover:bg-black/[.05]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              When someone signs up with your link, you both get {bonus} credits.
            </p>
            <div className="mt-3 flex gap-1.5">
              <input readOnly value={link} aria-label="Your invite link" className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-xs" />
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(link).catch(() => undefined);
                  setCopied(true);
                }}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
