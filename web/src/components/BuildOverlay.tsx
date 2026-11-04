"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Check, Eye, FileCode2, Sparkles } from "lucide-react";
import FileIcon from "./code/FileIcon";
import { useDarkTheme, useReducedMotion } from "./code/media";
import { useTypingReveal } from "./code/useTypingReveal";
import "./build-overlay.css";

const MiniCode = dynamic(() => import("./code/MiniCode"), { ssr: false });

/** The file being written (or the latest one written), for the "code being written" panel. */
export type LiveCode = { path: string; content: string; writing: boolean };

/**
 * Full-size "building" view over the preview while the agent works: an app
 * assembling itself in a browser window (layout blocks drawing in, a cursor
 * placing them, a shimmer passing over), with what the agent is doing now,
 * the files it has written so far and the time elapsed. "Peek" shows the
 * current preview underneath until the next build. With `code`, a panel shows
 * that file's code scrolling in as it is written.
 */
export default function BuildOverlay({ stage, steps, name, first, onPeek, code }: { stage: string | null; steps: string[]; name: string; first: boolean; onPeek: () => void; code?: LiveCode | null }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setSecs(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const written = steps.filter((s) => /^(write|edit|create|rename):/.test(s)).map((s) => s.slice(s.indexOf(":") + 1)).filter((f, i, a) => a.indexOf(f) === i);
  const recent = written.slice(-5).reverse();
  const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  return (
    <div className="bo-root" role="status" aria-live="polite">
      <div className="bo-grid" aria-hidden />
      <div className="bo-glow" aria-hidden />
      <div className={`bo-stage${code ? " bo-has-code" : ""}`}>
        <div className="bo-work">
        <div className="bo-window" aria-hidden>
          <div className="bo-chrome">
            <i /><i /><i />
            <span className="bo-url">{name || "your app"}</span>
          </div>
          <div className="bo-page">
            <div className="bo-nav"><b className="bo-blk" /><span className="bo-blk" /><span className="bo-blk" /><span className="bo-blk" /></div>
            <div className="bo-hero">
              <div className="bo-col">
                <b className="bo-blk bo-h1" />
                <b className="bo-blk bo-h2" />
                <span className="bo-blk bo-p" />
                <span className="bo-blk bo-p bo-short" />
                <span className="bo-blk bo-btn" />
              </div>
              <div className="bo-blk bo-media" />
            </div>
            <div className="bo-cards">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bo-card" style={{ animationDelay: `${2.2 + i * 0.35}s` }}>
                  <span className="bo-blk bo-icon" />
                  <span className="bo-blk bo-line" />
                  <span className="bo-blk bo-line bo-short" />
                </div>
              ))}
            </div>
            <div className="bo-shimmer" />
          </div>
          <span className="bo-cursor" />
        </div>
        {code && <CodePanel key={code.path} code={code} />}
        </div>
        <div className="bo-info">
          <p className="bo-title"><Sparkles size={15} /> {first ? "Building your app" : "Updating your app"}</p>
          <p className="bo-now">{stage ?? "Working…"}</p>
          <div className="bo-bar"><span /></div>
          <p className="bo-meta">{time}{written.length ? ` · ${written.length} file${written.length === 1 ? "" : "s"} written` : ""}</p>
          {recent.length > 0 && (
            <ul className="bo-files">
              {recent.map((f, i) => (
                <li key={f} style={{ opacity: 1 - i * 0.16 }}>
                  {i === 0 ? <FileCode2 size={13} /> : <Check size={13} />}
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="bo-peek" onClick={onPeek}>
            <Eye size={14} /> Show the current preview
          </button>
        </div>
      </div>
    </div>
  );
}

/** The latest file's code, revealed as if typed (all at once with reduced motion). */
function CodePanel({ code }: { code: LiveCode }) {
  const reduced = useReducedMotion();
  const dark = useDarkTheme();
  const shown = useTypingReveal(code.content, !reduced);
  const typing = shown.length < code.content.length || code.writing;
  return (
    <div className="bo-code" aria-label={`Code being written: ${code.path}`}>
      <div className="bo-code-head">
        <FileIcon path={code.path} />
        <span className="bo-code-path">{code.path}</span>
        <span className="bo-code-state">{typing ? "Writing…" : "Written"}</span>
      </div>
      <div className="bo-code-body">
        <MiniCode key={code.path} path={code.path} code={shown} dark={dark} follow />
        {typing && <span className="bo-code-caret" aria-hidden />}
      </div>
    </div>
  );
}
