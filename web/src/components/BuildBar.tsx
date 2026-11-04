"use client";
import { useEffect, useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import "./build-overlay.css";

/**
 * The slim "Building… · Editing src/App.tsx · 1m 20s" bar over the live
 * preview while a follow-up build runs (the preview itself stays visible and
 * updates as files land). On a first build it can offer the full building
 * view back.
 */
export default function BuildBar({ activity, stage, onShowOverlay }: { activity: string | null; stage: string | null; onShowOverlay?: () => void }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setSecs(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  const doing = activity ?? stage;
  return (
    <div className="bb-root" role="status" aria-live="polite">
      <div className="bb-bar">
        <Loader2 className="bb-spin" size={13} aria-hidden />
        <b>Building…</b>
        {doing && (
          <>
            <span className="bb-dot" aria-hidden>·</span>
            <span className="bb-doing" title={doing}>{doing}</span>
          </>
        )}
        <span className="bb-dot" aria-hidden>·</span>
        <span className="bb-time">{time}</span>
        {onShowOverlay && (
          <button type="button" className="bb-btn" onClick={onShowOverlay} title="Show the building view">
            <Eye size={12} /> Building view
          </button>
        )}
      </div>
      <div className="bb-shimmer" aria-hidden />
    </div>
  );
}
