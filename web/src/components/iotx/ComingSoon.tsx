"use client";

import Link from "next/link";
import { featuresOf, manifestById } from "@/lib/iotx/manifests";
import { useBrand } from "@/components/BrandProvider";
import { usePerms } from "./PermsProvider";
import { AppIcon, Icon } from "./icons";

/** The page an app shows inside the shell until it joins IOTx Suite. */
export default function ComingSoon({ appId }: { appId: string }) {
  const perms = usePerms();
  const brand = useBrand();
  // Manifest copy names the platform "IOTx"; show the current brand's name instead.
  const b = (t: string) => t.replace(/\bIOTx\b/g, brand.shortName);
  const m = manifestById(appId);
  if (!m) return null;
  const feats = featuresOf(m).filter((f) => f.type !== "limit");
  const mine = feats.filter((f) => perms.can(f.key));
  return (
    <>
      <div className="ix-aurora" aria-hidden />
      <div className="ix-soon">
        <AppIcon icon={m.icon} color={m.color} size={64} />
        <h1>
          {m.name} is <em>coming</em> to {brand.name}
        </h1>
        <p style={{ color: "var(--ix-muted)", margin: "0 auto", maxWidth: 520 }}>
          {b(m.desc)}. It will open right here, signed in with your {brand.shortName} account, and follow the switches your admin sets for your role.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "18px 0 26px", flexWrap: "wrap" }}>
          <span className="ix-chip">Coming soon</span>
          {m.mountPath && <span className="ix-chip muted">Will open at {m.mountPath}</span>}
          {m.source && <span className="ix-chip muted">Engine: {m.source}</span>}
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", textAlign: "left" }}>
          {m.roadmap && (
            <div className="ix-card">
              <b>What&apos;s next</b>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--ix-muted)" }}>
                {m.roadmap.map((r) => (
                  <li key={r}>{b(r)}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="ix-card">
            <b>Your access</b>
            <p style={{ margin: "6px 0 0", color: "var(--ix-muted)" }}>
              {mine.length
                ? `Your role already has ${mine.length} of ${feats.length} ${m.name} switches on, ready for launch.`
                : `An admin decides what you can do in ${m.name} under Roles & permissions.`}
            </p>
            {mine.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 8 }}>
                {mine.slice(0, 8).map((f) => (
                  <span key={f.key} className="ix-chip muted">
                    {b(f.label)}
                  </span>
                ))}
                {mine.length > 8 && <span className="ix-chip muted">+{mine.length - 8} more</span>}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 24 }}>
          <Link href="/home" className="ix-btn">
            <Icon name="home" size={14} /> Back to Home
          </Link>
          {perms.can("home.ask") && (
            <Link href={`/home/chat?prompt=${encodeURIComponent(`How could ${m.name} help my business?`)}&send=1`} className="ix-btn primary">
              <Icon name="chat" size={14} /> Ask {brand.shortName} about {m.name}
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
