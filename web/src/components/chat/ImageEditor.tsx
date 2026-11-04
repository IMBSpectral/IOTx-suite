"use client";

import { useEffect, useRef, useState } from "react";
import { Brush, Eraser, Loader2, MapPin, Paperclip, Scissors, Sparkles, X } from "lucide-react";
import type { Attachment } from "./types";

type Tool = "brush" | "unbrush" | "pin";
type Stroke = { erase: boolean; size: number; points: [number, number][] };
type Pin = { x: number; y: number; note: string };

/**
 * Edit a chat image with AI: brush over an area (and unbrush), pin notes
 * describing changes, then apply an instruction, erase what's brushed, or
 * remove the background. Results are new ".edit.png" attachments that can be
 * sent to the chat; the original stays as it was.
 */
export default function ImageEditor({
  projectId,
  attachment,
  src,
  onClose,
}: {
  projectId: string;
  attachment: Attachment;
  src: string;
  onClose: () => void;
}) {
  const img = useRef<HTMLImageElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [size, setSize] = useState(36);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Attachment | null>(null);
  const live = useRef<Stroke | null>(null);

  const imgRect = () => img.current!.getBoundingClientRect();

  function redraw(list: Stroke[]) {
    const c = overlay.current;
    const el = img.current;
    if (!c || !el) return;
    c.width = el.clientWidth;
    c.height = el.clientHeight;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of list) {
      ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
      ctx.strokeStyle = "rgba(109, 74, 255, 0.55)";
      ctx.lineWidth = s.size;
      ctx.beginPath();
      // Points are stored as fractions of the image, so the mask survives resizing.
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * c.width, y * c.height) : ctx.moveTo(x * c.width, y * c.height)));
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, onClose]);

  const at = (e: React.PointerEvent): [number, number] => {
    const r = imgRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  /** The mask at the image's natural size: opaque everywhere except what was brushed. */
  function maskDataUrl() {
    const el = img.current!;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    // Draw the brushed area first, then turn it into holes in a solid layer.
    const paint = document.createElement("canvas");
    paint.width = w;
    paint.height = h;
    const p = paint.getContext("2d")!;
    p.lineCap = "round";
    p.lineJoin = "round";
    const scale = w / el.clientWidth;
    for (const s of strokes) {
      p.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
      p.strokeStyle = "#000";
      p.lineWidth = s.size * scale;
      p.beginPath();
      s.points.forEach(([x, y], i) => (i ? p.lineTo(x * w, y * h) : p.moveTo(x * w, y * h)));
      p.stroke();
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(paint, 0, 0);
    return c.toDataURL("image/png");
  }

  async function run(mode: "edit" | "erase" | "remove_bg") {
    setBusy(mode);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/image-edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadId: attachment.id,
          mode,
          prompt,
          pins,
          mask: strokes.length && mode !== "remove_bg" ? maskDataUrl() : undefined,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "The edit failed.");
      setResult(d.attachment);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The edit failed.");
    } finally {
      setBusy(null);
    }
  }

  const base = src.replace(/\/[^/]+$/, "");
  const shown = result ? `${base}/${result.id}` : src;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-label="Edit image">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border shadow-2xl" style={{ background: "var(--panel)" }}>
        <div className="flex h-11 items-center justify-between border-b px-3 text-sm">
          <span className="truncate font-medium">{result ? result.name : attachment.name}</span>
          <button onClick={onClose} disabled={!!busy} aria-label="Close" className="rounded p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!result && (
          <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5 text-xs">
            <ToolButton active={tool === "brush"} onClick={() => setTool("brush")} label="Brush the area to change">
              <Brush className="h-4 w-4" />
            </ToolButton>
            <ToolButton active={tool === "unbrush"} onClick={() => setTool("unbrush")} label="Unbrush">
              <Eraser className="h-4 w-4" />
            </ToolButton>
            <ToolButton active={tool === "pin"} onClick={() => setTool("pin")} label="Pin a note">
              <MapPin className="h-4 w-4" />
            </ToolButton>
            <label className="ml-2 flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
              Size
              <input type="range" min={8} max={120} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Brush size" />
            </label>
            <button onClick={() => setStrokes([])} disabled={!strokes.length} className="ml-auto rounded-md border px-2 py-0.5 disabled:opacity-40">
              Clear mask
            </button>
          </div>
        )}

        <div className="relative grid min-h-0 flex-1 place-items-center overflow-auto p-4" style={{ background: "repeating-conic-gradient(#8881 0% 25%, transparent 0% 50%) 50% / 20px 20px" }}>
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={img} src={shown} alt={attachment.name} onLoad={() => redraw(strokes)} className="block max-h-[60vh] max-w-full select-none" draggable={false} />
            {!result && (
              <canvas
                ref={overlay}
                className={`absolute inset-0 h-full w-full touch-none ${tool === "pin" ? "cursor-copy" : "cursor-crosshair"}`}
                onPointerDown={(e) => {
                  if (busy) return;
                  if (tool === "pin") {
                    const [x, y] = at(e);
                    setPins((p) => [...p, { x, y, note: "" }]);
                    return;
                  }
                  e.currentTarget.setPointerCapture(e.pointerId);
                  live.current = { erase: tool === "unbrush", size, points: [at(e)] };
                }}
                onPointerMove={(e) => {
                  if (!live.current) return;
                  live.current.points.push(at(e));
                  redraw([...strokes, live.current]);
                }}
                onPointerUp={() => {
                  const s = live.current;
                  live.current = null;
                  if (s) setStrokes((cur) => [...cur, s]);
                }}
              />
            )}
            {!result &&
              pins.map((p, i) => (
                <span
                  key={i}
                  className="pointer-events-none absolute grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[#6d4aff] text-[10px] font-bold text-white shadow"
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                >
                  {i + 1}
                </span>
              ))}
          </div>
          {busy && (
            <div className="absolute inset-0 grid place-items-center bg-black/30 text-sm text-white">
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> {busy === "remove_bg" ? "Removing the background…" : busy === "erase" ? "Erasing…" : "Editing…"}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-2 border-t p-3 text-xs">
          {result ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto" style={{ color: "var(--muted)" }}>Saved as a new file; the original is unchanged.</span>
              <button onClick={() => setResult(null)} className="rounded-lg border px-3 py-1.5">
                Back to the original
              </button>
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("forge:preattach", { detail: result }));
                  onClose();
                }}
                className="btn-primary flex items-center gap-1 rounded-lg px-3 py-1.5"
              >
                <Paperclip className="h-3.5 w-3.5" /> Attach to chat
              </button>
            </div>
          ) : (
            <>
              {pins.length > 0 && (
                <ol className="space-y-1">
                  {pins.map((p, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#6d4aff] text-[9px] font-bold text-white">{i + 1}</span>
                      <input
                        value={p.note}
                        onChange={(e) => setPins((cur) => cur.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                        placeholder="What should change here?"
                        aria-label={`Note for pin ${i + 1}`}
                        className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1"
                        autoFocus={!p.note}
                      />
                      <button onClick={() => setPins((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove pin ${i + 1}`} className="rounded p-0.5 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <div className="flex flex-wrap gap-2">
                <input
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={strokes.length ? "What should the brushed area become?" : "Describe the change"}
                  aria-label="Edit instruction"
                  className="min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 py-1.5"
                  onKeyDown={(e) => e.key === "Enter" && !busy && void run("edit")}
                />
                <button onClick={() => run("edit")} disabled={!!busy || (!prompt.trim() && !pins.some((p) => p.note.trim()))} className="btn-primary flex items-center gap-1 rounded-lg px-3 disabled:opacity-50">
                  <Sparkles className="h-3.5 w-3.5" /> Apply
                </button>
                <button onClick={() => run("erase")} disabled={!!busy || !strokes.length} title="Remove what's brushed" className="flex items-center gap-1 rounded-lg border px-3 disabled:opacity-40">
                  <Eraser className="h-3.5 w-3.5" /> Erase
                </button>
                <button onClick={() => run("remove_bg")} disabled={!!busy} className="flex items-center gap-1 rounded-lg border px-3 disabled:opacity-40">
                  <Scissors className="h-3.5 w-3.5" /> Remove background
                </button>
              </div>
              <p style={{ color: "var(--muted)" }}>Each edit uses about 1 credit. Brush to limit a change to one area.</p>
            </>
          )}
          {error && (
            <p role="alert" className="text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`rounded-lg p-1.5 ${active ? "bg-[var(--accent-soft)]" : "hover:bg-black/[.05] dark:hover:bg-white/[.06]"}`}
    >
      {children}
    </button>
  );
}
