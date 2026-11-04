import Link from "next/link";
import { AlarmClock, PauseCircle, Sparkles } from "lucide-react";
import type { CreditSummary } from "@/lib/billing-cycle";

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Sidebar nudges about credits: rollover credits about to expire, running out
 * (live backends pause after a grace period), and a free build hour.
 */
export default function CreditNotices({ summary, freeBuildEndsAt }: { summary: CreditSummary; freeBuildEndsAt: Date | null }) {
  const notices: React.ReactNode[] = [];
  if (freeBuildEndsAt) {
    notices.push(
      <div key="free" className="rounded-xl border px-3 py-2 text-xs" style={{ background: "var(--accent-soft)" }}>
        <span className="flex items-center gap-1.5 font-medium">
          <Sparkles className="h-3.5 w-3.5" /> Free build hour
        </span>
        <span style={{ color: "var(--muted)" }}>Builds don&apos;t use credits until {time(freeBuildEndsAt)}.</span>
      </div>,
    );
  }
  if (summary.pausesAt) {
    const pauseOn = new Date(summary.pausesAt);
    const paused = summary.paused;
    notices.push(
      <Link
        key="out"
        href="/settings/billing"
        className="block rounded-xl border border-amber-500/40 px-3 py-2 text-xs hover:bg-amber-500/[.06]"
      >
        <span className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
          <PauseCircle className="h-3.5 w-3.5" /> You&apos;re out of credits
        </span>
        <span style={{ color: "var(--muted)" }}>
          {paused
            ? "Your apps' backends are paused. Add credits to bring them back."
            : `Add credits by ${day(pauseOn)} to keep your projects live.`}
        </span>
      </Link>,
    );
  }
  if (summary.expiryNudge) {
    notices.push(
      <Link key="exp" href="/settings/billing" className="block rounded-xl border px-3 py-2 text-xs hover:bg-black/[.03] dark:hover:bg-white/[.04]">
        <span className="flex items-center gap-1.5 font-medium">
          <AlarmClock className="h-3.5 w-3.5" /> {summary.expiryNudge[0].toUpperCase() + summary.expiryNudge.slice(1)}
        </span>
        <span style={{ color: "var(--muted)" }}>Unused rollover credits expire at the end of your billing period.</span>
      </Link>,
    );
  }
  return notices.length ? <>{notices}</> : null;
}
