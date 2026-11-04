"use client";

import { useEffect, useState } from "react";
import { MANIFESTS } from "@/lib/iotx/manifests";
import { usePerms } from "./PermsProvider";
import { appHref } from "./Launcher";

/** One search result: where it opens (a suite tab, or a real browser tab for another site), and whether it's another app. */
export type Hit = { key: string; group: string; label: string; sub?: string; href: string; icon: string; color: string; app: boolean };

type Suite = {
  projects?: { id: string; name: string }[];
  chats?: { id: string; title: string }[];
  knowledge?: { id: string; title: string; kind: string }[];
  people?: { id: string; name: string | null; email: string }[];
};
type Work = {
  events?: { id: string; title: string; start: string; href: string }[];
  tasks?: { id: string; title: string; project: string; href: string }[];
  messages?: { id: string; body: string; where: string; href: string }[];
};
type GFile = { id: string; name: string; modifiedTime: string; webViewLink: string };

const color = (id: string) => MANIFESTS.find((m) => m.id === id)?.color ?? "#6a6e8a";
const json = (r: Response) => (r.ok ? r.json() : {});

/** Whether Google Drive is connected (asked once per page). */
let google: Promise<boolean> | null = null;
export const googleConnected = () =>
  (google ??= fetch("/api/google?view=status")
    .then(json)
    .then((d: { connection?: unknown }) => !!d.connection)
    .catch(() => false));

/** A question for the AI rather than a search ("how do I…?", or a sentence). */
export const looksLikeQuestion = (q: string) => /\?\s*$/.test(q) || /^(what|why|how|when|where|who|which|can|could|should|is|are|do|does|explain|write|draft|summari[sz]e|tell|help|make|create)\b/i.test(q) || q.trim().split(/\s+/).length >= 5;

/**
 * "Search everything": apps, projects, AI chats, knowledge, people (suite),
 * events, tasks and messages (Workspace, same origin under /workspace) and
 * Google Docs, Sheets and Slides when Drive is connected. What a source can't
 * answer (no session there, switched off) is simply left out.
 */
export function useEverything(q: string) {
  const perms = usePerms();
  const term = q.trim();
  const [got, setGot] = useState<{ term: string; hits: Hit[] }>({ term: "", hits: [] });

  useEffect(() => {
    if (term.length < 2) return;
    const ctl = new AbortController();
    const opt = { signal: ctl.signal, cache: "no-store" as const };
    const t = setTimeout(async () => {
      const ws = ["calendar", "tasks", "teamchat"].some((a) => perms.opens(a));
      const kinds = (["docs", "sheets", "slides"] as const).filter((k) => perms.opens(k));
      const [s, w, g] = await Promise.all([
        fetch(`/api/search?all=1&q=${encodeURIComponent(term)}`, opt).then(json).catch(() => ({})) as Promise<Suite>,
        ws ? (fetch(`/workspace/api/search?q=${encodeURIComponent(term)}`, opt).then(json).catch(() => ({})) as Promise<Work>) : Promise.resolve({} as Work),
        kinds.length && (await googleConnected())
          ? Promise.all(
              kinds.map((k) =>
                fetch(`/api/google?view=files&kind=${k}&q=${encodeURIComponent(term)}`, opt)
                  .then(json)
                  .then((d: { files?: GFile[] }) => (d.files ?? []).slice(0, 4).map((f) => ({ f, k })))
                  .catch(() => []),
              ),
            ).then((x) => x.flat())
          : Promise.resolve([] as { f: GFile; k: string }[]),
      ]);
      if (ctl.signal.aborted) return;
      const hits: Hit[] = [
        ...(s.chats ?? []).map((c) => ({ key: `c${c.id}`, group: "AI chats", label: c.title, href: `/home/chat?chat=${c.id}`, icon: "chat", color: color("chat"), app: false })),
        ...g.map(({ f, k }) => ({ key: `g${f.id}`, group: "Files", label: f.name, sub: k === "docs" ? "Doc" : k === "sheets" ? "Sheet" : "Slides", href: k === "sheets" ? `/sheets/${encodeURIComponent(f.id)}` : f.webViewLink, icon: k, color: color(k), app: true })),
        ...(s.projects ?? []).map((p) => ({ key: `p${p.id}`, group: "Projects", label: p.name, sub: "Builder", href: `/projects/${p.id}`, icon: "builder", color: color("builder"), app: true })),
        ...(s.knowledge ?? []).map((d) => ({ key: `k${d.id}`, group: "Knowledge", label: d.title, sub: d.kind, href: `/knowledge?doc=${d.id}`, icon: "read", color: color("read"), app: true })),
        ...(w.events ?? []).map((e) => ({ key: `e${e.id}`, group: "Calendar", label: e.title, sub: new Date(e.start).toLocaleDateString([], { day: "numeric", month: "short" }), href: e.href, icon: "calendar", color: color("calendar"), app: true })),
        ...(w.tasks ?? []).map((x) => ({ key: `t${x.id}`, group: "Tasks", label: x.title, sub: x.project, href: x.href, icon: "tasks", color: color("tasks"), app: true })),
        ...(w.messages ?? []).map((m) => ({ key: `m${m.id}`, group: "Chat", label: m.body, sub: m.where, href: m.href, icon: "chat", color: color("teamchat"), app: true })),
        ...(s.people ?? []).map((p) => ({ key: `u${p.id}`, group: "People", label: p.name || p.email, sub: p.email, href: `mailto:${p.email}`, icon: "people", color: "#868e96", app: false })),
      ];
      setGot({ term, hits });
    }, 180);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [term, perms]);

  const f = term.toLowerCase();
  const apps: Hit[] = f
    ? MANIFESTS.filter((m) => m.id !== "home" && !m.settingsOnly && perms.opens(m.id) && (m.name.toLowerCase().includes(f) || m.desc.toLowerCase().includes(f)))
        .slice(0, 4)
        .map((m) => ({ key: `a${m.id}`, group: "Apps", label: m.name, sub: m.status === "soon" ? "Coming soon" : m.desc, href: appHref(m.id), icon: m.icon, color: m.color, app: m.id !== "chat" }))
    : [];
  const fresh = got.term === term;
  return { hits: term.length < 2 ? apps : [...apps, ...(fresh ? got.hits : [])], busy: term.length >= 2 && !fresh };
}

/** Places to jump to by name (the old Ctrl+K palette's "Go to" list). */
export const GO_TO = [
  { label: "Home", href: "/home" },
  { label: "AI chat", href: "/home/chat" },
  { label: "New project", href: "/dashboard" },
  { label: "All projects", href: "/dashboard/projects" },
  { label: "Workspace settings", href: "/settings" },
  { label: "Members", href: "/settings/members" },
  { label: "Billing", href: "/settings/billing" },
  { label: "Roles & permissions", href: "/admin/roles" },
  { label: "Appearance", href: "/settings/appearance" },
  { label: "Preferences", href: "/settings/preferences" },
];

/** Group hits under their headings, keeping the order of first appearance. */
export function grouped(hits: Hit[]) {
  const out: { group: string; hits: Hit[] }[] = [];
  for (const h of hits) {
    const g = out.find((x) => x.group === h.group);
    if (g) g.hits.push(h);
    else out.push({ group: h.group, hits: [h] });
  }
  return out;
}
