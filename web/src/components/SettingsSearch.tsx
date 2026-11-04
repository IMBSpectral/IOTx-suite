"use client";

import { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";

/** Every setting a person might look for, and where it lives. */
const INDEX = [
  { title: "Workspace name", where: "Workspace", href: "/settings", words: "rename title" },
  { title: "Workspace details", where: "Workspace", href: "/settings", words: "slug plan created" },
  { title: "Invite members", where: "Members", href: "/settings/members", words: "add people team email invite" },
  { title: "Member roles", where: "Members", href: "/settings/members", words: "owner admin member viewer permissions role" },
  { title: "Remove a member", where: "Members", href: "/settings/members", words: "delete kick people" },
  { title: "Credit balance", where: "Billing", href: "/settings/billing#credits", words: "credits balance remaining" },
  { title: "Top up credits", where: "Billing", href: "/settings/billing#credits", words: "buy purchase add credits payment" },
  { title: "Auto top-up", where: "Billing", href: "/settings/billing#credits", words: "automatic recharge refill credits" },
  { title: "Usage breakdown", where: "Billing", href: "/settings/billing#usage", words: "usage spend build chat media cloud per project member analytics" },
  { title: "Spending limits", where: "Billing", href: "/settings/billing#limits", words: "limit cap budget spend monthly manage limits member project" },
  { title: "Plans", where: "Billing", href: "/settings/billing#plans", words: "upgrade downgrade pro business free subscription pricing" },
  { title: "Connectors", where: "Connectors", href: "/settings/connectors", words: "integrations notion slack stripe github openai resend airtable api token connect manage connectors" },
  { title: "Tips & tricks", where: "Preferences", href: "/settings/preferences#tips", words: "tips hints coachmarks onboarding show hide" },
  { title: "Credit activity", where: "Billing", href: "/settings/billing", words: "history ledger transactions invoices" },
];

function tokens(s: string) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function searchSettings(query: string) {
  const q = tokens(query);
  if (!q.length) return { results: [], exact: true };
  const scored = INDEX.map((item) => {
    const hay = tokens(`${item.title} ${item.where} ${item.words}`);
    const hits = q.filter((w) => hay.some((h) => h.startsWith(w))).length;
    return { item, hits };
  }).filter((s) => s.hits > 0);
  const exact = scored.filter((s) => s.hits === q.length);
  if (exact.length) return { results: exact.map((s) => s.item), exact: true };
  return { results: scored.sort((a, b) => b.hits - a.hits).slice(0, 5).map((s) => s.item), exact: false };
}

export default function SettingsSearch() {
  const [q, setQ] = useState("");
  const { results, exact } = searchSettings(q);
  return (
    <div className="relative mb-5">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4" style={{ color: "var(--muted)" }} />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQ("")}
        placeholder="Search settings"
        aria-label="Search settings"
        className="w-full rounded-lg border bg-transparent py-2 pl-8 pr-3 text-sm outline-none"
      />
      {q.trim() && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border p-1 shadow-lg" style={{ background: "var(--panel)" }}>
          {!exact && results.length > 0 && (
            <p className="px-2.5 py-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
              No setting matches every word. Showing the closest results.
            </p>
          )}
          {results.length === 0 && (
            <p className="px-2.5 py-2 text-xs" style={{ color: "var(--muted)" }}>
              No settings found.
            </p>
          )}
          {results.map((r) => (
            <Link
              key={r.title}
              href={r.href}
              onClick={() => setQ("")}
              className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm hover:bg-black/[.04]"
            >
              {r.title}
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {r.where}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
