"use client";

import { useMemo, useRef, useState } from "react";
import { HEX, PRESETS, contrastReport, overlayFor, palettesFor, type AccentId, type Appearance, type ShellBg, type ThemeChoice } from "@/lib/iotx/appearance";
import { saveAppearance, uploadBackground } from "./appearance-client";
import { useBrand } from "@/components/BrandProvider";

const fmt = (n: number) => `${n.toFixed(1)}:1`;

/** Settings → Appearance. Everything here is saved to the account and follows the person to every device. */
export default function AppearanceSettings({ initial }: { initial: Appearance }) {
  const [a, setA] = useState<Appearance>(initial);
  const brand = useBrand();
  const [custom, setCustom] = useState(initial.accentCustom ?? "#7c3aed");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function save(patch: Partial<Appearance>) {
    setA((x) => ({ ...x, ...patch }));
    setError(null);
    const saved = await saveAppearance(patch);
    if (saved) {
      setA(saved);
      setStatus("Saved to your account");
    } else setError("Couldn't save. Try again.");
  }
  const report = useMemo(() => (HEX.test(custom) ? contrastReport(custom) : null), [custom]);
  const pal = palettesFor(a.accent, a.accentCustom);
  const bg = a.shellBg;
  const setBg = (patch: Partial<ShellBg>) => save({ shellBg: { ...bg, ...patch } as ShellBg });

  const box = "rounded-xl border p-4";
  const label = "text-sm font-medium";
  const muted = { color: "var(--muted)" };
  const opt = (on: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm ${on ? "font-medium" : ""}` + (on ? " ring-2 ring-[var(--accent)]" : "");

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Appearance</h2>
        <p className="mt-1 text-sm" style={muted}>
          How {brand.name} looks for you, on every device. {status && <span data-testid="appearance-status">· {status}</span>}
        </p>
        {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      </div>

      <div className={box} style={{ background: "var(--panel)" }}>
        <p className={label}>Theme</p>
        <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Theme">
          {(["light", "dark", "system"] as ThemeChoice[]).map((t) => (
            <button key={t} role="radio" aria-checked={a.theme === t} className={opt(a.theme === t)} onClick={() => save({ theme: t })} style={{ textTransform: "capitalize" }}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className={box} style={{ background: "var(--panel)" }}>
        <p className={label}>Accent</p>
        <div className="mt-2 flex flex-wrap items-center gap-3" role="radiogroup" aria-label="Accent">
          {(Object.keys(PRESETS) as Exclude<AccentId, "custom">[]).map((id) => (
            <button key={id} role="radio" aria-checked={a.accent === id} onClick={() => save({ accent: id })} className={opt(a.accent === id) + " flex items-center gap-2"}>
              <span className="inline-block h-4 w-4 rounded-full" style={{ background: `linear-gradient(135deg,${PRESETS[id].base},${PRESETS[id].partner})` }} />
              {PRESETS[id].label}
            </button>
          ))}
          <span className={opt(a.accent === "custom") + " flex items-center gap-2"}>
            <input type="color" value={HEX.test(custom) ? custom : "#7c3aed"} onChange={(e) => setCustom(e.target.value)} aria-label="Custom colour" className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0" />
            <input value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Custom colour hex" className="w-20 bg-transparent font-mono text-xs outline-none" />
            <button className="text-xs font-medium underline" disabled={!HEX.test(custom)} onClick={() => save({ accent: "custom", accentCustom: custom })}>
              Use custom
            </button>
          </span>
        </div>
        {report && (
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2" data-testid="contrast-report">
            {(["light", "dark"] as const).map((m) => {
              const r = report[m];
              return (
                <div key={m} className="flex items-center gap-2 rounded-lg border p-2" style={{ background: m === "light" ? "#f7f7fc" : "#0c0d18", color: m === "light" ? "#14152b" : "#ebecf8" }}>
                  <span className="rounded-md px-2 py-1 font-medium" style={{ background: r.accent, color: palettesFor("custom", custom)[m]["--on-accent"] }}>
                    Button
                  </span>
                  <span style={{ color: r.accent, fontWeight: 600 }}>Link text</span>
                  <span className="ml-auto opacity-80">
                    {m}: text {fmt(r.onPage)}, button {fmt(r.onButton)}
                    {r.adjusted ? " · adjusted to read well" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-xs" style={muted}>
          Hover and soft shades come from the one colour. If it would be hard to read in a theme, {brand.name} darkens or lightens it just enough (4.5:1 contrast).
        </p>
        <div className="mt-3 flex gap-2 text-xs">
          <span className="rounded-md px-2 py-1" style={{ background: pal.light["--accent-soft"], color: pal.light["--accent"] }}>
            Soft
          </span>
          <span className="rounded-md px-2 py-1" style={{ background: pal.light["--accent"], color: pal.light["--on-accent"] }}>
            Accent
          </span>
          <span className="rounded-md px-2 py-1" style={{ background: pal.light["--accent-hover"], color: pal.light["--on-accent"] }}>
            Hover
          </span>
        </div>
      </div>

      <div className={box} style={{ background: "var(--panel)" }}>
        <p className={label}>Home and shell background</p>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Background">
          <button role="radio" aria-checked={bg.kind === "none"} className={opt(bg.kind === "none")} onClick={() => save({ shellBg: { kind: "none" } })}>
            None
          </button>
          <button role="radio" aria-checked={bg.kind === "color"} className={opt(bg.kind === "color")} onClick={() => save({ shellBg: { kind: "color", color: bg.color ?? "#e9e7ff", dim: 0 } })}>
            Solid colour
          </button>
          <button role="radio" aria-checked={bg.kind === "image"} className={opt(bg.kind === "image")} onClick={() => file.current?.click()}>
            {bg.kind === "image" ? "Change image" : "Upload image"}
          </button>
          <input
            ref={file}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setStatus("Uploading…");
              const r = await uploadBackground(f);
              if (r.error || !r.url) {
                setStatus(null);
                return setError(r.error ?? "Couldn't upload the image.");
              }
              await save({ shellBg: { kind: "image", image: r.url, dim: bg.dim ?? 35, blur: bg.blur ?? 0 } });
            }}
          />
        </div>
        {bg.kind === "color" && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            Colour
            <input type="color" value={bg.color ?? "#e9e7ff"} onChange={(e) => setBg({ color: e.target.value })} aria-label="Background colour" />
            <span className="text-xs" style={muted}>
              A colour that would make text hard to read gets a light overlay automatically.
            </span>
          </label>
        )}
        {bg.kind !== "none" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Dim {bg.dim ?? 0}%
              <input type="range" min={0} max={85} value={bg.dim ?? 0} onChange={(e) => setA((x) => ({ ...x, shellBg: { ...x.shellBg, dim: Number(e.target.value) } }))} onMouseUp={() => setBg({ dim: a.shellBg.dim })} onTouchEnd={() => setBg({ dim: a.shellBg.dim })} onKeyUp={() => setBg({ dim: a.shellBg.dim })} className="block w-full" aria-label="Dim" />
            </label>
            {bg.kind === "image" && (
              <label className="text-sm">
                Blur {bg.blur ?? 0}px
                <input type="range" min={0} max={24} value={bg.blur ?? 0} onChange={(e) => setA((x) => ({ ...x, shellBg: { ...x.shellBg, blur: Number(e.target.value) } }))} onMouseUp={() => setBg({ blur: a.shellBg.blur })} onTouchEnd={() => setBg({ blur: a.shellBg.blur })} onKeyUp={() => setBg({ blur: a.shellBg.blur })} className="block w-full" aria-label="Blur" />
              </label>
            )}
          </div>
        )}
        {bg.kind !== "none" && (
          <div className="relative mt-3 h-32 overflow-hidden rounded-xl border" aria-label="Preview">
            <div className="absolute inset-0" style={bg.kind === "image" ? { backgroundImage: `url(${bg.image})`, backgroundSize: "cover", backgroundPosition: "center", filter: bg.blur ? `blur(${bg.blur}px)` : undefined, transform: bg.blur ? "scale(1.1)" : undefined } : { background: bg.color }} />
            <div className="absolute inset-0" style={{ background: "var(--bg)", opacity: overlayFor(bg, "light") }} />
            <div className="relative p-4">
              <p className="text-lg font-semibold" style={{ color: "var(--text)" }}>
                Good morning
              </p>
              <p className="text-sm" style={muted}>
                Text stays readable over your background.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
