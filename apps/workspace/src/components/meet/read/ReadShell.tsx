"use client";
import "./read.css";
import { useState } from "react";
import { BarChart3, CalendarCheck, Folder, GaugeCircle, Lightbulb, MessageCircleQuestion, Newspaper, Plug, Settings, Sparkles, Video, X } from "lucide-react";
import { AskCompact } from "./Ask";

export type Section = "meetings" | "ask" | "foryou" | "coaching" | "recommendations" | "insights" | "folders" | "daily" | "integrations" | "settings";

const NAV: { id: Section; label: string; href: string; icon: React.ReactNode }[] = [
  { id: "meetings", label: "Meetings", href: "/workspace/meet", icon: <Video size={16} /> },
  { id: "ask", label: "Ask", href: "/workspace/meet/ask", icon: <MessageCircleQuestion size={16} /> },
  { id: "foryou", label: "For You", href: "/workspace/meet/foryou", icon: <Sparkles size={16} /> },
  { id: "coaching", label: "Coaching", href: "/workspace/meet/coaching", icon: <GaugeCircle size={16} /> },
  { id: "recommendations", label: "Recommendations", href: "/workspace/meet/recommendations", icon: <Lightbulb size={16} /> },
  { id: "insights", label: "Meeting Policy", href: "/workspace/meet/insights", icon: <BarChart3 size={16} /> },
  { id: "folders", label: "Folders", href: "/workspace/meet/folders", icon: <Folder size={16} /> },
  { id: "daily", label: "Daily Read", href: "/workspace/meet/daily", icon: <Newspaper size={16} /> },
  { id: "integrations", label: "Integrations", href: "/workspace/meet/integrations", icon: <Plug size={16} /> },
];

/** Meet with its sections in a left nav (tabs on phones), and "Ask" as a side panel on every section but Ask itself. */
export default function ReadShell({ active, children }: { active: Section; children: React.ReactNode }) {
  const [panel, setPanel] = useState(false);
  return (
    <div className="rd-shell">
      <nav className="rd-nav" aria-label="Meet sections">
        <h1><CalendarCheck size={17} /> Meet</h1>
        {NAV.map((n) => (
          <a key={n.id} href={n.href} className={n.id === active ? "on" : ""} aria-current={n.id === active ? "page" : undefined}>
            {n.icon} {n.label}
          </a>
        ))}
        <span className="sep" />
        <a href="/workspace/meet/settings" className={active === "settings" ? "on" : ""} aria-current={active === "settings" ? "page" : undefined}>
          <Settings size={16} /> Settings
        </a>
      </nav>
      <main className="rd-main">{children}</main>
      {active !== "ask" && !panel && (
        <button className="rd-fab" onClick={() => setPanel(true)} aria-label="Ask about your meetings">
          <MessageCircleQuestion size={16} /> Ask anything…
        </button>
      )}
      {panel && (
        <aside className="rd-panel" aria-label="Ask">
          <header>
            <MessageCircleQuestion size={16} /> <b>Ask about your meetings</b>
            <a className="mt-btn sm" href="/workspace/meet/ask">Open</a>
            <button className="mt-iconbtn" onClick={() => setPanel(false)} aria-label="Close"><X size={16} /></button>
          </header>
          <AskCompact />
        </aside>
      )}
    </div>
  );
}
