"use client";

import { useEffect, useRef, useState } from "react";
import { useEscape } from "../useEscape";
import { Undo2, X } from "lucide-react";

const COLORS = ["#ef4444", "#6d4aff", "#16a34a", "#111827"];

/**
 * Draw on an uploaded image to point at what should change. Saving produces
 * a new PNG attachment (the original stays untouched) with the marks on it.
 */
export default function AnnotateDialog({
  src,
  name,
  onSave,
  onClose,
}: {
  src: string;
  name: string;
  onSave: (file: File) => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEscape(onClose);
  const [color, setColor] = useState(COLORS[0]);
  const [strokes, setStrokes] = useState<{ color: string; points: [number, number][] }[]>([]);
  const drawing = useRef(false);

  useEffect(() => {
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = src;
  }, [src]);

  // Redraw the image and every stroke whenever either changes.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !img) return;
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, Math.round(img.naturalWidth / 200));
    for (const s of strokes) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }, [img, strokes]);

  function point(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * e.currentTarget.width, ((e.clientY - r.top) / r.height) * e.currentTarget.height];
  }

  function save() {
    canvasRef.current?.toBlob((blob) => {
      if (blob) onSave(new File([blob], name.replace(/\.[a-z0-9]+$/i, "") + "-annotated.png", { type: "image/png" }));
    }, "image/png");
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-4" role="dialog" aria-label="Annotate image">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-white">
        <span>Draw on the image to show what to change</span>
        <span className="flex items-center gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
              className={`h-5 w-5 rounded-full border-2 ${color === c ? "border-white" : "border-transparent"}`}
              style={{ background: c }}
            />
          ))}
          <button onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length} className="flex items-center gap-1 rounded-md border border-white/30 px-2 py-1 text-xs disabled:opacity-40">
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </button>
          <button onClick={save} disabled={!strokes.length} className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black disabled:opacity-40">
            Attach annotated image
          </button>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1">
            <X className="h-4 w-4" />
          </button>
        </span>
      </div>
      <div className="mt-3 grid min-h-0 flex-1 place-items-center">
        <canvas
          ref={canvasRef}
          aria-label="Image to annotate"
          className="max-h-[calc(100vh-5rem)] max-w-full cursor-crosshair touch-none bg-white object-contain"
          onPointerDown={(e) => {
            drawing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            // Read the event now: React clears currentTarget before the updater runs.
            const start = point(e);
            setStrokes((s) => [...s, { color, points: [start] }]);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const p = point(e);
            setStrokes((s) => {
              const last = s[s.length - 1];
              return [...s.slice(0, -1), { ...last, points: [...last.points, p] }];
            });
          }}
          onPointerUp={() => (drawing.current = false)}
        />
      </div>
    </div>
  );
}
