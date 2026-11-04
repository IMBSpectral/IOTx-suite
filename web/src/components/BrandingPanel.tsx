"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Brand } from "@/lib/brand-shared";
import { BrandProvider, BrandMark } from "./BrandProvider";

const FIELDS: { key: keyof Brand; label: string; hint: string; max: number }[] = [
  { key: "name", label: "Product name", hint: "Page titles, sign-in, emails and footers.", max: 40 },
  { key: "shortName", label: "Short name", hint: "The AI's name and tight spaces, e.g. \"Ask IOTx\".", max: 20 },
  { key: "mark", label: "Logo letters", hint: "Up to 3 characters, shown when there's no logo image.", max: 3 },
  { key: "tagline", label: "Tagline", hint: "The headline on the home and sign-in pages.", max: 120 },
  { key: "company", label: "Company name", hint: "Shown in the footer: © year Company.", max: 60 },
  { key: "supportEmail", label: "Support email", hint: "Where people are told to write for help. Optional.", max: 120 },
];

/** Settings → Branding: rename and re-skin the whole platform (platform admins). */
export default function BrandingPanel({ initial }: { initial: Brand }) {
  const router = useRouter();
  const [brand, setBrandState] = useState<Brand>(initial);
  const [saved, setSaved] = useState<Brand>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(brand) !== JSON.stringify(saved);
  const set = (k: keyof Brand, v: string) => setBrandState((b) => ({ ...b, [k]: v }));

  async function done(res: Response, text: string) {
    const d = (await res.json().catch(() => ({}))) as { brand?: Brand; error?: string };
    if (!res.ok || !d.brand) {
      setMsg({ ok: false, text: d.error ?? "Couldn't save." });
      return;
    }
    setBrandState(d.brand);
    setSaved(d.brand);
    setMsg({ ok: true, text });
    router.refresh();
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    await done(await fetch("/api/brand", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(brand) }), "Saved. Every page now uses the new branding.");
    setBusy(false);
  }

  async function upload(f: File) {
    setBusy(true);
    setMsg(null);
    const form = new FormData();
    form.append("file", f);
    await done(await fetch("/api/brand/logo", { method: "POST", body: form }), "Logo uploaded.");
    setBusy(false);
  }

  async function removeLogo() {
    setBusy(true);
    await done(await fetch("/api/brand/logo", { method: "DELETE" }), "Logo removed. The letters are shown instead.");
    setBusy(false);
  }

  const input = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Branding</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            The product name, logo and copy used across the whole platform: sign-in, the home page, every app, the AI&rsquo;s name and emails.
          </p>
        </div>

        <section className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
          <h3 className="text-sm font-semibold">Logo</h3>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <BrandProvider brand={brand}>
              <BrandMark size={56} />
            </BrandProvider>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" disabled={busy} onClick={() => file.current?.click()}>
                {brand.logo ? "Replace image" : "Upload image"}
              </button>
              {brand.logo && (
                <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" disabled={busy} onClick={removeLogo}>
                  Use letters instead
                </button>
              )}
              <input
                ref={file}
                type="file"
                accept="image/png,image/svg+xml,image/webp,image/jpeg"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="w-full text-xs" style={{ color: "var(--muted)" }}>
              Square PNG, SVG, WebP or JPG, up to 1 MB. Without an image, the letters below are shown on the gradient.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-6">
            {(["colorFrom", "colorTo"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="color" value={brand[k]} onChange={(e) => set(k, e.target.value)} className="h-8 w-10 cursor-pointer rounded border bg-transparent" />
                {k === "colorFrom" ? "Gradient start" : "Gradient end"}
                <code className="text-xs" style={{ color: "var(--muted)" }}>{brand[k]}</code>
              </label>
            ))}
          </div>
        </section>

        <section className="space-y-4 rounded-xl border p-4" style={{ background: "var(--panel)" }}>
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="text-sm font-medium">{f.label}</span>
              <input
                className={`${input} mt-1.5`}
                value={(brand[f.key] as string) ?? ""}
                maxLength={f.max}
                type={f.key === "supportEmail" ? "email" : "text"}
                onChange={(e) => set(f.key, e.target.value)}
              />
              <span className="mt-1 block text-xs" style={{ color: "var(--muted)" }}>{f.hint}</span>
            </label>
          ))}
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {busy ? "Saving…" : "Save branding"}
          </button>
          {dirty && (
            <button type="button" className="text-sm underline" onClick={() => setBrandState(saved)}>
              Discard changes
            </button>
          )}
          {msg && (
            <span role="status" className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-500"}`}>
              {msg.text}
            </span>
          )}
        </div>
      </div>

      {/* Live preview */}
      <aside className="space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>Preview</div>
        <BrandProvider brand={brand}>
          <div className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <BrandMark size={26} /> {brand.name}
            </div>
            <div className="mt-4 rounded-lg border px-3 py-2 text-sm" style={{ color: "var(--muted)" }}>
              Search or ask {brand.shortName}…
            </div>
          </div>
          <div className="overflow-hidden rounded-xl text-white" style={{ background: "radial-gradient(120% 100% at 0% 0%, #1b1660, #07071a 70%)" }}>
            <div className="p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <BrandMark size={24} /> {brand.name}
              </div>
              <div className="mt-6 text-xl font-semibold leading-tight tracking-tight">{brand.tagline}</div>
              <div className="mt-6 text-[11px] opacity-60">
                © {new Date().getFullYear()} {brand.company}
              </div>
            </div>
          </div>
        </BrandProvider>
      </aside>
    </div>
  );
}
