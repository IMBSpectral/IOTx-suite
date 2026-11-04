"use client";

import { useEffect, useRef, useState } from "react";
import { Eraser, Paperclip, Undo2, X } from "lucide-react";
import type { Attachment } from "./chat/types";

type Stroke = { color: string; width: number; points: [number, number][] };

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111827"];

/**
 * Draw on top of the preview, then attach the sketch to the chat. Forge asks
 * the browser for a capture of this tab so the drawing lands on the real
 * page; if that's declined, the sketch is sent on its own.
 */
export default function DrawOverlay({
  projectId,
  onAttach,
  onClose,
}: {
  projectId: string;
  onAttach: (a: Attachment) => void;
  onClose: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState(COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<Stroke | null>(null);

  function paint(ctx: CanvasRenderingContext2D, list: Stroke[], scale = 1) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of list) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * scale;
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * scale, y * scale) : ctx.moveTo(x * scale, y * scale)));
      ctx.stroke();
    }
  }

  function redraw(list: Stroke[]) {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    paint(ctx, list, dpr);
  }

  useEffect(() => {
    const c = canvas.current;
    const w = wrap.current;
    if (!c || !w) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = w.clientWidth * dpr;
      c.height = w.clientHeight * dpr;
      redraw(strokes);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(w);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    redraw(strokes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "z" && (e.ctrlKey || e.metaKey)) setStrokes((s) => s.slice(0, -1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const point = (e: React.PointerEvent): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function finish() {
    const s = live.current;
    live.current = null;
    if (s && s.points.length > 1) setStrokes((cur) => [...cur, s]);
  }

  /** The page under the drawing, via the browser's tab capture, cropped to the preview. */
  async function captureBackground(rect: DOMRect): Promise<HTMLCanvasElement | null> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        preferCurrentTab: true,
      } as DisplayMediaStreamOptions);
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 250));
      const sx = video.videoWidth / window.innerWidth;
      const sy = video.videoHeight / window.innerHeight;
      const out = document.createElement("canvas");
      out.width = Math.round(rect.width * sx);
      out.height = Math.round(rect.height * sy);
      out.getContext("2d")!.drawImage(video, rect.left * sx, rect.top * sy, rect.width * sx, rect.height * sy, 0, 0, out.width, out.height);
      stream.getTracks().forEach((t) => t.stop());
      return out;
    } catch {
      return null;
    }
  }

  async function attach() {
    if (!strokes.length || !wrap.current) return;
    setBusy(true);
    setError(null);
    const rect = wrap.current.getBoundingClientRect();
    // Hide the toolbar so it isn't in the capture.
    wrap.current.dataset.capturing = "1";
    const bg = await captureBackground(rect);
    delete wrap.current.dataset.capturing;
    const out = document.createElement("canvas");
    const scale = bg ? bg.width / rect.width : window.devicePixelRatio || 1;
    out.width = bg ? bg.width : Math.round(rect.width * scale);
    out.height = bg ? bg.height : Math.round(rect.height * scale);
    const ctx = out.getContext("2d")!;
    if (bg) ctx.drawImage(bg, 0, 0);
    else {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, out.width, out.height);
    }
    paint(ctx, strokes, scale);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
    if (!blob) {
      setBusy(false);
      return setError("Couldn't save the drawing.");
    }
    const form = new FormData();
    form.append("file", new File([blob], `Drawing ${new Date().toLocaleTimeString()}.png`, { type: "image/png" }));
    try {
      const res = await fetch(`/api/projects/${projectId}/uploads`, { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Upload failed");
      onAttach(body.attachments[0]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrap} className="group/draw absolute inset-0 z-30 cursor-crosshair touch-none" aria-label="Drawing on the preview">
      <canvas
        ref={canvas}
        className="absolute inset-0 h-full w-full"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          live.current = { color, width: 4, points: [point(e)] };
        }}
        onPointerMove={(e) => {
          if (!live.current) return;
          live.current.points.push(point(e));
          redraw([...strokes, live.current]);
        }}
        onPointerUp={finish}
        onLostPointerCapture={finish}
      />
      <div
        role="toolbar"
        aria-label="Drawing tools"
        className="absolute left-1/2 top-3 flex -translate-x-1/2 cursor-default items-center gap-1 rounded-xl border p-1 shadow-lg group-data-[capturing]/draw:hidden"
        style={{ background: "var(--panel)" }}
      >
        {COLORS.map((c) => (
          <button
            key={c}
            aria-label={`Pen colour ${c}`}
            aria-pressed={color === c}
            onClick={() => setColor(c)}
            className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-[var(--text)]" : "border-transparent"}`}
            style={{ background: c }}
          />
        ))}
        <span className="mx-1 h-5 w-px bg-black/10 dark:bg-white/10" />
        <button aria-label="Undo" onClick={() => setStrokes((s) => s.slice(0, -1))} className="rounded-lg p-1.5 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
          <Undo2 className="h-4 w-4" />
        </button>
        <button aria-label="Clear drawing" onClick={() => setStrokes([])} className="rounded-lg p-1.5 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
          <Eraser className="h-4 w-4" />
        </button>
        <button
          onClick={() => void attach()}
          disabled={!strokes.length || busy}
          className="btn-primary ml-1 flex h-7 items-center gap-1 rounded-lg px-2.5 text-[12px] disabled:opacity-50"
        >
          <Paperclip className="h-3.5 w-3.5" /> {busy ? "Attaching…" : "Attach to chat"}
        </button>
        <button aria-label="Stop drawing" onClick={onClose} className="rounded-lg p-1.5 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
          <X className="h-4 w-4" />
        </button>
      </div>
      {error && (
        <p role="alert" className="absolute left-1/2 top-14 -translate-x-1/2 rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white">
          {error}
        </p>
      )}
    </div>
  );
}
