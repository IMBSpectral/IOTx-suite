"use client";
import { useEffect, useMemo, useState } from "react";
import { Cake, CalendarPlus, Clock, Code2, Copy, ExternalLink, Globe, Link2, Plus, RefreshCw, Settings2, Trash2, Upload, X } from "lucide-react";
import { api } from "@/lib/client";
import { COLORS, DAY_NAMES, weekdayOrder, zones, type Cal, type Person, type Range, type Settings } from "./types";
import { REMINDERS } from "./EventEditor";

export type SettingsTab = "general" | "hours" | "add" | "booking" | "google" | `cal:${string}`;
type Booking = {
  id: string; slug: string; url: string; title: string; description: string; minutes: number; hours: Record<string, Range[]>; tz: string; bufferMin: number;
  noticeHours: number; maxDays: number; maxPerDay: number | null; locationKind: string; location: string; questions: { id: string; label: string; required: boolean }[]; color: string; enabled: boolean;
};

const ROLE: Record<string, string> = { busy: "See only free/busy", read: "See all event details", edit: "Make changes to events", manage: "Make changes and manage sharing" };

export default function CalendarSettings({
  tab: initial, cals, people, meId, settings, canTeam, onSettings, onChanged, onClose, flash, google,
}: {
  /** Google Calendar is connected: choose more Google calendars to sync. */
  google?: boolean;
  tab: SettingsTab;
  cals: Cal[];
  people: Person[];
  meId: string;
  settings: Settings;
  canTeam: boolean;
  onSettings: (s: Settings) => void;
  onChanged: () => void;
  onClose: () => void;
  flash: (m: string) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initial);
  const mine = cals.filter((c) => c.mine || c.access === "manage" || (c.kind === "team" && c.access === "owner"));
  const others = cals.filter((c) => c.other);
  const save = async (patch: Partial<Settings>) => {
    onSettings({ ...settings, ...patch });
    try {
      const r = await api<{ settings: Settings }>("/calendar/settings", { method: "PUT", body: patch });
      onSettings(r.settings);
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const cal = tab.startsWith("cal:") ? cals.find((c) => c.id === tab.slice(4)) : undefined;

  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ws-modal wide cal-settings" role="dialog" aria-label="Calendar settings">
        <header>
          <Settings2 size={17} />
          <h3>Settings</h3>
          <button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="cs-body">
          <nav className="cs-nav" aria-label="Settings sections">
            <button aria-current={tab === "general"} onClick={() => setTab("general")}>General</button>
            <button aria-current={tab === "hours"} onClick={() => setTab("hours")}>Working hours</button>
            <button aria-current={tab === "booking"} onClick={() => setTab("booking")}>Booking pages</button>
            <button aria-current={tab === "add"} onClick={() => setTab("add")}>Add calendar</button>
            {google && <button aria-current={tab === "google"} onClick={() => setTab("google")}>Google Calendar</button>}
            <div className="cs-group">Settings for my calendars</div>
            {mine.map((c) => (
              <button key={c.id} aria-current={tab === `cal:${c.id}`} onClick={() => setTab(`cal:${c.id}`)}>
                <span className="ws-swatch" style={{ background: c.color }} /> {c.name}
              </button>
            ))}
            {others.length > 0 && <div className="cs-group">Other calendars</div>}
            {others.map((c) => (
              <button key={c.id} aria-current={tab === `cal:${c.id}`} onClick={() => setTab(`cal:${c.id}`)}>
                <span className="ws-swatch" style={{ background: c.color }} /> {c.name}
              </button>
            ))}
          </nav>
          <div className="cs-pane">
            {tab === "general" && <General s={settings} save={save} />}
            {tab === "google" && google && <GoogleCalendars cals={cals} flash={flash} onChanged={onChanged} />}
            {tab === "hours" && <Hours s={settings} save={save} />}
            {tab === "booking" && <Bookings flash={flash} cals={mine} tz={settings.tz} />}
            {tab === "add" && <AddCalendar cals={cals} people={people} meId={meId} canTeam={canTeam} flash={flash} onChanged={onChanged} open={(id) => setTab(`cal:${id}`)} />}
            {cal && <CalendarPane key={cal.id} c={cal} people={people} meId={meId} flash={flash} onChanged={onChanged} onGone={() => setTab("general")} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function General({ s, save }: { s: Settings; save: (p: Partial<Settings> & { tz?: string }) => void }) {
  const all = useMemo(() => zones(), []);
  const zs = [...new Set([s.tz, ...(s.secondTz ? [s.secondTz] : []), ...all])];
  return (
    <div className="cs-sec">
      <h4>Time zone</h4>
      <div className="ws-field">
        <label className="ws-label" htmlFor="cs-tz">Primary time zone</label>
        <select id="cs-tz" className="ws-select" value={s.tz} onChange={(e) => save({ tz: e.target.value })}>
          {zs.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
        </select>
      </div>
      <div className="ws-field">
        <label className="ws-row" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!s.secondTz} onChange={(e) => save({ secondTz: e.target.checked ? (s.tz === "UTC" ? "Asia/Kolkata" : "UTC") : null })} /> Display a secondary time zone
        </label>
        {s.secondTz && (
          <select className="ws-select" style={{ marginTop: 6 }} aria-label="Secondary time zone" value={s.secondTz} onChange={(e) => save({ secondTz: e.target.value })}>
            {zs.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
          </select>
        )}
      </div>
      <Birthday s={s} save={save} />
      <h4>View options</h4>
      <div className="cs-grid">
        <label className="ws-label" htmlFor="cs-ws">Start week on</label>
        <select id="cs-ws" className="ws-select" value={s.weekStart} onChange={(e) => save({ weekStart: Number(e.target.value) as Settings["weekStart"] })}>
          <option value={1}>Monday</option><option value={0}>Sunday</option><option value={6}>Saturday</option>
        </select>
        <label className="ws-label" htmlFor="cs-tf">Time format</label>
        <select id="cs-tf" className="ws-select" value={s.timeFormat} onChange={(e) => save({ timeFormat: e.target.value as Settings["timeFormat"] })}>
          <option value="12">1:00 PM</option><option value="24">13:00</option>
        </select>
        <label className="ws-label" htmlFor="cs-dm">Default event length</label>
        <select id="cs-dm" className="ws-select" value={s.defaultMinutes} onChange={(e) => save({ defaultMinutes: Number(e.target.value) })}>
          {[15, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 60 ? "60 minutes" : `${m / 60} hours`}</option>)}
        </select>
        <label className="ws-label" htmlFor="cs-dr">Default notification</label>
        <select id="cs-dr" className="ws-select" value={s.defaultReminders[0] ?? -1} onChange={(e) => save({ defaultReminders: Number(e.target.value) < 0 ? [] : [Number(e.target.value)] })}>
          <option value={-1}>None</option>
          {REMINDERS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
        </select>
      </div>
      <label className="ws-row" style={{ gap: 6, marginTop: 10 }}><input type="checkbox" checked={s.showWeekends} onChange={(e) => save({ showWeekends: e.target.checked })} /> Show weekends</label>
      <label className="ws-row" style={{ gap: 6, marginTop: 6 }}><input type="checkbox" checked={s.showDeclined} onChange={(e) => save({ showDeclined: e.target.checked })} /> Show declined events</label>
      <h4>Keyboard shortcuts</h4>
      <Shortcuts />
    </div>
  );
}

export function Shortcuts() {
  const rows: [string, string][] = [
    ["c", "Create event"], ["t", "Go to today"], ["j / n", "Next period"], ["k / p", "Previous period"],
    ["d", "Day view"], ["x", "4 days view"], ["w", "Week view"], ["m", "Month view"], ["y", "Year view"], ["a", "Schedule view"],
    ["/", "Search"], ["e", "Edit the open event"], ["Delete", "Delete the open event"], ["?", "Show shortcuts"], ["Esc", "Close"],
  ];
  return (
    <table className="cs-keys">
      <tbody>{rows.map(([k, l]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{l}</td></tr>)}</tbody>
    </table>
  );
}

function Hours({ s, save }: { s: Settings; save: (p: Partial<Settings>) => void }) {
  const [h, setH] = useState(s.hours);
  const [loc, setLoc] = useState(s.location);
  const set = (d: number, list: Range[]) => {
    const n = { ...h };
    if (list.length) n[String(d)] = list;
    else delete n[String(d)];
    setH(n);
    return n;
  };
  return (
    <div className="cs-sec">
      <h4>Working hours</h4>
      <p className="ws-muted cs-note">People who invite you outside these hours are warned. Time outside them is shaded, and the assistant plans only inside them.</p>
      {weekdayOrder().map((d) => {
        const list = h[String(d)] ?? [];
        return (
          <div key={d} className="cs-day">
            <label className="ws-row" style={{ gap: 6, width: 120 }}>
              <input type="checkbox" checked={list.length > 0} onChange={(e) => save({ hours: set(d, e.target.checked ? [{ start: "09:00", end: "18:00" }] : []) })} /> {DAY_NAMES[d]}
            </label>
            <div style={{ flex: 1, display: "grid", gap: 4 }}>
              {list.length === 0 && <span className="ws-muted">Unavailable</span>}
              {list.map((r, i) => (
                <div key={i} className="ws-row" style={{ gap: 6 }}>
                  <input type="time" className="ws-input" style={{ width: 120 }} value={r.start} aria-label={`${DAY_NAMES[d]} from`} onChange={(e) => set(d, list.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} onBlur={() => save({ hours: h })} />
                  <span className="ws-muted">–</span>
                  <input type="time" className="ws-input" style={{ width: 120 }} value={r.end} aria-label={`${DAY_NAMES[d]} to`} onChange={(e) => set(d, list.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} onBlur={() => save({ hours: h })} />
                  <button className="ix-iconbtn" style={{ width: 26, height: 26 }} aria-label="Remove hours" onClick={() => save({ hours: set(d, list.filter((_, j) => j !== i)) })}><X size={13} /></button>
                  {i === list.length - 1 && list.length < 4 && (
                    <button className="ix-iconbtn" style={{ width: 26, height: 26 }} aria-label="Add hours" title="Split the day (e.g. a lunch break)" onClick={() => save({ hours: set(d, [...list, { start: r.end < "20:00" ? "19:00" : "21:00", end: r.end < "20:00" ? "20:00" : "22:00" }]) })}><Plus size={13} /></button>
                  )}
                </div>
              ))}
            </div>
            {list.length > 0 && (
              <select className="ws-select" style={{ width: 130 }} aria-label={`${DAY_NAMES[d]} location`} value={loc[String(d)] ?? ""}
                onChange={(e) => { const n = { ...loc }; if (e.target.value) n[String(d)] = e.target.value; else delete n[String(d)]; setLoc(n); save({ location: n }); }}>
                <option value="">Location…</option>
                <option value="Office">Office</option>
                <option value="Home">Home</option>
                <option value="Elsewhere">Elsewhere</option>
                {loc[String(d)] && !["Office", "Home", "Elsewhere"].includes(loc[String(d)]) && <option value={loc[String(d)]}>{loc[String(d)]}</option>}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CalendarPane({ c, people, meId, flash, onChanged, onGone }: { c: Cal; people: Person[]; meId: string; flash: (m: string) => void; onChanged: () => void; onGone: () => void }) {
  const [name, setName] = useState(c.name);
  const [desc, setDesc] = useState(c.description ?? "");
  const [shares, setShares] = useState(c.shares ?? []);
  const [pick, setPick] = useState("");
  const manage = c.access === "owner" || c.access === "manage";
  const patch = async (body: Record<string, unknown>, ok?: string) => {
    try {
      const r = await api<{ calendar: Cal }>("/calendar/calendars", { method: "PATCH", body: { id: c.id, ...body } });
      if (body.shares) setShares((r.calendar as Cal & { shares?: Cal["shares"] }).shares ?? (body.shares as Cal["shares"]) ?? []);
      if (ok) flash(ok);
      onChanged();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const sub = async (body: Record<string, unknown>) => {
    try {
      await api("/calendar/others", { method: "PATCH", body: { calendarId: c.id, ...body } });
      onChanged();
      if (body.remove) onGone();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => flash("Copied"), () => flash(t));
  const who = (id: string) => people.find((p) => p.id === id);

  if (c.other || !manage)
    return (
      <div className="cs-sec">
        <h4>{c.name}</h4>
        <p className="ws-muted cs-note">
          {c.kind === "subscribed" ? `Subscribed from ${c.icsUrl ?? "a calendar link"}${c.icsFetchedAt ? ` · updated ${new Date(c.icsFetchedAt).toLocaleString()}` : ""}` : c.ownerName ? `${c.ownerName}'s calendar` : "Shared with you"}
          {c.access ? ` · you can ${ROLE[c.access]?.toLowerCase() ?? c.access}` : ""}
        </p>
        {c.icsError && <p className="ws-error">{c.icsError}</p>}
        <div className="ws-field">
          <label className="ws-label">Colour</label>
          <div className="colors">{COLORS.map((x) => <button type="button" key={x} aria-pressed={c.color === x} aria-label={x} style={{ background: x }} onClick={() => sub({ color: x })} />)}</div>
        </div>
        {c.other && <button className="ws-btn danger" onClick={() => sub({ remove: true })}><Trash2 size={14} /> Remove from my list</button>}
      </div>
    );

  return (
    <div className="cs-sec">
      <h4>Calendar settings</h4>
      <div className="ws-field">
        <label className="ws-label" htmlFor="cs-name">Name</label>
        <input id="cs-name" className="ws-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== c.name && patch({ name: name.trim() })} />
      </div>
      <div className="ws-field">
        <label className="ws-label" htmlFor="cs-desc">Description</label>
        <textarea id="cs-desc" className="ws-textarea" style={{ minHeight: 56 }} value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== (c.description ?? "") && patch({ description: desc })} />
      </div>
      <div className="ws-field">
        <label className="ws-label">Colour</label>
        <div className="colors">{COLORS.map((x) => <button type="button" key={x} aria-pressed={c.color === x} aria-label={x} style={{ background: x }} onClick={() => patch({ color: x })} />)}</div>
      </div>

      <h4>Access permissions</h4>
      <div className="ws-field">
        <label className="ws-label" htmlFor="cs-wsa">Everyone in the workspace can</label>
        <select id="cs-wsa" className="ws-select" value={c.wsAccess ?? "busy"} onChange={(e) => patch({ wsAccess: e.target.value }, "Saved")}>
          <option value="none">Not see this calendar</option>
          <option value="busy">See only free/busy (hide details)</option>
          <option value="read">See all event details</option>
        </select>
      </div>

      <h4>Share with specific people</h4>
      {shares.length === 0 && <p className="ws-muted cs-note">Not shared with anyone yet.</p>}
      {shares.map((s) => (
        <div key={s.userId} className="cs-share">
          <span style={{ flex: 1, minWidth: 0 }}>{who(s.userId)?.name ?? "Someone"} <small className="ws-muted">{who(s.userId)?.email}</small></span>
          <select className="ws-select" style={{ width: 230 }} value={s.role} aria-label="Permission" onChange={(e) => patch({ shares: shares.map((x) => (x.userId === s.userId ? { ...x, role: e.target.value } : x)) })}>
            {Object.entries(ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="ix-iconbtn" aria-label="Stop sharing" onClick={() => patch({ shares: shares.filter((x) => x.userId !== s.userId) })}><X size={14} /></button>
        </div>
      ))}
      <div className="ws-row" style={{ marginTop: 6 }}>
        <select className="ws-select" style={{ flex: 1 }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add people">
          <option value="">Add people…</option>
          {people.filter((p) => p.id !== meId && p.id !== c.ownerId && !shares.some((s) => s.userId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
        </select>
        <button className="ws-btn" disabled={!pick} onClick={() => { void patch({ shares: [...shares, { userId: pick, role: "read" }] }, "Shared"); setPick(""); }}>Share</button>
      </div>

      {c.kind !== "subscribed" && <PublicAccess c={c} patch={patch} copy={copy} />}

      <h4>Integrate calendar</h4>
      <div className="ws-field">
        <label className="ws-label">Secret address in iCal format</label>
        {c.feed ? (
          <>
            <div className="ws-row">
              <input className="ws-input" readOnly value={c.feed} style={{ flex: 1, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }} aria-label="Secret iCal address" onFocus={(e) => e.target.select()} />
              <button className="ix-iconbtn" aria-label="Copy" onClick={() => copy(c.feed!)}><Copy size={14} /></button>
            </div>
            <p className="ws-muted cs-note">Anyone with this link can see your events (private ones show as busy). Don't share it.</p>
            <div className="ws-row">
              <button className="ws-btn sm" onClick={() => patch({ feed: "reset" }, "A new secret address was made; the old one stopped working.")}>Reset</button>
              <button className="ws-btn sm" onClick={() => patch({ feed: false }, "Secret address turned off")}>Turn off</button>
            </div>
          </>
        ) : (
          <button className="ws-btn sm" onClick={() => patch({ feed: true })}><Link2 size={13} /> Make a secret iCal link</button>
        )}
      </div>
      <div className="ws-row">
        <a className="ws-btn sm" href={`/workspace/api/calendar/ics?calendarId=${c.id}`} download><ExternalLink size={13} /> Export (.ics)</a>
      </div>
      {!c.primary && (c.access === "owner") && (
        <>
          <h4>Remove calendar</h4>
          <button className="ws-btn danger" onClick={async () => {
            if (!confirm(`Delete “${c.name}” and all its events? This can't be undone.`)) return;
            try {
              await api(`/calendar/calendars?id=${c.id}`, { method: "DELETE" });
              flash("Calendar deleted");
              onChanged();
              onGone();
            } catch (e) {
              flash((e as Error).message);
            }
          }}><Trash2 size={14} /> Delete calendar</button>
        </>
      )}
    </div>
  );
}

function AddCalendar({ cals, people, meId, canTeam, flash, onChanged, open }: { cals: Cal[]; people: Person[]; meId: string; canTeam: boolean; flash: (m: string) => void; onChanged: () => void; open: (id: string) => void }) {
  const [name, setName] = useState("");
  const [team, setTeam] = useState(false);
  const [who, setWho] = useState("");
  const [url, setUrl] = useState("");
  const [country, setCountry] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const [target, setTarget] = useState(cals.find((c) => c.primary && c.mine)?.id ?? "");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    api<{ countries: string[] }>("/calendar/ics?holidays=1").then((r) => setCountries(r.countries)).catch(() => {});
  }, []);
  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    try {
      await f();
      onChanged();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const added = new Set(cals.filter((c) => c.other).map((c) => c.ownerId));
  return (
    <div className="cs-sec">
      <h4><CalendarPlus size={15} /> Create new calendar</h4>
      <div className="ws-row">
        <input className="ws-input" style={{ flex: 1 }} placeholder="Name, e.g. Side project" value={name} onChange={(e) => setName(e.target.value)} aria-label="New calendar name" />
        {canTeam && <label className="ws-row" style={{ gap: 6 }}><input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} /> Team calendar</label>}
        <button className="ws-btn primary" disabled={!name.trim() || busy === "new"} onClick={() => run("new", async () => {
          const r = await api<{ calendar: Cal }>("/calendar/calendars", { body: { name: name.trim(), kind: team ? "team" : "personal", color: COLORS[(cals.length + 2) % COLORS.length] } });
          setName("");
          flash("Calendar created");
          open(r.calendar.id);
        })}>Create</button>
      </div>
      <p className="ws-muted cs-note">{team ? "Everyone in the workspace sees a team calendar." : "Only you see it, unless you share it."}</p>

      <h4>Add a colleague's calendar</h4>
      <div className="ws-row">
        <select className="ws-select" style={{ flex: 1 }} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Colleague">
          <option value="">Choose someone…</option>
          {people.filter((p) => p.id !== meId && !added.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
        </select>
        <button className="ws-btn" disabled={!who || busy === "who"} onClick={() => run("who", async () => {
          const r = await api<{ access: string }>("/calendar/others", { body: { userId: who } });
          flash(r.access === "busy" ? "Added. You'll see when they're busy; ask them to share for details." : "Added");
          setWho("");
        })}>Add</button>
      </div>

      <h4>From URL</h4>
      <div className="ws-row">
        <input className="ws-input" style={{ flex: 1 }} placeholder="https://… or webcal://… (.ics)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Calendar URL" />
        <button className="ws-btn" disabled={!url.trim() || busy === "url"} onClick={() => run("url", async () => {
          await api("/calendar/ics", { body: { url: url.trim() } });
          setUrl("");
          flash("Subscribed. It refreshes every 30 minutes.");
        })}>{busy === "url" ? "Adding…" : "Add calendar"}</button>
      </div>

      <h4>Holidays</h4>
      <div className="ws-row">
        <select className="ws-select" style={{ flex: 1 }} value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country">
          <option value="">Choose a country…</option>
          {countries.map((c) => <option key={c} value={c}>Holidays in {c}</option>)}
        </select>
        <button className="ws-btn" disabled={!country || busy === "hol"} onClick={() => run("hol", async () => {
          await api("/calendar/ics", { body: { country } });
          setCountry("");
          flash("Holiday calendar added");
        })}>{busy === "hol" ? "Adding…" : "Add"}</button>
      </div>

      <h4><Upload size={15} /> Import</h4>
      <p className="ws-muted cs-note">Bring events in from an .ics file (exported from Google Calendar, Outlook or Apple Calendar). Importing the same file again updates events instead of doubling them.</p>
      <div className="ws-row">
        <select className="ws-select" style={{ flex: 1 }} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Import into">
          {cals.filter((c) => c.kind !== "subscribed" && ["owner", "manage", "edit"].includes(c.access ?? "owner")).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="ws-btn" style={{ cursor: "pointer" }}>
          {busy === "imp" ? "Importing…" : "Choose .ics file"}
          <input type="file" accept=".ics,text/calendar" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            void run("imp", async () => {
              const fd = new FormData();
              fd.append("file", f);
              fd.append("calendarId", target);
              const r = await fetch("/workspace/api/calendar/ics", { method: "POST", body: fd });
              const j = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(j.error ?? "Import failed");
              flash(`Imported ${j.created ?? 0} new and updated ${j.updated ?? 0} events`);
            });
          }} />
        </label>
      </div>
    </div>
  );
}

const blankBooking = (tz: string): Partial<Booking> => ({
  title: "", description: "", minutes: 30, hours: { "1": [{ start: "09:00", end: "17:00" }], "2": [{ start: "09:00", end: "17:00" }], "3": [{ start: "09:00", end: "17:00" }], "4": [{ start: "09:00", end: "17:00" }], "5": [{ start: "09:00", end: "17:00" }] },
  tz, bufferMin: 0, noticeHours: 4, maxDays: 60, maxPerDay: null, locationKind: "meet", location: "", questions: [], color: "#4f46e5", enabled: true,
});

function Bookings({ flash, cals, tz }: { flash: (m: string) => void; cals: Cal[]; tz: string }) {
  const [pages, setPages] = useState<Booking[] | null>(null);
  const [edit, setEdit] = useState<Partial<Booking> | null>(null);
  const load = () => api<{ pages: Booking[] }>("/calendar/bookings").then((r) => setPages(r.pages)).catch((e) => flash(e.message));
  useEffect(() => {
    void load();
  }, []);
  const save = async () => {
    if (!edit) return;
    try {
      await api("/calendar/bookings", { body: edit });
      setEdit(null);
      flash("Booking page saved");
      void load();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  if (edit) {
    const set = <K extends keyof Booking>(k: K, v: Booking[K]) => setEdit({ ...edit, [k]: v });
    const days = Object.keys(edit.hours ?? {}).map(Number);
    const first = Object.values(edit.hours ?? {})[0]?.[0] ?? { start: "09:00", end: "17:00" };
    const setHours = (ds: number[], r: Range) => set("hours", Object.fromEntries(ds.map((d) => [String(d), [r]])));
    return (
      <div className="cs-sec">
        <h4>{edit.id ? "Edit booking page" : "New booking page"}</h4>
        <div className="ws-field"><label className="ws-label" htmlFor="bk-t">Title</label><input id="bk-t" className="ws-input" placeholder="30-minute intro call" value={edit.title} onChange={(e) => set("title", e.target.value)} /></div>
        <div className="ws-field"><label className="ws-label" htmlFor="bk-d">Description</label><textarea id="bk-d" className="ws-textarea" style={{ minHeight: 56 }} value={edit.description} onChange={(e) => set("description", e.target.value)} /></div>
        <div className="cs-grid">
          <label className="ws-label" htmlFor="bk-m">Length</label>
          <select id="bk-m" className="ws-select" value={edit.minutes} onChange={(e) => set("minutes", Number(e.target.value))}>{[15, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select>
          <label className="ws-label" htmlFor="bk-b">Break between bookings</label>
          <select id="bk-b" className="ws-select" value={edit.bufferMin} onChange={(e) => set("bufferMin", Number(e.target.value))}>{[0, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select>
          <label className="ws-label" htmlFor="bk-n">Book at least</label>
          <select id="bk-n" className="ws-select" value={edit.noticeHours} onChange={(e) => set("noticeHours", Number(e.target.value))}>{[0, 1, 2, 4, 12, 24, 48].map((m) => <option key={m} value={m}>{m} hours ahead</option>)}</select>
          <label className="ws-label" htmlFor="bk-x">Book at most</label>
          <select id="bk-x" className="ws-select" value={edit.maxDays} onChange={(e) => set("maxDays", Number(e.target.value))}>{[7, 14, 30, 60, 90].map((m) => <option key={m} value={m}>{m} days ahead</option>)}</select>
          <label className="ws-label" htmlFor="bk-p">Bookings per day</label>
          <select id="bk-p" className="ws-select" value={edit.maxPerDay ?? 0} onChange={(e) => set("maxPerDay", Number(e.target.value) || null)}><option value={0}>No limit</option>{[1, 2, 3, 4, 6, 8].map((m) => <option key={m} value={m}>{m}</option>)}</select>
          <label className="ws-label" htmlFor="bk-l">Where</label>
          <select id="bk-l" className="ws-select" value={edit.locationKind} onChange={(e) => set("locationKind", e.target.value)}>
            <option value="meet">IOTx Meet video call</option><option value="phone">Phone call</option><option value="place">In person</option><option value="none">Decide later</option>
          </select>
        </div>
        {edit.locationKind === "place" && <div className="ws-field" style={{ marginTop: 8 }}><input className="ws-input" placeholder="Address" value={edit.location} onChange={(e) => set("location", e.target.value)} aria-label="Address" /></div>}
        <h4><Clock size={14} /> Available</h4>
        <div className="daypick">
          {weekdayOrder().map((d) => (
            <button type="button" key={d} aria-pressed={days.includes(d)} aria-label={DAY_NAMES[d]} onClick={() => setHours(days.includes(d) ? days.filter((x) => x !== d) : [...days, d], first)}>{DAY_NAMES[d][0]}</button>
          ))}
        </div>
        <div className="ws-row" style={{ marginTop: 6 }}>
          <input type="time" className="ws-input" style={{ width: 120 }} value={first.start} onChange={(e) => setHours(days, { ...first, start: e.target.value })} aria-label="Available from" />
          <span className="ws-muted">–</span>
          <input type="time" className="ws-input" style={{ width: 120 }} value={first.end} onChange={(e) => setHours(days, { ...first, end: e.target.value })} aria-label="Available until" />
          <span className="ws-muted">{edit.tz?.replace(/_/g, " ")}</span>
        </div>
        <p className="ws-muted cs-note">Times you're already busy on {cals.find((c) => c.primary && c.mine)?.name ?? "your calendar"} are never offered.</p>
        <h4>Questions for the booker</h4>
        {(edit.questions ?? []).map((q, i) => (
          <div key={i} className="ws-row" style={{ marginBottom: 4 }}>
            <input className="ws-input" style={{ flex: 1 }} value={q.label} aria-label={`Question ${i + 1}`} onChange={(e) => set("questions", (edit.questions ?? []).map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <label className="ws-row" style={{ gap: 4 }}><input type="checkbox" checked={q.required} onChange={(e) => set("questions", (edit.questions ?? []).map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> Required</label>
            <button className="ix-iconbtn" aria-label="Remove question" onClick={() => set("questions", (edit.questions ?? []).filter((_, j) => j !== i))}><X size={13} /></button>
          </div>
        ))}
        {(edit.questions?.length ?? 0) < 5 && <button className="ws-link" onClick={() => set("questions", [...(edit.questions ?? []), { id: "", label: "", required: false }])}>+ Add a question</button>}
        <div className="ws-row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
          <button className="ws-btn" onClick={() => setEdit(null)}>Cancel</button>
          <button className="ws-btn primary" onClick={save}>Save</button>
        </div>
      </div>
    );
  }
  return (
    <div className="cs-sec">
      <h4>Booking pages</h4>
      <p className="ws-muted cs-note">Share a link so anyone (with or without an account) can book time with you. Free slots come from your calendar; each booking lands on it with an invite email.</p>
      {pages === null && <div className="ai-skel" style={{ height: 60 }} />}
      {pages?.length === 0 && <p className="ws-muted">No booking pages yet.</p>}
      {pages?.map((p) => (
        <div key={p.id} className="cs-booking">
          <span className="ws-swatch" style={{ background: p.color }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>{p.title}</b> <small className="ws-muted">· {p.minutes} min{p.enabled ? "" : " · paused"}</small>
            <div className="ws-muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.url}</div>
          </div>
          <button className="ix-iconbtn" aria-label="Copy link" title="Copy link" onClick={() => navigator.clipboard?.writeText(p.url).then(() => flash("Link copied"), () => flash(p.url))}><Copy size={14} /></button>
          <a className="ix-iconbtn" aria-label="Open booking page" title="Open" href={`/workspace/book/${p.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
          <button className="ws-btn sm" onClick={() => setEdit(p)}>Edit</button>
          <button className="ix-iconbtn" aria-label="Delete booking page" onClick={async () => {
            if (!confirm(`Delete “${p.title}”? Its link stops working.`)) return;
            await api(`/calendar/bookings?id=${p.id}`, { method: "DELETE" }).catch((e) => flash(e.message));
            void load();
          }}><Trash2 size={14} /></button>
        </div>
      ))}
      <button className="ws-btn primary" style={{ marginTop: 10 }} onClick={() => setEdit(blankBooking(tz))}><Plus size={14} /> New booking page</button>
    </div>
  );
}

const MONTHS = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString([], { month: "long" }));

/** Profile: my birthday (month and day, optional year) and who sees it on their Birthdays calendar. */
function Birthday({ s, save }: { s: Settings; save: (p: Partial<Settings>) => void }) {
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(s.birthday ?? "");
  const [month, setMonth] = useState(m ? Number(m[2]) : 0);
  const [day, setDay] = useState(m ? Number(m[3]) : 0);
  const [year, setYear] = useState(m?.[1] ?? "");
  const store = (mo: number, d: number, y: string) => {
    if (!mo || !d) return;
    const pad = (n: number) => String(n).padStart(2, "0");
    save({ birthday: /^\d{4}$/.test(y) ? `${y}-${pad(mo)}-${pad(d)}` : `--${pad(mo)}-${pad(d)}` });
  };
  const max = month ? new Date(2000, month, 0).getDate() : 31;
  return (
    <>
      <h4><Cake size={15} /> Birthday</h4>
      <p className="ws-muted cs-note">Shown on the Birthdays calendar. People in the workspace see only the day, never the year.</p>
      <div className="ws-row" style={{ flexWrap: "wrap" }}>
        <select className="ws-select" style={{ width: 140 }} aria-label="Birthday month" value={month} onChange={(e) => { const v = Number(e.target.value); setMonth(v); store(v, Math.min(day, new Date(2000, v, 0).getDate()), year); }}>
          <option value={0}>Month…</option>
          {MONTHS.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
        </select>
        <select className="ws-select" style={{ width: 90 }} aria-label="Birthday day" value={day} onChange={(e) => { const v = Number(e.target.value); setDay(v); store(month, v, year); }}>
          <option value={0}>Day…</option>
          {Array.from({ length: max }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
        </select>
        <input className="ws-input" style={{ width: 100 }} inputMode="numeric" placeholder="Year (optional)" aria-label="Birthday year (optional)" value={year} maxLength={4}
          onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} onBlur={() => store(month, day, year)} />
        <select className="ws-select" style={{ width: 210 }} aria-label="Who sees my birthday" value={s.birthdayShare ?? "private"} onChange={(e) => save({ birthdayShare: e.target.value })}>
          <option value="private">Only me</option>
          <option value="workspace">Everyone in the workspace</option>
        </select>
        {s.birthday && <button className="ws-link" onClick={() => { setMonth(0); setDay(0); setYear(""); save({ birthday: null }); }}>Remove</button>}
      </div>
    </>
  );
}

/** Make available to public: free/busy only or all details, the public page and an embed code. */
function PublicAccess({ c, patch, copy }: { c: Cal; patch: (b: Record<string, unknown>, ok?: string) => Promise<void>; copy: (t: string) => void }) {
  const [title, setTitle] = useState(c.name);
  const [showTitle, setShowTitle] = useState(true);
  const [view, setView] = useState<"month" | "week" | "agenda">("month");
  const [color, setColor] = useState(c.color);
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [w, setW] = useState(800);
  const [h, setH] = useState(600);
  const all = useMemo(() => zones(), []);
  const mode = c.publicMode ?? "none";
  const q = new URLSearchParams({ view, tz, color: color.replace("#", ""), ...(showTitle ? { title } : { title: "", notitle: "1" }) });
  const src = c.publicUrl ? `${c.publicUrl}?${q}` : "";
  const code = src ? `<iframe src="${src.replace(/&/g, "&amp;")}" style="border:0" width="${w}" height="${h}" frameborder="0" scrolling="no" title="${title.replace(/"/g, "&quot;")}"></iframe>` : "";
  return (
    <>
      <h4><Globe size={15} /> Access for anyone</h4>
      <div className="ws-field">
        <label className="ws-label" htmlFor="cs-pub">Make available to public</label>
        <select id="cs-pub" className="ws-select" value={mode} onChange={(e) => patch({ publicMode: e.target.value }, e.target.value === "none" ? "No longer public; the old link stopped working." : "Public link ready")}>
          <option value="none">Not public</option>
          <option value="busy">See only free/busy (hide details)</option>
          <option value="full">See all event details</option>
        </select>
        <p className="ws-muted cs-note">
          {mode === "none" ? "Anyone with the link could see this calendar without signing in." : mode === "busy" ? "Anyone with the link sees when you're busy, nothing more." : "Anyone with the link sees titles, places and descriptions. Private events still show only as busy; guests and video links are never shown."}
        </p>
      </div>
      {c.publicUrl && (
        <>
          <div className="ws-field">
            <label className="ws-label">Public address</label>
            <div className="ws-row">
              <input className="ws-input" readOnly value={c.publicUrl} style={{ flex: 1, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }} aria-label="Public address" onFocus={(e) => e.target.select()} />
              <button className="ix-iconbtn" aria-label="Copy public address" onClick={() => copy(c.publicUrl!)}><Copy size={14} /></button>
              <a className="ix-iconbtn" aria-label="Open public page" title="Open" href={src} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
            </div>
            <button className="ws-link" style={{ fontSize: 12 }} onClick={() => patch({ publicReset: true }, "A new public address was made; the old one stopped working.")}><RefreshCw size={12} /> Make a new address</button>
          </div>
          <h4><Code2 size={15} /> Embed code</h4>
          <div className="cs-embed">
            <label className="ws-label" htmlFor="emb-title">Title</label>
            <div className="ws-row">
              <input id="emb-title" className="ws-input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!showTitle} />
              <label className="ws-row" style={{ gap: 4, whiteSpace: "nowrap" }}><input type="checkbox" checked={showTitle} onChange={(e) => setShowTitle(e.target.checked)} /> Show</label>
            </div>
            <label className="ws-label" htmlFor="emb-view">View</label>
            <select id="emb-view" className="ws-select" value={view} onChange={(e) => setView(e.target.value as typeof view)}>
              <option value="month">Month</option><option value="week">Week</option><option value="agenda">Schedule</option>
            </select>
            <label className="ws-label">Colour</label>
            <div className="colors">{COLORS.map((x) => <button type="button" key={x} aria-pressed={color === x} aria-label={`Embed colour ${x}`} style={{ background: x }} onClick={() => setColor(x)} />)}</div>
            <label className="ws-label" htmlFor="emb-tz">Time zone</label>
            <select id="emb-tz" className="ws-select" value={tz} onChange={(e) => setTz(e.target.value)}>
              {[...new Set([tz, ...all])].map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
            <label className="ws-label">Size</label>
            <div className="ws-row">
              <input className="ws-input" type="number" min={240} max={2000} value={w} onChange={(e) => setW(Number(e.target.value) || 800)} aria-label="Width" style={{ width: 90 }} />
              <span className="ws-muted">×</span>
              <input className="ws-input" type="number" min={240} max={2000} value={h} onChange={(e) => setH(Number(e.target.value) || 600)} aria-label="Height" style={{ width: 90 }} />
            </div>
          </div>
          <div className="ws-row" style={{ alignItems: "flex-start" }}>
            <textarea className="ws-textarea cs-code" readOnly value={code} aria-label="Embed code" onFocus={(e) => e.target.select()} />
            <button className="ix-iconbtn" aria-label="Copy embed code" onClick={() => copy(code)}><Copy size={14} /></button>
          </div>
        </>
      )}
    </>
  );
}

type GCal = { id: string; name: string; primary: boolean; color: string | null; accessRole: string; link: { calendarId: string; readOnly: boolean; lastSyncAt: string | null; error: string | null } | null };

/** Google Calendar: the main Google calendar syncs with My calendar; pick more to sync, each into a calendar here. */
function GoogleCalendars({ cals, flash, onChanged }: { cals: Cal[]; flash: (m: string) => void; onChanged: () => void }) {
  const [list, setList] = useState<GCal[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [bday, setBday] = useState<{ at: string | null; error: string | null }>({ at: null, error: null });
  const load = () => {
    api<{ calendars: GCal[] }>("/calendar/google?calendars=1").then((r) => setList(r.calendars)).catch((e) => setErr((e as Error).message));
    api<{ birthdaysAt: string | null; birthdaysError: string | null }>("/calendar/google").then((r) => setBday({ at: r.birthdaysAt, error: r.birthdaysError })).catch(() => {});
  };
  useEffect(load, []);
  const mine = cals.filter((c) => c.kind === "personal" && c.mine && !c.primary);
  const linked = new Set((list ?? []).map((g) => g.link?.calendarId).filter(Boolean));
  const act = async (key: string, body: Record<string, unknown>, ok: string) => {
    setBusy(key);
    try {
      await api("/calendar/google", { body });
      flash(ok);
      onChanged();
      load();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="cs-sec">
      <h4>Google calendars to sync</h4>
      <p className="ws-muted cs-note">Your main Google calendar always syncs with My calendar. Choose more below: each one syncs both ways (events and your replies) with a calendar here.</p>
      {err && <p className="ws-error">{err}</p>}
      {!list && !err && <div className="ai-skel" style={{ height: 60 }} />}
      {list?.map((g) => (
        <div key={g.id} className="cs-gcal">
          <span className="ws-swatch" style={{ background: g.color ?? "#64748b" }} />
          <span className="n">{g.name}{g.primary ? <small className="ws-muted"> · main, syncs with My calendar</small> : !["owner", "writer"].includes(g.accessRole) ? <small className="ws-muted"> · view only in Google</small> : null}
            {g.link?.error && <small className="ws-error" style={{ display: "block" }}>{g.link.error}</small>}
          </span>
          {!g.primary && (
            <select className="ws-select" style={{ width: 210 }} aria-label={`Sync ${g.name} into`} disabled={busy === g.id} value={g.link?.calendarId ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return void act(g.id, { action: "unlink", googleCalId: g.id }, `Stopped syncing ${g.name}`);
                void act(g.id, { action: "link", googleCalId: g.id, calendarId: v }, `${g.name} is syncing`);
              }}>
              <option value="">Don't sync</option>
              <option value="new">Sync into a new calendar</option>
              {mine.filter((c) => !linked.has(c.id) || g.link?.calendarId === c.id).map((c) => <option key={c.id} value={c.id}>Sync into {c.name}</option>)}
            </select>
          )}
        </div>
      ))}
      <h4><Cake size={15} /> Contacts' birthdays</h4>
      <p className="ws-muted cs-note">Birthdays saved with your Google contacts appear on the Birthdays calendar, read once a day.{bday.at ? ` Last read ${new Date(bday.at).toLocaleString()}.` : ""}</p>
      {bday.error && <p className="ws-error">{bday.error}</p>}
      <button className="ws-btn sm" disabled={busy === "bday"} onClick={() => act("bday", { action: "birthdays" }, "Birthdays read from Google contacts")}>{busy === "bday" ? "Reading…" : "Read birthdays now"}</button>
    </div>
  );
}
