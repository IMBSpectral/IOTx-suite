"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Package, X } from "lucide-react";

type Asset = { name: string; size: number };

/** A design system's asset bundle: logos, icons and fonts that travel with its tokens. */
export default function DesignAssets({ projectId }: { projectId: string }) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/design-assets`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setAssets(d.assets))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);

  async function upload(files: File[]) {
    setBusy(true);
    setError(null);
    for (const f of files) {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch(`/api/projects/${projectId}/design-assets`, { method: "POST", body: form });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d.error ?? "Upload failed");
      else setAssets(d.assets);
    }
    setBusy(false);
  }

  async function remove(name: string) {
    const res = await fetch(`/api/projects/${projectId}/design-assets?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    if (res.ok) setAssets(d.assets);
  }

  const muted = { color: "var(--muted)" };
  return (
    <section aria-label="Design assets" className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 font-medium">
          <Package className="h-4 w-4" /> Assets
        </p>
        <button onClick={() => input.current?.click()} disabled={busy} className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs disabled:opacity-50">
          <ImagePlus className="h-3.5 w-3.5" /> {busy ? "Uploading…" : "Add assets"}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".svg,.png,.jpg,.jpeg,.webp,.gif,.ico,.woff,.woff2,.ttf,.otf"
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      <p className="mt-1 text-xs" style={muted}>
        Logos, icons, illustrations and fonts. Apps that attach this design system get them in public/brand/, and the agent uses them.
      </p>
      {assets && assets.length > 0 && (
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {assets.map((a) => (
            <li key={a.name} className="group relative rounded-lg border p-2 text-center text-[11px]">
              {/\.(svg|png|jpe?g|webp|gif|ico)$/i.test(a.name) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/projects/${projectId}/design-assets?raw=${encodeURIComponent(a.name)}`} alt={a.name} className="mx-auto h-12 w-full object-contain" />
              ) : (
                <span className="grid h-12 place-items-center font-mono" style={muted}>Aa</span>
              )}
              <span className="mt-1 block truncate">{a.name}</span>
              <button onClick={() => remove(a.name)} aria-label={`Remove ${a.name}`} className="absolute right-1 top-1 hidden rounded bg-black/50 p-0.5 text-white group-hover:block">
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
