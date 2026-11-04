"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";

/** On the dashboard until onboarding is done or skipped: pick your role and see a workspace made for it. */
export default function WelcomePrompt() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    fetch("/api/account/onboarding")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setShow(!d.answers))
      .catch(() => undefined);
  }, []);
  if (!show) return null;
  return (
    <div className="relative z-10 mx-auto mb-6 flex max-w-[672px] items-center gap-2 rounded-xl border px-3 py-2 text-xs" style={{ background: "var(--panel)" }}>
      <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent)" }} />
      <span className="flex-1">Tell us what you do and we&apos;ll set up apps for your week.</span>
      <Link href="/welcome" className="font-medium underline">
        Get started
      </Link>
    </div>
  );
}
