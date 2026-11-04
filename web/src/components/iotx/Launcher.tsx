"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MANIFESTS } from "@/lib/iotx/manifests";
import { usePerms } from "./PermsProvider";
import { useBrand } from "@/components/BrandProvider";
import { AppIcon, Icon } from "./icons";
import { TabLink, openInSuite } from "./tabs";

/** Where an app opens: live apps at their own page, the rest on their Coming soon page. */
export const appHref = (id: string) => {
  const m = MANIFESTS.find((x) => x.id === id);
  return m?.status === "live" && m.href ? m.href : `/apps/${id}`;
};

export const openLauncher = () => window.dispatchEvent(new Event("iotx:launcher"));

/**
 * Unread team-chat messages (Chat lives in apps/workspace under /workspace on
 * the same origin). 0 when Workspace can't be reached or has no session yet.
 */
export function useChatUnread(on: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () =>
      fetch("/workspace/api/chat/unread", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { total: 0 }))
        .then((d: { total?: number }) => live && setN(d.total ?? 0))
        .catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener("focus", load);
    };
  }, [on]);
  return on ? n : 0;
}

/**
 * The nine-dot launcher: every app the person can open, searchable. Opens
 * with Ctrl+J (Cmd+J) anywhere in the suite, or the nine-dot button. An app
 * opens in the current suite tab; Ctrl/Cmd or middle click opens a new tab.
 */
export default function Launcher() {
  const perms = usePerms();
  const brand = useBrand();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const unread = useChatUnread(open && perms.opens("teamchat"));

  useEffect(() => {
    const toggle = () => {
      setQ("");
      setActive(0);
      setOpen((o) => !o);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("iotx:launcher", toggle);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("iotx:launcher", toggle);
    };
  }, []);

  const apps = useMemo(() => {
    const f = q.trim().toLowerCase();
    return MANIFESTS.filter((m) => m.id !== "home" && !m.settingsOnly && perms.opens(m.id)).filter((m) => !f || m.name.toLowerCase().includes(f) || m.desc.toLowerCase().includes(f));
  }, [q, perms]);

  if (!open) return null;
  const go = (id: string, newTab = false) => {
    setOpen(false);
    openInSuite(appHref(id), { newTab });
  };

  return (
    <div className="ix" style={{ background: "none" }}>
      <div className="ix-scrim" onClick={() => setOpen(false)} aria-hidden />
      <div className="ix-launcher" role="dialog" aria-label={`All ${brand.name} apps`}>
        <div style={{ display: "flex", alignItems: "start" }}>
          <div style={{ flex: 1 }}>
            <h4>{brand.name} apps</h4>
            <div className="sub2">
              {apps.length} apps{perms.preview ? ` for ${perms.preview.name}` : perms.roles[0] ? ` for ${perms.roles[0].name}` : ""}
              {" · Ctrl+click for a new tab"}
            </div>
          </div>
          <button className="ix-iconbtn" onClick={() => setOpen(false)} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="ix-lsearch">
          <Icon name="search" size={14} />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apps[active]) go(apps[active].id, e.altKey);
              if (e.key === "ArrowRight" || e.key === "ArrowDown") setActive((i) => Math.min(i + 1, apps.length - 1));
              if (e.key === "ArrowLeft" || e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
            }}
            placeholder="Search apps…"
            aria-label="Search apps"
          />
          <kbd className="ix-hint">Ctrl J</kbd>
        </div>
        <div className="ix-lgrid">
          {apps.map((m, i) => (
            <TabLink
              key={m.id}
              href={appHref(m.id)}
              className={`ix-lapp ${i === active ? "active" : ""}`}
              onClick={() => setOpen(false)}
              title={m.status === "soon" ? `${m.name} is coming soon` : m.name}
              data-app={m.id}
            >
              {m.status === "soon" && <span className="soon" aria-label="Coming soon" />}
              {m.id === "teamchat" && unread > 0 && <span className="ix-badge">{unread > 99 ? "99+" : unread}</span>}
              <AppIcon icon={m.icon} color={m.color} />
              {m.name}
              <small>{m.desc}</small>
            </TabLink>
          ))}
          {apps.length === 0 && (
            <div className="sub2" style={{ gridColumn: "1/-1", padding: 12 }}>
              No apps match.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
