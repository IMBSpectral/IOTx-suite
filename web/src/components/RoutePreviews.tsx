"use client";

import { useState } from "react";
import type { RoutePreview } from "@/lib/route-preview";

type PageSeo = { title?: string; description?: string; ogImage?: string };
type Seo = {
  title?: string;
  description?: string;
  ogImage?: string;
  favicon?: string;
  pages?: Record<string, PageSeo>;
};

const STATE_LABEL: Record<RoutePreview["state"], string> = {
  ok: "Previewable",
  unpublished: "Not published",
  private: "Private site",
  redirect: "Redirects",
  signin: "Needs sign-in",
  not_found: "Not found",
  error: "Couldn't load",
};

/**
 * "Preview each page": the card and search snippet crawlers see for every
 * route of the published app, why a page can't be previewed, and per-page
 * title / description / image overrides (saved with the rest of the appearance).
 */
export default function RoutePreviews({
  projectId,
  seo,
  setSeo,
}: {
  projectId: string;
  seo: Seo;
  setSeo: (fn: (s: Seo) => Seo) => void;
}) {
  const [routes, setRoutes] = useState<RoutePreview[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [path, setPath] = useState("/");

  async function load() {
    setLoading(true);
    const d = await fetch(`/api/projects/${projectId}/route-preview`)
      .then((r) => (r.ok ? r.json() : { routes: [] }))
      .catch(() => ({ routes: [] }));
    setRoutes(d.routes);
    setLoading(false);
  }

  const muted = { color: "var(--muted)" };
  if (!routes) {
    return (
      <button
        onClick={() => void load()}
        disabled={loading}
        className="text-xs underline disabled:opacity-50"
        style={muted}
      >
        {loading ? "Checking each page…" : "Preview each page"}
      </button>
    );
  }
  const current = routes.find((r) => r.path === path) ?? routes[0];
  if (!current) return null;
  const page = seo.pages?.[current.path] ?? {};
  // What the card will show once saved and republished: this page's overrides first.
  const title = page.title || current.title || "Untitled page";
  const description = page.description || current.description;
  const image = page.ogImage
    ? page.ogImage.startsWith("/")
      ? new URL(page.ogImage, current.url).toString()
      : page.ogImage
    : current.image;
  const setPage = (patch: PageSeo) =>
    setSeo((s) => ({
      ...s,
      pages: {
        ...(s.pages ?? {}),
        [current.path]: { ...(s.pages?.[current.path] ?? {}), ...patch },
      },
    }));

  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <div className="flex items-center gap-2">
        <select
          aria-label="Page"
          value={current.path}
          onChange={(e) => setPath(e.target.value)}
          className="min-w-0 flex-1 rounded-md border bg-transparent px-1.5 py-1 text-xs"
        >
          {routes.map((r) => (
            <option key={r.path} value={r.path}>
              {r.path} · {STATE_LABEL[r.state]}
            </option>
          ))}
        </select>
        <button
          onClick={() => void load()}
          className="text-[11px] underline"
          style={muted}
        >
          Recheck
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="overflow-hidden rounded-lg border">
          <div
            className="h-16"
            style={{
              background: image
                ? `center / cover no-repeat url(${image})`
                : "linear-gradient(135deg,#e7e5e4,#f5f5f4)",
            }}
          />
          <div className="p-2">
            <p className="truncate text-[11px] font-medium">{title}</p>
            <p className="line-clamp-2 text-[10px]" style={muted}>
              {description || "No description"}
            </p>
          </div>
        </div>
        <div className="rounded-lg border p-2">
          <p className="truncate text-[10px]" style={muted}>
            {current.url}
          </p>
          <p className="truncate text-[12px] text-[#1a0dab] dark:text-[#8ab4f8]">
            {title}
          </p>
          <p className="line-clamp-2 text-[10px]" style={muted}>
            {description || "Search engines will pick text from the page."}
          </p>
        </div>
      </div>
      {current.notes.length > 0 && (
        <ul className="space-y-0.5 text-[11px]" aria-label="Page preview notes">
          {current.notes.map((n) => (
            <li
              key={n}
              className={
                current.state === "ok"
                  ? ""
                  : "text-amber-700 dark:text-amber-400"
              }
              style={current.state === "ok" ? muted : undefined}
            >
              • {n}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-1.5">
        <input
          value={page.title ?? ""}
          onChange={(e) => setPage({ title: e.target.value })}
          placeholder={`Title for ${current.path}`}
          aria-label={`Title for ${current.path}`}
          maxLength={120}
          className="rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
        />
        <input
          value={page.description ?? ""}
          onChange={(e) => setPage({ description: e.target.value })}
          placeholder="Description for this page"
          aria-label={`Description for ${current.path}`}
          maxLength={300}
          className="rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
        />
        <input
          value={page.ogImage ?? ""}
          onChange={(e) => setPage({ ogImage: e.target.value })}
          placeholder="Share image for this page (URL or /image.png)"
          aria-label={`Share image for ${current.path}`}
          className="rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
        />
      </div>
      <p className="text-[10px]" style={muted}>
        Page settings apply to link previews and search as soon as you save; the
        site doesn&apos;t need republishing.
      </p>
    </div>
  );
}
