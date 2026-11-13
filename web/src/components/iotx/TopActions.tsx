"use client";

import { useEffect, useState } from "react";
import NotificationsBell from "../NotificationsBell";
import { HEX, PRESETS, type Appearance, type AccentId, type ThemeChoice } from "@/lib/iotx/appearance";
import type { ShellData } from "@/lib/iotx/shell";
import { usePerms } from "./PermsProvider";
import { Icon, NineDots } from "./icons";
import { openLauncher, useChatUnread } from "./Launcher";
import { saveAppearance } from "./appearance-client";
import { TabLink } from "./tabs";

/** Opens the keyboard shortcuts list (the browser frame shows it). */
export const openShortcuts = () => window.dispatchEvent(new Event("iotx:shortcuts"));

function initials(name: string | null, email: string) {
  const s = (name || email).trim();
  return s.slice(0, 1).toUpperCase();
}

/** The appearance the account has now (follows changes made anywhere on the page). */
export function useLook(initial: Appearance) {
  const [look, setLook] = useState<Appearance>(initial);
  useEffect(() => {
    const onLook = (e: Event) => setLook((e as CustomEvent<Appearance>).detail);
    window.addEventListener("iotx:appearance", onLook);
    return () => window.removeEventListener("iotx:appearance", onLook);
  }, []);
  return look;
}

/**
 * The frame's top-right actions: the nine-dot launcher (with the Chat unread
 * count), the bell and the avatar menu (account, theme, settings, shortcuts,
 * workspaces, sign out). Their links open in a suite tab.
 */
export default function TopActions({ data }: { data: ShellData }) {
  const perms = usePerms();
  const [open, setOpen] = useState(false);
  const unread = useChatUnread(perms.opens("teamchat"));
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.("[data-ix-menu]")) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <>
      <button className="ix-iconbtn" onClick={openLauncher} aria-label={unread ? `All apps (Ctrl+J), ${unread} unread in Chat` : "All apps (Ctrl+J)"} title="All apps (Ctrl+J)" aria-haspopup="dialog" data-launcher>
        <NineDots />
        {unread > 0 && <span className="ix-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      <span className="ix-bell" style={{ display: "inline-flex" }}>
        <NotificationsBell align="right" />
      </span>
      <div data-ix-menu style={{ display: "contents" }}>
        <button className="ix-avatar" onClick={() => setOpen((o) => !o)} aria-label="Account" aria-haspopup="menu" aria-expanded={open}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {data.user.image ? <img src={data.user.image} alt="" /> : initials(data.user.name, data.user.email)}
        </button>
        {open && <AccountMenu data={data} onDone={() => setOpen(false)} />}
      </div>
    </>
  );
}

function AccountMenu({ data, onDone }: { data: ShellData; onDone: () => void }) {
  const perms = usePerms();
  const look = useLook(data.appearance);
  const [custom, setCustom] = useState(look.accentCustom ?? "#4f46e5");
  const roleName = perms.preview?.name ?? perms.roles[0]?.name ?? "Member";
  async function switchTo(id: string) {
    await fetch("/api/workspace/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: id }) });
    // Every tab shows the old workspace: load them all again (the tabs come back).
    window.location.reload();
  }
  const choose = (patch: Partial<Appearance>) => void saveAppearance(patch);
  return (
    <div className="ix-pop" role="menu" aria-label="Account" data-ix-menu style={{ width: 290 }}>
      <div style={{ padding: "6px 8px 8px" }}>
        <b style={{ display: "block", fontSize: 13 }}>{data.user.name || data.user.email}</b>
        <span className="ix-hint">{data.user.email}</span>
        <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
          {(perms.preview ? [{ id: "p", name: `Previewing ${perms.preview.name}` }] : perms.roles).map((r) => (
            <span key={r.id} className="ix-chip">
              {r.name}
            </span>
          ))}
          {!perms.roles.length && <span className="ix-chip">{roleName}</span>}
          <span className="ix-chip muted">{data.workspace.name}</span>
        </div>
      </div>
      <div className="ix-mlabel">Theme</div>
      <div className="row">
        {(["light", "dark", "system"] as ThemeChoice[]).map((t) => (
          <button key={t} className="opt" aria-pressed={look.theme === t} onClick={() => choose({ theme: t })} style={{ textTransform: "capitalize" }}>
            {t}
          </button>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "space-between", padding: "0 4px" }} aria-label="Accent">
        {(Object.keys(PRESETS) as Exclude<AccentId, "custom">[]).map((id) => (
          <button
            key={id}
            className="ix-swatch"
            aria-label={PRESETS[id].label}
            title={PRESETS[id].label}
            aria-pressed={look.accent === id}
            onClick={() => choose({ accent: id })}
            style={{ background: `linear-gradient(135deg,${PRESETS[id].base},${PRESETS[id].partner})` }}
          />
        ))}
        <label
          className="ix-swatch"
          aria-pressed={look.accent === "custom"}
          title="Custom colour"
          style={{ background: look.accent === "custom" ? custom : "conic-gradient(#e64980,#f59f00,#40c057,#228be6,#7950f2,#e64980)", display: "inline-block" }}
        >
          <input
            type="color"
            aria-label="Custom accent colour"
            value={HEX.test(custom) ? custom : "#4f46e5"}
            onChange={(e) => setCustom(e.target.value)}
            onBlur={(e) => choose({ accent: "custom", accentCustom: e.target.value })}
          />
        </label>
      </div>
      <TabLink href="/settings/preferences" className="ix-menuitem" onClick={onDone}>
        <Icon name="settings" size={15} /> Settings
      </TabLink>
      <TabLink href="/settings/appearance" className="ix-menuitem" onClick={onDone}>
        <Icon name="sun" size={15} /> Appearance and background
      </TabLink>
      {perms.canManage && (
        <TabLink href="/admin/roles" className="ix-menuitem" onClick={onDone}>
          <Icon name="admin" size={15} /> Roles & permissions
        </TabLink>
      )}
      {perms.canManage && (
        <TabLink href="/admin/ai-usage" className="ix-menuitem" onClick={onDone}>
          <Icon name="sparkle" size={15} /> AI usage
        </TabLink>
      )}
      {data.fleet && (
        <TabLink href="/admin/deployments" className="ix-menuitem" onClick={onDone}>
          <Icon name="globe" size={15} /> Deployments
        </TabLink>
      )}
      <button
        className="ix-menuitem"
        onClick={() => {
          onDone();
          openShortcuts();
        }}
      >
        <Icon name="keyboard" size={15} /> Keyboard shortcuts
      </button>
      {data.workspaces.length > 1 && (
        <>
          <div className="ix-mlabel" style={{ marginTop: 6 }}>
            Workspaces
          </div>
          {data.workspaces.map((w) => (
            <button key={w.id} className="ix-menuitem" onClick={() => switchTo(w.id)} aria-current={w.id === data.workspace.id}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</span>
              {w.id === data.workspace.id && <span className="ix-chip muted">Current</span>}
            </button>
          ))}
        </>
      )}
      <div style={{ borderTop: "1px solid var(--ix-line)", margin: "6px 0" }} />
      {/* Auth.js's sign-out page is a route handler, not an app page: a full page load. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/api/auth/signout" className="ix-menuitem">
        Sign out
      </a>
    </div>
  );
}
