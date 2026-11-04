import { Icon } from "./icons";
import { OrbitCore } from "./OrbitCore";

// The suite on the orbit: inner ring, outer ring.
export const ORBIT_INNER = [
  { icon: "builder", color: "linear-gradient(135deg,#4f46e5,#8b5cf6)", name: "Builder" },
  { icon: "sheets", color: "linear-gradient(135deg,#0f766e,#2dd4bf)", name: "Sheets" },
  { icon: "ledger", color: "linear-gradient(135deg,#b45309,#facc15)", name: "Accounts" },
  { icon: "docs", color: "linear-gradient(135deg,#3730a3,#a78bfa)", name: "Docs" },
  { icon: "chat", color: "linear-gradient(135deg,#7c3aed,#c084fc)", name: "AI Chat" },
];
export const ORBIT_OUTER = [
  { icon: "slides", color: "linear-gradient(135deg,#ea580c,#f472b6)", name: "Slides" },
  { icon: "tasks", color: "linear-gradient(135deg,#16a34a,#4ade80)", name: "Tasks" },
  { icon: "mail", color: "linear-gradient(135deg,#dc2626,#f87171)", name: "Mail" },
  { icon: "calendar", color: "linear-gradient(135deg,#4338ca,#818cf8)", name: "Calendar" },
  { icon: "meet", color: "linear-gradient(135deg,#0284c7,#38bdf8)", name: "Meetings" },
  { icon: "files", color: "linear-gradient(135deg,#2563eb,#93c5fd)", name: "Files" },
  { icon: "store", color: "linear-gradient(135deg,#e11d48,#fb7185)", name: "Store" },
];

/** IOTx Suite's apps circling the IX mark (decorative). */
export function Orbit({ className = "" }: { className?: string }) {
  const ring = (apps: typeof ORBIT_INNER, cls: string, size: number) => (
    <div className={`lg-ring ${cls}`}>
      {apps.map((a, i) => (
        <span key={a.name} className="lg-node" style={{ ["--i" as string]: i, ["--n" as string]: apps.length }}>
          <span className="lg-app" style={{ background: a.color }} title={a.name}>
            <Icon name={a.icon} size={size} />
          </span>
        </span>
      ))}
    </div>
  );
  return (
    <div className={`lg-orbit ${className}`} aria-hidden="true">
      {ring(ORBIT_OUTER, "lg-ring-outer", 18)}
      {ring(ORBIT_INNER, "lg-ring-inner", 20)}
      <div className="lg-core">
        <OrbitCore />
      </div>
    </div>
  );
}
