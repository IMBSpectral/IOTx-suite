"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MANIFESTS, SIDEBAR_APPS } from "@/lib/iotx/manifests";
import { usePerms } from "./PermsProvider";
import { useBrand } from "@/components/BrandProvider";
import { AppIcon, Icon, IxMark } from "./icons";
import { appHref, useChatUnread } from "./Launcher";
import { googleConnected, grouped, looksLikeQuestion, useEverything, type Hit } from "./search";
import { TabLink, openInSuite } from "./tabs";
import { PENDING_ASK } from "./ai";

/** Something opened lately, for the start page's "Recent" row. */
export type Recent = { key: string; label: string; sub: string; href: string; icon: string; color: string; at: string | null };

const noop = () => () => {};
const color = (id: string) => MANIFESTS.find((m) => m.id === id)?.color ?? "#6a6e8a";
const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
};

/** The New Tab page's shortcuts: the apps opened most (counted by the frame), else the sidebar's first apps. */
const subscribeVisits = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};
function useShortcuts(userKey: string, opens: (id: string) => boolean) {
  const raw = useSyncExternalStore(
    subscribeVisits,
    () => {
      try {
        return localStorage.getItem(`iotx-visits:${userKey}`) ?? "{}";
      } catch {
        return "{}";
      }
    },
    () => "{}",
  );
  let visits: Record<string, number> = {};
  try {
    visits = JSON.parse(raw);
  } catch {}
  const ids = [...new Set([...Object.keys(visits).sort((a, b) => visits[b] - visits[a]), ...SIDEBAR_APPS])];
  return ids
    .map((id) => MANIFESTS.find((m) => m.id === id))
    .filter((m): m is (typeof MANIFESTS)[number] => !!m && m.id !== "home" && m.status === "live" && opens(m.id))
    .slice(0, 8);
}

/**
 * The New Tab page, like Chrome's: the brand and one big box that searches
 * everything (apps, files, projects, chats, knowledge, people, events, tasks,
 * messages) and can ask the AI; below it a few shortcuts (the apps opened
 * most) and what was opened lately. The apps themselves live in the
 * sidebar. Results open in this tab (Alt+Enter, Ctrl/middle click: a new one).
 */
export default function StartPage({ initialQuery, recent: serverRecent, userKey }: { initialQuery?: string; recent: Recent[]; userKey: string }) {
  const perms = usePerms();
  const brand = useBrand();
  const canAsk = perms.can("home.ask");
  const [q, setQ] = useState(initialQuery ?? "");
  const [focus, setFocus] = useState(!!initialQuery);
  const [pick, setPick] = useState<number | null>(null);
  const [more, setMore] = useState<Recent[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const unread = useChatUnread(perms.opens("teamchat"));
  const { hits, busy } = useEverything(q);
  // Times ("5 min ago", local dates) only in the browser, so the server's HTML matches the first render.
  const mounted = useSyncExternalStore(noop, () => true, () => false);

  // Recent Google files and meetings come from other services: fetched here, skipped when not set up.
  useEffect(() => {
    let live = true;
    const add = (r: Recent[]) => live && r.length && setMore((cur) => [...cur, ...r]);
    const kinds = (["docs", "sheets", "slides"] as const).filter((k) => perms.opens(k));
    if (kinds.length)
      void googleConnected().then((ok) => {
        if (!ok) return;
        for (const k of kinds)
          fetch(`/api/google?view=files&kind=${k}&order=opened`)
            .then((r) => (r.ok ? r.json() : {}))
            .then((d: { files?: { id: string; name: string; modifiedTime: string; webViewLink: string }[] }) =>
              add((d.files ?? []).slice(0, 3).map((f) => ({ key: `g${f.id}`, label: f.name, sub: k === "docs" ? "Docs" : k === "sheets" ? "Sheets" : "Slides", href: k === "sheets" ? `/sheets/${encodeURIComponent(f.id)}` : f.webViewLink, icon: k, color: color(k), at: f.modifiedTime }))),
            )
            .catch(() => {});
      });
    if (perms.opens("meetings"))
      fetch("/workspace/api/meet", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : {}))
        .then((d: { meetings?: { code: string; title: string; createdAt: string; endedAt: string | null }[] }) =>
          add((d.meetings ?? []).slice(0, 3).map((m) => ({ key: `m${m.code}`, label: m.title || "Meeting", sub: "Meet", href: m.endedAt ? `/workspace/meet/${m.code}/notes` : `/workspace/meet/${m.code}`, icon: "meet", color: color("meetings"), at: m.createdAt }))),
        )
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [perms]);

  useEffect(() => {
    if (!focus) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setFocus(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [focus]);

  const term = q.trim();
  const ask = (t: string, newTab = false) => {
    // The prompt waits in session storage: a long paragraph doesn't fit in an address.
    try {
      sessionStorage.setItem(PENDING_ASK, t);
      return openInSuite("/home/chat?send=1", { newTab });
    } catch {
      return openInSuite(`/home/chat?prompt=${encodeURIComponent(t.slice(0, 1500))}&send=1`, { newTab });
    }
  };
  // Rows in the dropdown: "Ask AI" first, then the results. A plain question starts on Ask AI.
  const rows: ({ ask: true } | Hit)[] = [...(canAsk && term ? [{ ask: true as const }] : []), ...hits];
  const active = pick ?? (canAsk && term && (looksLikeQuestion(term) || !hits.length) ? 0 : canAsk && term ? 1 : 0);
  const choose = (i: number, newTab = false) => {
    const r = rows[i];
    if (!r) return;
    setFocus(false);
    if ("ask" in r) ask(term, newTab);
    else openInSuite(r.href, { newTab });
  };

  const shortcuts = useShortcuts(userKey, perms.opens);
  const recent = [...serverRecent, ...more].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, 12);
  let n = canAsk && term ? 0 : -1;

  return (
    <div className="ix-start">
      <h1 className="ix-start-brand">
        <IxMark size={52} />
        <span>
          {brand.name.startsWith(brand.shortName + " ") ? (
            <>
              {brand.shortName} <em>{brand.name.slice(brand.shortName.length + 1)}</em>
            </>
          ) : (
            brand.name
          )}
        </span>
      </h1>

      <div className="ix-bigsearch" ref={box}>
        <div className="ix-bigsearch-box" data-open={focus && !!term ? "true" : undefined}>
          <Icon name="search" size={19} style={{ color: "var(--ix-muted)", flex: "none" }} />
          <input
            ref={input}
            value={q}
            autoFocus
            onFocus={() => setFocus(true)}
            onChange={(e) => {
              setQ(e.target.value);
              setPick(null);
              setFocus(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (term) choose(active, e.altKey);
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPick(Math.min(active + 1, rows.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setPick(Math.max(active - 1, 0));
              }
              if (e.key === "Escape") setFocus(false);
            }}
            placeholder={canAsk ? `Search ${brand.shortName} or ask anything` : `Search ${brand.shortName}`}
            aria-label={canAsk ? `Search ${brand.shortName} or ask the AI` : `Search ${brand.shortName}`}
            role="combobox"
            aria-expanded={focus && !!term}
            aria-controls="ix-results"
            autoComplete="off"
          />
          {busy && <span className="mail-spin" style={{ color: "var(--ix-muted)" }} aria-label="Searching" />}
          {term && (
            <button className="ix-iconbtn" onClick={() => (setQ(""), input.current?.focus())} aria-label="Clear">
              <Icon name="close" size={15} />
            </button>
          )}
          {canAsk && (
            <button className="ix-askbtn" onClick={() => (term ? ask(term) : openInSuite("/home/chat?new=1"))} title="Ask the AI (opens AI Chat)">
              <Icon name="chat" size={14} /> Ask AI
            </button>
          )}
        </div>

        {focus && term && (
          <div className="ix-results" id="ix-results" role="listbox" aria-label="Search results">
            {canAsk && (
              <button className="ix-rrow" role="option" aria-selected={active === 0} data-active={active === 0 || undefined} onMouseEnter={() => setPick(0)} onClick={() => ask(term)}>
                <span className="ix-rico" style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}>
                  <Icon name="chat" size={14} />
                </span>
                <span className="ix-rmain">
                  Ask AI: <b>{term}</b>
                </span>
                <small>AI Chat · Enter</small>
              </button>
            )}
            {grouped(hits).map((g) => (
              <div key={g.group} role="group" aria-label={g.group}>
                <div className="ix-rsect">{g.group}</div>
                {g.hits.map((h) => {
                  const i = ++n;
                  return (
                    <TabLink key={h.key} href={h.href} className="ix-rrow" onClick={() => setFocus(false)} data-active={i === active || undefined} onMouseEnter={() => setPick(i)}>
                      <span className="ix-rico" style={{ background: h.color }}>
                        <Icon name={h.icon} size={14} />
                      </span>
                      <span className="ix-rmain">
                        {h.label}
                      </span>
                      {h.sub && <small>{h.sub}</small>}
                    </TabLink>
                  );
                })}
              </div>
            ))}
            {!busy && !hits.length && <p className="ix-rempty">Nothing found for “{term}”.{canAsk ? " Press Enter to ask the AI." : ""}</p>}
          </div>
        )}
      </div>

      {shortcuts.length > 0 && (
        <nav className="ix-shortcuts" aria-label="Shortcuts">
          {shortcuts.map((m) => (
            <TabLink key={m.id} href={appHref(m.id)} className="ix-shortcut" title={m.name} data-app={m.id}>
              {m.id === "teamchat" && unread > 0 && <span className="ix-badge">{unread > 99 ? "99+" : unread}</span>}
              <span className="ix-shortcut-ico">
                <AppIcon icon={m.icon} color={m.color} size={28} />
              </span>
              <span>{m.name}</span>
            </TabLink>
          ))}
        </nav>
      )}

      {recent.length > 0 && (
        <section className="ix-recent" aria-label="Recent">
          <h2>Recent</h2>
          <div className="ix-recent-row">
            {recent.map((r) => (
              <TabLink key={r.key} href={r.href} className="ix-rcard" title={r.label}>
                <span className="ix-rcard-top">
                  <AppIcon icon={r.icon} color={r.color} size={22} />
                  {r.sub}
                </span>
                <b>{r.label}</b>
                <span>
                  <Icon name="clock" size={12} /> {mounted ? ago(r.at) : ""}
                </span>
              </TabLink>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
