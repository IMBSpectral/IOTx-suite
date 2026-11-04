"use client";

import { useCallback, useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";

type Announcement = {
  id: string;
  title: string;
  body: string;
  href?: string;
  startsAt?: string;
  endsAt?: string;
  countdown?: boolean;
};
const EMPTY = {
  countdown: false,
  id: "",
  title: "",
  body: "",
  href: "",
  startsAt: "",
  endsAt: "",
};

// <input type="datetime-local"> wants local "YYYY-MM-DDTHH:mm".
function toLocal(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function stateOf(a: Announcement, now: number) {
  if (a.startsAt && new Date(a.startsAt).getTime() > now) return "Scheduled";
  if (a.endsAt && new Date(a.endsAt).getTime() <= now) return "Ended";
  return "Live";
}

/** Platform admins write the announcements shown above everyone's dashboard. */
export default function AnnouncementsAdmin({ endpoint = "/api/admin/announcements" }: { endpoint?: string } = {}) {
  const [list, setList] = useState<Announcement[] | null>(null);
  const brand = useBrand();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);

  const load = useCallback(
    () =>
      fetch(endpoint)
        .then((r) => (r.ok ? r.json() : { announcements: [] }))
        .then((d) => {
          setList(d.announcements);
          setNow(Date.now());
        }),
    [endpoint],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        id: form.id || undefined,
        startsAt: form.startsAt
          ? new Date(form.startsAt).toISOString()
          : undefined,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : undefined,
      }),
    });
    if (!res.ok)
      return setError(
        (await res.json().catch(() => ({}))).error ?? "Couldn't save",
      );
    setForm(EMPTY);
    await load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this announcement?")) return;
    await fetch(`${endpoint}?id=${id}`, { method: "DELETE" });
    if (form.id === id) setForm(EMPTY);
    await load();
  }

  const muted = { color: "var(--muted)" };
  const input =
    "w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none";
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-medium">
          {form.id ? "Edit announcement" : "New announcement"}
        </h2>
        <p className="mt-0.5 text-xs" style={muted}>
          Shown above the dashboard for everyone on this {brand.shortName}, newest first,
          until it ends or they dismiss it.
        </p>
        <form onSubmit={save} className="mt-3 space-y-2.5">
          <input
            aria-label="Title"
            placeholder="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className={input}
            maxLength={120}
            required
          />
          <textarea
            aria-label="Message"
            placeholder="Message"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            className={`${input} resize-none`}
            rows={2}
            maxLength={500}
          />
          <input
            aria-label="Link"
            placeholder="Link (optional): https://… or /path"
            value={form.href}
            onChange={(e) => setForm({ ...form, href: e.target.value })}
            className={input}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs" style={muted}>
              Starts (empty: now)
              <input
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                className={`${input} mt-1`}
              />
            </label>
            <label className="text-xs" style={muted}>
              Ends (empty: never)
              <input
                type="datetime-local"
                value={form.endsAt}
                onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                className={`${input} mt-1`}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!form.countdown}
              disabled={!form.endsAt}
              onChange={(e) => setForm({ ...form, countdown: e.target.checked })}
            />
            Show a countdown to the end
          </label>
          {error && (
            <p className="text-xs text-red-600" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 text-sm">
            {form.id && (
              <button
                type="button"
                onClick={() => setForm(EMPTY)}
                style={muted}
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              {form.id ? "Save" : "Publish announcement"}
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">All announcements</h2>
        {!list ? (
          <p className="text-xs" style={muted}>
            Loading…
          </p>
        ) : !list.length ? (
          <p className="text-xs" style={muted}>
            None yet.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border text-sm">
            {list.map((a) => (
              <li
                key={a.id}
                className="flex items-start justify-between gap-3 px-3 py-2.5"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{a.title}</span>
                  {a.body && (
                    <span className="block text-xs" style={muted}>
                      {a.body}
                    </span>
                  )}
                  <span className="text-[11px]" style={muted}>
                    {stateOf(a, now)}
                    {a.startsAt
                      ? ` · from ${new Date(a.startsAt).toLocaleString()}`
                      : ""}
                    {a.endsAt
                      ? ` · until ${new Date(a.endsAt).toLocaleString()}`
                      : ""}
                  </span>
                </span>
                <span className="flex shrink-0 gap-2 text-xs">
                  <button
                    onClick={() =>
                      setForm({
                        id: a.id,
                        title: a.title,
                        body: a.body,
                        href: a.href ?? "",
                        startsAt: toLocal(a.startsAt),
                        endsAt: toLocal(a.endsAt),
                        countdown: !!a.countdown,
                      })
                    }
                    className="hover:underline"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void remove(a.id)}
                    className="text-red-600 hover:underline"
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
