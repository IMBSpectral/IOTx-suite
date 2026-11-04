"use client";
import { MoreHorizontal, Plus, Printer, Settings2 } from "lucide-react";
import type { Cal } from "./types";
import type { SettingsTab } from "./CalendarSettings";

type Google = { allowed: boolean; connected: boolean; lastSyncAt: string | null; error: string | null; connectUrl: string };

/** Which calendars are shown, Google sync, and the way into Settings: one menu on the toolbar. */
export default function CalendarsMenu({
  cals, hidden, setHidden, google, syncing, syncNow, openSettings, print,
}: {
  cals: Cal[];
  hidden: Set<string>;
  setHidden: (f: (h: Set<string>) => Set<string>) => void;
  google: Google | null;
  syncing: boolean;
  syncNow: () => void;
  openSettings: (tab: SettingsTab) => void;
  print: () => void;
}) {
  const toggle = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const row = (c: Cal) => (
    <div key={c.id} className="ws-calitem">
      <label style={{ display: "flex", gap: 8, alignItems: "center", flex: 1, minWidth: 0, cursor: "pointer" }}>
        <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => toggle(c.id)} style={{ accentColor: c.color }} />
        <span className="ws-swatch" style={{ background: c.color }} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
        {c.kind === "team" && <small className="ws-muted">team</small>}
        {c.access === "busy" && <small className="ws-muted">free/busy</small>}
        {c.icsError && <small className="ws-error" title={c.icsError}>!</small>}
      </label>
      <button className="ix-iconbtn cal-more" style={{ width: 24, height: 24 }} aria-label={`Settings for ${c.name}`} title="Settings and sharing" onClick={() => openSettings(`cal:${c.id}`)}>
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
  const mine = cals.filter((c) => !c.other);
  const other = cals.filter((c) => c.other);
  return (
    <div className="ix-pop cal-pop cal-menu" role="dialog" aria-label="Calendars and settings">
      <div className="ix-mlabel">My calendars</div>
      {mine.map(row)}
      <div className="ix-mlabel" style={{ display: "flex", alignItems: "center" }}>
        <span style={{ flex: 1 }}>Other calendars</span>
        <button className="ix-iconbtn" style={{ width: 22, height: 22 }} aria-label="Add other calendars" title="Add a colleague's calendar, a link, holidays or import" onClick={() => openSettings("add")}><Plus size={14} /></button>
      </div>
      {other.length ? other.map(row) : <button className="ws-link" style={{ padding: "2px 6px" }} onClick={() => openSettings("add")}>Add a colleague's calendar or holidays</button>}
      {google?.allowed && (
        <>
          <div className="ix-mlabel">Google Calendar</div>
          <div style={{ padding: "0 6px", fontSize: 12.5 }}>
            {google.connected ? (
              <>
                <span className="ws-muted">{google.lastSyncAt ? `Synced ${new Date(google.lastSyncAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Connected"}</span>
                {google.error && <div className="ws-error">{google.error}</div>}
                <button className="ws-link" onClick={syncNow} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
                <button className="ws-link" style={{ marginLeft: 8 }} onClick={() => openSettings("google")}>Choose calendars</button>
              </>
            ) : (
              <a className="ws-btn sm" href={google.connectUrl}>Connect Google Calendar</a>
            )}
          </div>
        </>
      )}
      <div className="cal-menu-foot">
        <button className="ws-btn sm" onClick={() => openSettings("general")}><Settings2 size={14} /> Settings</button>
        <button className="ws-btn sm" onClick={() => openSettings("booking")}>Booking pages</button>
        <button className="ix-iconbtn" aria-label="Print" title="Print" onClick={print}><Printer size={15} /></button>
      </div>
    </div>
  );
}
