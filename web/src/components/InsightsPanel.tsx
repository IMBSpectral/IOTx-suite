"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";

type App = {
  id: string;
  name: string;
  published: boolean;
  visits30d: number;
  builds30d: number;
  credits30d: number;
  updatedAt: string;
  whoFor: string | null;
  summary: string | null;
  category: string | null;
};
type Builder = { id: string; name: string; email: string; role: string; messages30d: number; lastActive: string | null; projectsCreated30d: number; credits30d: number };

/** Workspace insights: app activity, builder activity, who each app is for. */
export default function InsightsPanel() {
  const [data, setData] = useState<{ apps: App[]; builders: Builder[]; categories: string[]; pending: number } | null>(null);
  const [tab, setTab] = useState<"apps" | "builders">("apps");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    fetch("/api/workspace/insights")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Only workspace owners and admins can see insights.");
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error)
    return (
      <p className="text-sm text-red-500" role="alert">
        {error}
      </p>
    );
  if (!data)
    return (
      <p className="text-sm" style={muted}>
        Loading insights… describing apps can take a few seconds the first time.
      </p>
    );
  const apps = category ? data.apps.filter((a) => a.category === category) : data.apps;
  const th = "px-3 py-2 text-left font-normal";

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist">
          {(
            [
              ["apps", "App activity"],
              ["builders", "Builder activity"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1 ${tab === k ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`} style={tab === k ? undefined : muted}>
              {label}
            </button>
          ))}
        </div>
        {tab === "apps" && (
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="rounded-lg border bg-transparent px-2 py-1 text-xs">
            <option value="">All categories</option>
            {data.categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        <a href={`/api/workspace/insights?format=csv&kind=${tab}`} className="ml-auto flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs">
          <Download className="h-3.5 w-3.5" /> Export CSV
        </a>
      </div>
      <p className="text-xs" style={muted}>
        Last 30 days.{data.pending > 0 && ` ${data.pending} app${data.pending === 1 ? " is" : "s are"} still being described; reload to see more.`}
      </p>
      {tab === "apps" ? (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-xs">
            <thead style={muted}>
              <tr>
                <th className={th}>App</th>
                <th className={th}>Who it is for</th>
                <th className={th}>Category</th>
                <th className={`${th} text-right`}>Visits</th>
                <th className={`${th} text-right`}>Builds</th>
                <th className={`${th} text-right`}>Credits</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <Link href={`/projects/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    {a.published && <span className="ml-1 rounded border px-1 text-[10px]">Live</span>}
                    {a.summary && (
                      <span className="block" style={muted}>
                        {a.summary}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{a.whoFor ?? <span style={muted}>…</span>}</td>
                  <td className="px-3 py-2">{a.category ?? <span style={muted}>…</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.visits30d}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.builds30d}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.credits30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-xs">
            <thead style={muted}>
              <tr>
                <th className={th}>Builder</th>
                <th className={th}>Role</th>
                <th className={`${th} text-right`}>Messages</th>
                <th className={`${th} text-right`}>New projects</th>
                <th className={`${th} text-right`}>Credits</th>
                <th className={th}>Last active</th>
              </tr>
            </thead>
            <tbody>
              {data.builders.map((b) => (
                <tr key={b.id} className="border-t">
                  <td className="px-3 py-2">
                    <span className="font-medium">{b.name}</span>
                    <span className="block" style={muted}>
                      {b.email}
                    </span>
                  </td>
                  <td className="px-3 py-2">{b.role.toLowerCase()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{b.messages30d}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{b.projectsCreated30d}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{b.credits30d}</td>
                  <td className="px-3 py-2">{b.lastActive ? new Date(b.lastActive).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
