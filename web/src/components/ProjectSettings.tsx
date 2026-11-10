"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import GitMaintenance from "./GitMaintenance";
import EnvRows, { type EnvRow } from "./EnvRows";
import DomainStatus from "./DomainStatus";

export default function ProjectSettings({
  projectId,
  subdomain,
  initialDomain,
  publishedUrl,
  onSend,
}: {
  projectId: string;
  subdomain: string;
  initialDomain: string | null;
  publishedUrl: string | null;
  onSend?: (text: string) => void;
}) {
  const [migrating, setMigrating] = useState(false);
  const brand = useBrand();
  const [domain, setDomain] = useState(initialDomain ?? "");
  // The domain as last saved, which the status check follows.
  const [saved, setSaved] = useState(initialDomain ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Review changes before they're kept (drafts). Off by default: changes keep going, Publish is the only gate.
  const [review, setReview] = useState<boolean | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/drafts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { review?: boolean } | null) => live && setReview(!!d?.review))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);
  async function toggleReview(on: boolean) {
    setReviewError(null);
    setReview(on);
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewDrafts: on }),
    }).catch(() => null);
    if (!res?.ok) {
      setReview(!on);
      setReviewError("Couldn't save that. Try again.");
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customDomain: domain.trim() || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Could not save");
      }
      setNote("Saved.");
      setSaved(domain.trim().toLowerCase());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-lg space-y-7">
        <section>
          <h3 className="mb-2 text-sm font-medium">Address</h3>
          <div className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
            <p className="font-mono text-xs break-all">{subdomain}</p>
            {publishedUrl ? (
              <a
                href={publishedUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-xs hover:underline"
                style={{ color: "var(--accent)" }}
              >
                Open live site
              </a>
            ) : (
              <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                Not published yet.
              </p>
            )}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium">Changes</h3>
          <div className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!review}
                disabled={review === null}
                onChange={(e) => void toggleReview(e.target.checked)}
              />
              <span className="text-xs">
                <span className="font-medium">Review changes before they&apos;re kept</span>
                <span className="mt-1 block" style={{ color: "var(--muted)" }}>
                  {review
                    ? "On: each change waits in a draft until you accept it. Useful when other people work on this project."
                    : "Off: every change goes straight into the working version and the work keeps going. Your live site still changes only when you publish."}
                </span>
              </span>
            </label>
            {reviewError && <p className="mt-2 text-xs text-red-600">{reviewError}</p>}
          </div>
        </section>

        {onSend && (
          <section>
            <h3 className="mb-2 text-sm font-medium">Routing</h3>
            {migrating ? (
              <div role="dialog" aria-label="Migrate to TanStack Router" className="rounded-lg border p-3 text-xs" style={{ background: "var(--panel)" }}>
                <p className="font-medium">Migrate this project to TanStack Router?</p>
                <p className="mt-1" style={{ color: "var(--muted)" }}>
                  The agent moves every page to type-safe, file-based routes with TanStack Router, keeps the same URLs, and
                  checks each page still loads. It happens in a draft, so you can review it before accepting. This uses
                  credits like any build.
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button onClick={() => setMigrating(false)} className="rounded-lg border px-3 py-1.5">
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setMigrating(false);
                      onSend(
                        "Migrate this project's routing to TanStack Router (@tanstack/react-router) with file-based routes in src/routes/. " +
                          "Keep every existing URL and page working, move layouts into route layouts, use typed params and loaders where data is fetched, " +
                          "remove the old router, and confirm each page still renders.",
                      );
                    }}
                    className="btn-primary rounded-lg px-3 py-1.5"
                  >
                    Migrate
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setMigrating(true)} className="rounded-lg border px-3 py-1.5 text-xs">
                Migrate to TanStack Router…
              </button>
            )}
          </section>
        )}

        <section>
          <h3 className="mb-2 text-sm font-medium">Custom domain</h3>
          <div className="flex gap-2">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="app.example.com"
              aria-label="Custom domain"
              className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ background: "var(--panel)" }}
            />
            <button
              onClick={save}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              style={{ background: "var(--accent)" }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          {saved ? (
            <DomainStatus projectId={projectId} domain={saved} />
          ) : (
            <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
              Save a domain you own; {brand.shortName} shows the DNS record to add and checks it live.
            </p>
          )}
          {note && (
            <p className="mt-1.5 text-xs" style={{ color: "var(--muted)" }}>
              {note}
            </p>
          )}
          {error && (
            <p className="mt-1.5 text-xs text-red-500" role="alert">
              {error}
            </p>
          )}
        </section>

        <EnvSection projectId={projectId} />

        <section>
          <h3 className="mb-2 text-sm font-medium">Source</h3>
          <a
            href={`/api/projects/${projectId}/export`}
            className="inline-block rounded-lg border px-3 py-2 text-sm"
          >
            Download as .zip
          </a>
          <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
            Includes a package.json and Vite config so it runs anywhere.
          </p>
        </section>

        <GitMaintenance projectId={projectId} />
      </div>
    </div>
  );
}

/** Environment variables: names are listed, values are write-only. */
function EnvSection({ projectId }: { projectId: string }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${projectId}/env`;

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setNames(d?.names ?? []));
    return () => {
      live = false;
    };
  }, [base]);

  async function put(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setError(d.error ?? "Couldn’t save");
    setNames(d.names);
    setRows([]);
  }

  if (names === null) return null;
  return (
    <section aria-label="Environment variables">
      <h3 className="mb-2 text-sm font-medium">Environment variables</h3>
      {names.length > 0 && (
        <ul className="mb-2 divide-y rounded-lg border text-xs">
          {names.map((n) => (
            <li key={n} className="flex items-center justify-between px-3 py-1.5">
              <span className="font-mono">{n}</span>
              <span className="flex items-center gap-3">
                <span style={{ color: "var(--muted)" }}>••••••</span>
                <button onClick={() => put({ remove: [n] })} className="text-red-600 hover:underline">
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <EnvRows rows={rows} onChange={setRows} />
      {rows.length > 0 && (
        <button onClick={() => put({ set: rows })} className="mt-2 rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: "var(--accent)" }}>
          Save variables
        </button>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </section>
  );
}
