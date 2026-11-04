"use client";

import { useState } from "react";
import type { Listing } from "@/lib/listing";
import { CATEGORIES } from "@/lib/templates";

type Card = { id: string; name: string; emoji: string | null; url: string | null; listing?: Listing | null };

const PUBLISHER: Record<Listing["publisherType"], string> = { individual: "Individual", team: "Team", company: "Company" };

/** A workspace template in the gallery, with its listing (tagline, about, category, publisher) and an editor. */
export default function TemplateListingCard({ card, busy, onUse, onChanged }: { card: Card; busy: boolean; onUse: () => void; onChanged: () => void }) {
  const l = card.listing ?? null;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Listing>(
    l ?? { tagline: "", about: "", category: "Other", icon: card.emoji ?? "", publisherType: "individual", hidePreview: false },
  );
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };
  const input = "w-full rounded-lg border bg-transparent px-2 py-1.5 text-xs";

  async function save() {
    setError("");
    const r = await fetch(`/api/projects/${card.id}/listing`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "Couldn't save the listing");
    setEditing(false);
    onChanged();
  }

  async function remove() {
    if (!confirm(`Remove ${card.name} from the gallery? The project itself stays.`)) return;
    await fetch(`/api/projects/${card.id}/listing`, { method: "DELETE" });
    onChanged();
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-2 rounded-xl border p-4 text-xs" style={{ background: "var(--panel)" }}>
        <p className="text-sm font-medium">Listing for {card.name}</p>
        <div className="flex gap-2">
          <input value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} placeholder="🧩" aria-label="Icon (emoji)" className={`${input} w-14 text-center`} />
          <input value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} placeholder="Tagline" aria-label="Tagline" className={input} />
        </div>
        <textarea value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} placeholder="About: what it does and who it's for" aria-label="About" rows={3} className={input} />
        <div className="flex gap-2">
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} aria-label="Category" className={input}>
            {[...CATEGORIES, "Other"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select value={form.publisherType} onChange={(e) => setForm({ ...form, publisherType: e.target.value as Listing["publisherType"] })} aria-label="Publisher type" className={input}>
            {Object.entries(PUBLISHER).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.hidePreview} onChange={(e) => setForm({ ...form, hidePreview: e.target.checked })} /> Hide preview
        </label>
        {error && (
          <p className="text-red-500" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={() => setEditing(false)} className="rounded-lg border px-2.5 py-1">
            Cancel
          </button>
          <button onClick={() => void save()} className="rounded-lg px-2.5 py-1 font-medium text-white" style={{ background: "var(--accent)" }}>
            Save listing
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-col rounded-xl border p-4" style={{ background: "var(--panel)" }}>
      {l && (
        <p className="text-[11px] font-medium uppercase tracking-wider" style={muted}>
          {l.category} · {PUBLISHER[l.publisherType]}
        </p>
      )}
      <p className="mt-1 text-sm font-medium">
        {l?.icon || card.emoji ? `${l?.icon || card.emoji} ` : ""}
        {card.name}
      </p>
      <p className="mt-1 flex-1 text-xs" style={muted}>
        {l?.tagline ?? "A project from your workspace, copied as a starting point."}
      </p>
      {l?.about && (
        <p className="mt-1 line-clamp-3 text-xs" style={muted}>
          {l.about}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button onClick={onUse} disabled={busy} className="rounded-lg px-3 py-1.5 font-medium text-white disabled:opacity-50" style={{ background: "var(--accent)" }}>
          {busy ? "Creating…" : "Use template"}
        </button>
        {card.url && !l?.hidePreview && (
          <a href={card.url} target="_blank" rel="noreferrer" className="rounded-lg border px-3 py-1.5">
            Preview
          </a>
        )}
        <button onClick={() => setEditing(true)} className="rounded-lg border px-3 py-1.5">
          {l ? "Edit listing" : "Add listing"}
        </button>
        {l && (
          <button onClick={() => void remove()} className="rounded-lg border px-3 py-1.5 text-red-500">
            Remove
          </button>
        )}
      </div>
    </li>
  );
}
