"use client";

import { useEffect, useRef, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { usePerms } from "../PermsProvider";
import { Icon } from "../icons";
import { GO_TO, grouped, looksLikeQuestion, useEverything, type Hit } from "../search";
import { tabApp } from "../tabs";
import type { Tab } from "./store";

type Row = { key: string; kind: "go" | "ask" | "hit"; label: string; sub?: string; href: string; icon: string; color: string; group?: string };

/** Focus the address bar from anywhere (Ctrl+L, Alt+D, Ctrl+K, a new tab). */
export const focusOmnibox = () => window.dispatchEvent(new Event("iotx:omnibox"));

/**
 * The address bar. At rest it shows where the tab is ("Sheets › Q3 Sales");
 * focused, the tab's path, which can be edited. Typing searches everything
 * (the start page's sources plus the old palette's "Go to" list) and offers
 * "Ask AI". Enter opens the pick in this tab, Alt+Enter in a new one.
 */
export default function Omnibox({ tab, onOpen }: { tab: Tab | undefined; onOpen: (href: string, newTab: boolean) => void }) {
  const brand = useBrand();
  const perms = usePerms();
  const canAsk = perms.can("home.ask");
  const input = useRef<HTMLInputElement>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const url = tab?.url ?? "/home";
  const app = tabApp(url);
  const typed = edit !== null && edit !== url ? edit.trim() : "";
  const { hits, busy } = useEverything(typed.startsWith("/") ? "" : typed);

  useEffect(() => {
    // After the frame has drawn the tab that asked (a new tab focuses the bar at once).
    const go = () =>
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    window.addEventListener("iotx:omnibox", go);
    return () => window.removeEventListener("iotx:omnibox", go);
  }, []);

  const f = typed.toLowerCase();
  const rows: Row[] = [];
  if (typed.startsWith("/")) rows.push({ key: "go", kind: "go", label: typed, sub: "Open", href: typed, icon: "globe", color: "#6a6e8a" });
  else if (typed && canAsk) rows.push({ key: "ask", kind: "ask", label: typed, sub: "AI Chat", href: `/home/chat?prompt=${encodeURIComponent(typed)}&send=1`, icon: "chat", color: "linear-gradient(135deg, var(--accent), var(--accent-2))" });
  const results: Row[] = [
    ...hits.map((h: Hit) => ({ key: h.key, kind: "hit" as const, label: h.label, sub: h.sub, href: h.href, icon: h.icon, color: h.color, group: h.group })),
    ...(f ? GO_TO.filter((a) => a.label.toLowerCase().includes(f)).map((a) => ({ key: `go${a.href}`, kind: "hit" as const, label: a.label, sub: a.href, href: a.href, icon: tabApp(a.href).icon, color: tabApp(a.href).color, group: "Go to" })) : []),
  ];
  rows.push(...results);
  const first = rows[0]?.kind === "ask" && !looksLikeQuestion(typed) && results.length ? 1 : 0;
  const active = Math.min(pick ?? first, rows.length - 1);

  const done = () => {
    setEdit(null);
    setPick(null);
    input.current?.blur();
  };
  const choose = (i: number, newTab: boolean) => {
    const r = rows[i];
    if (!r) return;
    done();
    onOpen(r.href, newTab);
  };

  let n = rows[0] && rows[0].kind !== "hit" ? 0 : -1;
  const open = edit !== null && !!typed;
  return (
    <div className="ixb-omni" data-open={open || undefined}>
      <span className="ixb-omni-ico" aria-hidden>
        <Icon name={edit !== null ? "search" : app.icon} size={14} />
      </span>
      <input
        ref={input}
        className="ixb-omni-input"
        value={edit ?? ""}
        placeholder={edit === null ? "" : canAsk ? `Search ${brand.shortName}, ask AI, or type a path` : `Search ${brand.shortName} or type a path`}
        aria-label="Address and search bar"
        role="combobox"
        aria-expanded={open}
        aria-controls="ixb-omni-results"
        autoComplete="off"
        spellCheck={false}
        onFocus={(e) => {
          // The New Tab page's bar starts empty, like Chrome's.
          setEdit(url === "/home" ? "" : url);
          setPick(null);
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={() => {
          setEdit(null);
          setPick(null);
        }}
        onChange={(e) => {
          setEdit(e.target.value);
          setPick(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!typed) return done();
            choose(active, e.altKey || e.ctrlKey || e.metaKey);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setPick(Math.min(active + 1, rows.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setPick(Math.max(active - 1, 0));
          } else if (e.key === "Escape") {
            e.preventDefault();
            done();
          }
        }}
      />
      {edit === null && (
        // At rest: a friendly path over the input (clicking it focuses the input below).
        <span className="ixb-crumb" aria-hidden onMouseDown={(e) => (e.preventDefault(), input.current?.focus())}>
          <b>{app.name}</b>
          {tab && tab.title && tab.title !== app.name && (
            <>
              <i>›</i>
              <span>{tab.title}</span>
            </>
          )}
        </span>
      )}
      {busy && open && <span className="mail-spin ixb-omni-busy" aria-label="Searching" />}
      {open && (
        <div className="ixb-omni-results" id="ixb-omni-results" role="listbox" aria-label="Suggestions" onMouseDown={(e) => e.preventDefault()}>
          {rows[0] && rows[0].kind !== "hit" && (
            <button className="ix-rrow" role="option" aria-selected={active === 0} data-active={active === 0 || undefined} onMouseEnter={() => setPick(0)} onClick={(e) => choose(0, e.ctrlKey || e.metaKey || e.altKey)}>
              <span className="ix-rico" style={{ background: rows[0].color }}>
                <Icon name={rows[0].icon} size={14} />
              </span>
              <span className="ix-rmain">
                {rows[0].kind === "ask" ? "Ask AI: " : "Go to "}
                <b>{rows[0].label}</b>
              </span>
              <small>{rows[0].sub} · Enter</small>
            </button>
          )}
          {grouped(results.map((r) => ({ ...r, app: true, group: r.group ?? "" }))).map((g) => (
            <div key={g.group} role="group" aria-label={g.group}>
              <div className="ix-rsect">{g.group}</div>
              {g.hits.map((h) => {
                const i = ++n;
                return (
                  <button key={h.key} className="ix-rrow" role="option" aria-selected={i === active} data-active={i === active || undefined} onMouseEnter={() => setPick(i)} onClick={(e) => choose(i, e.ctrlKey || e.metaKey || e.altKey)} onAuxClick={(e) => e.button === 1 && choose(i, true)}>
                    <span className="ix-rico" style={{ background: h.color }}>
                      <Icon name={h.icon} size={14} />
                    </span>
                    <span className="ix-rmain">{h.label}</span>
                    {h.sub && <small>{h.sub}</small>}
                  </button>
                );
              })}
            </div>
          ))}
          {!busy && !results.length && !typed.startsWith("/") && <p className="ix-rempty">Nothing found for “{typed}”.{canAsk ? " Press Enter to ask the AI." : ""}</p>}
          <p className="ixb-omni-tip">Enter opens here · Alt+Enter opens a new tab</p>
        </div>
      )}
    </div>
  );
}
