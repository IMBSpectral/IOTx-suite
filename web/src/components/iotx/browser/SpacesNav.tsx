"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { TabLink, openInSuite } from "../tabs";

type Item = { id: string; kind: string; ref: string; title: string };
type Space = { id: string; kind: "dashboard" | "folder"; name: string; parentId: string | null; items: Item[]; modules: number; mine: boolean };
type Data = { spaces: Space[]; can: { dashboard: boolean; folder: boolean; add: boolean; share: boolean; manage: boolean } };

/** Tell every sidebar (and open dashboard pages) that dashboards or folders changed. */
export const spacesChanged = () => {
  window.dispatchEvent(new Event("iotx:spaces"));
  try {
    window.parent?.dispatchEvent(new Event("iotx:spaces"));
  } catch {}
};

const OPEN_KEY = "iotx-open-folders";

/**
 * The sidebar's "Dashboards" and "Folders": what this person may see (their
 * roles in Admin → Roles, plus what was shared with them), with "+" to create
 * one when their role allows it. Each opens in a suite tab at /spaces/<id>.
 */
export default function SpacesNav({ activeUrl, onNavigate }: { activeUrl?: string; onNavigate: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [adding, setAdding] = useState<null | { kind: "dashboard" | "folder" }>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  });

  const load = useCallback(async () => {
    const r = await fetch("/api/spaces").catch(() => null);
    if (r?.ok) setData(await r.json());
  }, []);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener("iotx:spaces", on);
    window.addEventListener("focus", on);
    return () => {
      window.removeEventListener("iotx:spaces", on);
      window.removeEventListener("focus", on);
    };
  }, [load]);

  const toggle = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...n]));
      } catch {}
      return n;
    });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!adding || !name.trim()) return setAdding(null);
    const r = await fetch("/api/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", kind: adding.kind, name }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "Couldn't create it.");
    setAdding(null);
    setName("");
    setError(null);
    spacesChanged();
    // Open the new one so it can be filled straight away.
    openInSuite(`/spaces/${d.space.id}`);
  }

  if (!data) return null;
  const { spaces, can } = data;
  const dashboards = spaces.filter((s) => s.kind === "dashboard" && !s.parentId);
  const folders = spaces.filter((s) => s.kind === "folder" && !s.parentId);
  const childrenOf = (id: string) => spaces.filter((s) => s.parentId === id);
  const isOn = (href: string) => !!activeUrl && (activeUrl === href || activeUrl.startsWith(href + "?"));
  if (!dashboards.length && !folders.length && !can.dashboard && !can.folder) return null;

  const form = (kind: "dashboard" | "folder") =>
    adding?.kind === kind && (
      <form onSubmit={create} className="ix-space-new">
        <input
          autoFocus
          className="ix-input"
          placeholder={kind === "dashboard" ? "Dashboard name" : "Folder name"}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setAdding(null)}
          onBlur={() => !name.trim() && setAdding(null)}
          aria-label={kind === "dashboard" ? "New dashboard name" : "New folder name"}
        />
        {error && <div className="ix-error" style={{ fontSize: 12 }}>{error}</div>}
      </form>
    );

  const head = (label: string, kind: "dashboard" | "folder", allowed: boolean) => (
    <div className="ix-sect ix-sect-act">
      <span>{label}</span>
      {allowed && (
        <button
          type="button"
          className="ix-sect-add"
          title={kind === "dashboard" ? "New dashboard" : "Create folder"}
          aria-label={kind === "dashboard" ? "New dashboard" : "Create folder"}
          onClick={() => {
            setError(null);
            setName("");
            setAdding({ kind });
          }}
        >
          <Icon name="add" size={14} />
        </button>
      )}
    </div>
  );

  const row = (s: Space, depth: number): React.ReactNode => {
    const href = `/spaces/${s.id}`;
    const kids = s.kind === "folder" ? childrenOf(s.id) : [];
    const open = openIds.has(s.id);
    const hasInside = kids.length > 0 || s.items.length > 0;
    return (
      <div key={s.id}>
        <div className="ix-space-row" style={{ paddingLeft: depth * 14 }}>
          {s.kind === "folder" ? (
            <button type="button" className={`ix-space-caret ${open ? "open" : ""}`} onClick={() => toggle(s.id)} aria-label={open ? `Collapse ${s.name}` : `Expand ${s.name}`} aria-expanded={open} style={hasInside ? undefined : { visibility: "hidden" }}>
              <Icon name="chevron" size={12} />
            </button>
          ) : null}
          <TabLink href={href} className={`ix-nav ${isOn(href) ? "on" : ""}`} title={s.name} onClick={onNavigate} data-space={s.id}>
            <span className="ico">
              <Icon name={s.kind === "dashboard" ? "dashboard" : "folder"} size={16} />
            </span>
            <span className="label">{s.name}</span>
          </TabLink>
        </div>
        {s.kind === "folder" && open && (
          <div className="ix-space-kids">
            {kids.map((k) => row(k, depth + 1))}
            {s.items.map((i) => {
              const ih = i.kind === "link" && i.ref.startsWith("/") ? i.ref : `${href}?item=${i.id}`;
              const external = i.kind === "link" && !i.ref.startsWith("/");
              return (
                <div key={i.id} className="ix-space-row" style={{ paddingLeft: (depth + 1) * 14 + 18 }}>
                  {external ? (
                    <a href={i.ref} target="_blank" rel="noopener noreferrer" className="ix-nav" title={i.ref}>
                      <span className="ico">
                        <Icon name="link" size={15} />
                      </span>
                      <span className="label">{i.title}</span>
                    </a>
                  ) : (
                    <TabLink href={ih} className={`ix-nav ${isOn(ih) ? "on" : ""}`} title={i.title} onClick={onNavigate}>
                      <span className="ico">
                        <Icon name={i.kind === "link" ? "link" : "builder"} size={15} />
                      </span>
                      <span className="label">{i.title}</span>
                    </TabLink>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {(dashboards.length > 0 || can.dashboard) && (
        <>
          {head("Dashboards", "dashboard", can.dashboard)}
          <div className="ix-navlist" aria-label="Dashboards">
            {form("dashboard")}
            {dashboards.map((s) => row(s, 0))}
            {!dashboards.length && !adding && can.dashboard && (
              <button type="button" className="ix-nav ix-space-empty" onClick={() => setAdding({ kind: "dashboard" })}>
                <span className="ico">
                  <Icon name="add" size={15} />
                </span>
                <span className="label">New dashboard</span>
              </button>
            )}
          </div>
        </>
      )}
      {(folders.length > 0 || can.folder) && (
        <>
          {head("Folders", "folder", can.folder)}
          <div className="ix-navlist" aria-label="Folders">
            {form("folder")}
            {folders.map((s) => row(s, 0))}
            {!folders.length && !adding && can.folder && (
              <button type="button" className="ix-nav ix-space-empty" onClick={() => setAdding({ kind: "folder" })}>
                <span className="ico">
                  <Icon name="add" size={15} />
                </span>
                <span className="label">Create folder</span>
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
