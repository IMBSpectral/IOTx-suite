"use client";

import DesignAssets from "./DesignAssets";
import { useEffect, useState } from "react";
import { Palette, RefreshCw } from "lucide-react";
import type { Tokens } from "@/lib/design-systems";

const FONTS = ["Inter", "DM Sans", "Manrope", "Plus Jakarta Sans", "Space Grotesk", "Playfair Display", "Fraunces", "Lora", "IBM Plex Sans", "Poppins"];
const COLOR_KEYS: (keyof Tokens["colors"])[] = ["primary", "secondary", "accent", "background", "foreground", "muted", "border", "destructive"];

type DsState = { kind: "design_system"; tokens: Tokens; version: number };
type AppState = {
  kind: string;
  attached: { id: string; name: string; installed: number | null; latest: number; updateAvailable: boolean } | null;
  available: { id: string; name: string; dsVersion: number }[];
};

/**
 * Design tab. In a design system: edit tokens and publish versions. In an
 * app: attach a design system, see which version is installed, update.
 */
/** What Lovable sends after a design system is attached in chat. */
const SETUP_PROMPT = "I've attached a design system. Set it up in this project.";

export default function DesignSystemPanel({
  projectId,
  onChanged,
  onSend,
}: {
  projectId: string;
  onChanged?: () => void;
  /** Sends a chat message as a Build turn. */
  onSend?: (text: string) => void;
}) {
  const [state, setState] = useState<DsState | AppState | null>(null);
  const [draft, setDraft] = useState<Tokens | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const muted = { color: "var(--muted)" };
  const base = `/api/projects/${projectId}/design-system`;

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setState(d);
        if (d.kind === "design_system") setDraft(d.tokens);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, version]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setMessage(null);
    const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setMessage({ ok: false, text: d.error ?? "Something went wrong" });
      return null;
    }
    setVersion((v) => v + 1);
    onChanged?.();
    return d;
  }

  if (!state) return <p className="p-4 text-sm" style={muted}>Loading…</p>;

  if (state.kind === "design_system" && draft) {
    const set = (patch: Partial<Tokens>) => setDraft({ ...draft, ...patch });
    return (
      <div className="h-full space-y-5 overflow-y-auto p-5 text-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-1.5 font-medium">
              <Palette className="h-4 w-4" /> Design system
            </p>
            <p className="text-xs" style={muted}>
              {(state as DsState).version ? `Published v${(state as DsState).version}` : "Not published yet"} · apps that attach it follow these tokens.
            </p>
          </div>
          <span className="flex gap-1.5">
            <button
              onClick={async () => {
                if (await act("save", { tokens: draft })) setMessage({ ok: true, text: "Saved. The style guide preview updates." });
              }}
              disabled={!!busy}
              className="rounded-lg border px-3 py-1.5 text-xs"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button
              onClick={async () => {
                if (!(await act("save", { tokens: draft }))) return;
                const d = await act("publish");
                if (d) setMessage({ ok: true, text: `Published v${d.version}. Apps using it will see an update.` });
              }}
              disabled={!!busy}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              Publish version
            </button>
          </span>
        </div>
        {message && (
          <p className={`text-xs ${message.ok ? "text-emerald-600" : "text-red-600"}`} role="status">
            {message.text}
          </p>
        )}
        <DesignAssets projectId={projectId} />
        <label className="block text-xs">
          Name
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className="mt-1 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm" />
        </label>
        <section aria-label="Colours">
          <h3 className="mb-2 text-xs font-medium">Colours</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {COLOR_KEYS.map((k) => (
              <label key={k} className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs">
                <input
                  type="color"
                  value={draft.colors[k]}
                  onChange={(e) => set({ colors: { ...draft.colors, [k]: e.target.value } })}
                  aria-label={`${k} colour`}
                  className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <span>
                  <span className="block capitalize">{k}</span>
                  <span className="font-mono text-[10px]" style={muted}>
                    {draft.colors[k]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>
        <section aria-label="Type and shape" className="grid gap-3 sm:grid-cols-2">
          {(["heading", "body"] as const).map((k) => (
            <label key={k} className="block text-xs capitalize">
              {k} font
              <select
                value={draft.fonts[k]}
                onChange={(e) => set({ fonts: { ...draft.fonts, [k]: e.target.value } })}
                className="mt-1 w-full rounded-lg border bg-transparent px-2 py-1.5 text-sm"
              >
                {[...new Set([draft.fonts[k], ...FONTS])].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="block text-xs">
            Corner radius
            <select value={draft.radius} onChange={(e) => set({ radius: e.target.value })} className="mt-1 w-full rounded-lg border bg-transparent px-2 py-1.5 text-sm">
              {["0rem", "0.25rem", "0.5rem", "0.75rem", "1rem", "1.5rem"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            Density
            <select value={draft.density} onChange={(e) => set({ density: e.target.value as Tokens["density"] })} className="mt-1 w-full rounded-lg border bg-transparent px-2 py-1.5 text-sm">
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
        </section>
        <label className="block text-xs">
          Guidance for the agent
          <textarea
            value={draft.guidance}
            onChange={(e) => set({ guidance: e.target.value })}
            rows={3}
            className="mt-1 w-full resize-y rounded-lg border bg-transparent px-2.5 py-1.5 text-sm"
          />
        </label>
      </div>
    );
  }

  const app = state as AppState;
  return (
    <div className="h-full space-y-5 overflow-y-auto p-5 text-sm">
      <p className="flex items-center gap-1.5 font-medium">
        <Palette className="h-4 w-4" /> Design system
      </p>
      {message && (
        <p className={`text-xs ${message.ok ? "text-emerald-600" : "text-red-600"}`} role="status">
          {message.text}
        </p>
      )}
      {app.attached ? (
        <div className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
          <p>
            Using <span className="font-medium">{app.attached.name}</span> v{app.attached.installed}
          </p>
          <p className="mt-0.5 text-xs" style={muted}>
            Its colours, fonts and radius are installed as this app&apos;s tokens, and the agent follows it every turn.
          </p>
          <div className="mt-3 flex gap-1.5 text-xs">
            {app.attached.updateAvailable && (
              <button
                onClick={async () => {
                  const d = await act("update");
                  if (d) setMessage({ ok: true, text: `Updated to v${d.version}.` });
                }}
                disabled={!!busy}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                <RefreshCw className="h-3 w-3" /> Update to v{app.attached.latest}
              </button>
            )}
            {onSend && (
              <button onClick={() => onSend(SETUP_PROMPT)} disabled={!!busy} className="rounded-md border px-2.5 py-1">
                Set it up in this project
              </button>
            )}
            <a href={`/projects/${app.attached.id}`} className="rounded-md border px-2.5 py-1">
              Edit design system
            </a>
            <button onClick={() => act("detach")} disabled={!!busy} className="rounded-md border px-2.5 py-1">
              Detach
            </button>
          </div>
        </div>
      ) : app.kind !== "app" ? (
        <p className="text-xs" style={muted}>
          Design systems attach to app projects.
        </p>
      ) : app.available.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-xs" style={muted}>
          No published design systems in this workspace yet. Create one from the Projects page.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Available design systems">
          {app.available.map((d) => (
            <li key={d.id} className="flex items-center justify-between rounded-xl border px-3 py-2" style={{ background: "var(--panel)" }}>
              <span>
                {d.name} <span className="text-xs" style={muted}>v{d.dsVersion}</span>
              </span>
              <button
                onClick={async () => {
                  const r = await act("attach", { designSystemId: d.id });
                  if (r) setMessage({ ok: true, text: `Attached ${r.name} v${r.version}. Its tokens are installed; set it up to restyle existing screens.` });
                }}
                disabled={!!busy}
                className="rounded-md px-2.5 py-1 text-xs font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                Attach
              </button>
            </li>
          ))}
        </ul>
      )}
      {!app.attached && (
        <div className="rounded-xl border p-3 text-xs" style={{ background: "var(--panel)" }}>
          <p className="font-medium">Turn this app&apos;s look into a design system</p>
          <p className="mt-0.5" style={muted}>
            Its colours, fonts and corner radius become a new published design system other projects can attach.
          </p>
          <button
            onClick={async () => {
              const r = await act("extract");
              if (r) setMessage({ ok: true, text: `Created a design system from this app (v${r.version}). Attach it below to keep this app in sync, or open it from Projects.` });
            }}
            disabled={!!busy}
            className="mt-2 rounded-md border px-2.5 py-1"
          >
            {busy === "extract" ? "Creating…" : "Create design system from this app"}
          </button>
        </div>
      )}
    </div>
  );
}
