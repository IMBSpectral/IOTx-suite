"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Circle,
  Hammer,
  Hand,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import type { CanvasDoc, Shape } from "@/lib/canvas";

type Tool =
  "select" | "hand" | "draw" | "text" | "rect" | "ellipse" | "line" | "arrow";
const TOOLS: { id: Tool; label: string; icon: typeof Square; key: string }[] = [
  { id: "select", label: "Select", icon: MousePointer2, key: "v" },
  { id: "hand", label: "Hand", icon: Hand, key: "h" },
  { id: "draw", label: "Draw", icon: Pencil, key: "p" },
  { id: "text", label: "Text", icon: Type, key: "t" },
  { id: "rect", label: "Rectangle", icon: Square, key: "r" },
  { id: "ellipse", label: "Ellipse", icon: Circle, key: "o" },
  { id: "line", label: "Line", icon: Minus, key: "l" },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight, key: "a" },
];
const COLORS = [
  "#16141f",
  "#6d4aff",
  "#e5484d",
  "#16a34a",
  "#f59e0b",
  "#0ea5e9",
];
const uid = () => Math.random().toString(36).slice(2, 10);

function bounds(s: Shape) {
  if (s.type === "rect" || s.type === "ellipse")
    return { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.type === "line" || s.type === "arrow")
    return {
      x: Math.min(s.x, s.x2),
      y: Math.min(s.y, s.y2),
      w: Math.abs(s.x2 - s.x),
      h: Math.abs(s.y2 - s.y),
    };
  if (s.type === "draw") {
    const xs = s.points.map((p) => p[0]);
    const ys = s.points.map((p) => p[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }
  const t = s as Extract<Shape, { type: "text" }>;
  return {
    x: t.x,
    y: t.y - t.size,
    w: t.text.length * t.size * 0.55,
    h: t.size * 1.2,
  };
}

function moved(s: Shape, dx: number, dy: number): Shape {
  if (s.type === "line" || s.type === "arrow")
    return { ...s, x: s.x + dx, y: s.y + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  if (s.type === "draw")
    return {
      ...s,
      points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
    };
  return { ...s, x: s.x + dx, y: s.y + dy };
}

function ShapeEl({ s, selected }: { s: Shape; selected: boolean }) {
  const common = {
    stroke: s.stroke,
    strokeWidth: 2,
    fill: "none" as string,
    vectorEffect: "non-scaling-stroke" as const,
  };
  let el: React.ReactNode;
  if (s.type === "rect")
    el = (
      <rect
        x={s.x}
        y={s.y}
        width={s.w}
        height={s.h}
        rx={8}
        {...common}
        fill={s.fill}
      />
    );
  else if (s.type === "ellipse")
    el = (
      <ellipse
        cx={s.x + s.w / 2}
        cy={s.y + s.h / 2}
        rx={s.w / 2}
        ry={s.h / 2}
        {...common}
        fill={s.fill}
      />
    );
  else if (s.type === "line" || s.type === "arrow")
    el = (
      <line
        x1={s.x}
        y1={s.y}
        x2={s.x2}
        y2={s.y2}
        {...common}
        markerEnd={s.type === "arrow" ? "url(#forge-arrow)" : undefined}
      />
    );
  else if (s.type === "draw")
    el = (
      <polyline
        points={s.points.map((p) => p.join(",")).join(" ")}
        {...common}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  else {
    const t = s as Extract<Shape, { type: "text" }>;
    el = (
      <text
        x={t.x}
        y={t.y}
        fill={t.stroke}
        fontSize={t.size}
        fontFamily="ui-sans-serif, system-ui"
      >
        {t.text}
      </text>
    );
  }
  const b = bounds(s);
  const link = s.type === "rect" ? s.mockup : undefined;
  return (
    // Default ink follows the theme on screen (globals.css); exports keep it dark on white.
    <g
      data-id={s.id}
      data-ink={s.stroke.toLowerCase() === "#16141f" ? "default" : undefined}
    >
      {el}
      {link && (
        <text
          data-mockup-label
          x={b.x + 4}
          y={b.y - 6}
          fontSize={11}
          fill="#6d4aff"
          fontFamily="ui-monospace, monospace"
        >
          ⧉ {link.path}
        </text>
      )}
      {selected && (
        <rect
          x={b.x - 6}
          y={b.y - 6}
          width={b.w + 12}
          height={b.h + 12}
          fill="none"
          stroke="#6d4aff"
          strokeDasharray="4 4"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
}

/** Whiteboard for a canvas project: sketch screens and flows, then build from them. */
export default function CanvasEditor({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tool, setTool] = useState<Tool>("rect");
  const [color, setColor] = useState(COLORS[0]);
  const [selected, setSelected] = useState<string | null>(null);
  const [linking, setLinking] = useState<{
    apps: { id: string; name: string }[];
    projectId: string;
    files: string[];
    path: string;
  } | null>(null);
  const [sent, setSent] = useState<{ projectId: string; path: string } | null>(
    null,
  );
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [building, setBuilding] = useState(false);
  const history = useRef<Shape[][]>([]);
  const drag = useRef<{
    kind: "new" | "move" | "pan";
    id?: string;
    sx: number;
    sy: number;
    vx: number;
    vy: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/canvas`)
      .then((r) => (r.ok ? r.json() : { shapes: [] }))
      .then((d: CanvasDoc) => {
        if (!live) return;
        setShapes(d.shapes ?? []);
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  const save = useCallback(
    (next: Shape[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setStatus("saving");
      saveTimer.current = setTimeout(async () => {
        const res = await fetch(`/api/projects/${projectId}/canvas`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: 1, shapes: next }),
        }).catch(() => null);
        setStatus(res?.ok ? "saved" : "error");
      }, 1200);
    },
    [projectId],
  );

  function commit(next: Shape[]) {
    history.current = [...history.current.slice(-49), shapes];
    setShapes(next);
    save(next);
  }

  function undo() {
    const prev = history.current.pop();
    if (prev) {
      setShapes(prev);
      save(prev);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        commit(shapes.filter((s) => s.id !== selected));
        setSelected(null);
        return;
      }
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t && !e.ctrlKey && !e.metaKey) setTool(t.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Screen position → canvas coordinates. */
  function world(e: React.PointerEvent) {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - view.x) / view.zoom,
      y: (e.clientY - r.top - view.y) / view.zoom,
    };
  }

  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = world(e);
    if (tool === "hand" || e.button === 1) {
      drag.current = {
        kind: "pan",
        sx: e.clientX,
        sy: e.clientY,
        vx: view.x,
        vy: view.y,
      };
      return;
    }
    if (tool === "select") {
      const hitId =
        (e.target as Element).closest("g[data-id]")?.getAttribute("data-id") ??
        null;
      setSelected(hitId);
      if (hitId) {
        history.current = [...history.current.slice(-49), shapes];
        drag.current = {
          kind: "move",
          id: hitId,
          sx: p.x,
          sy: p.y,
          vx: 0,
          vy: 0,
        };
      }
      return;
    }
    if (tool === "text") {
      const text = prompt("Text");
      if (text?.trim())
        commit([
          ...shapes,
          {
            id: uid(),
            type: "text",
            x: p.x,
            y: p.y,
            text: text.trim(),
            size: 20,
            stroke: color,
          },
        ]);
      return;
    }
    const id = uid();
    const shape: Shape =
      tool === "draw"
        ? { id, type: "draw", points: [[p.x, p.y]], stroke: color }
        : tool === "line" || tool === "arrow"
          ? { id, type: tool, x: p.x, y: p.y, x2: p.x, y2: p.y, stroke: color }
          : {
              id,
              type: tool,
              x: p.x,
              y: p.y,
              w: 0,
              h: 0,
              stroke: color,
              fill: "none",
            };
    history.current = [...history.current.slice(-49), shapes];
    setShapes([...shapes, shape]);
    drag.current = { kind: "new", id, sx: p.x, sy: p.y, vx: 0, vy: 0 };
  }

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({
        ...v,
        x: d.vx + e.clientX - d.sx,
        y: d.vy + e.clientY - d.sy,
      }));
      return;
    }
    const p = world(e);
    setShapes((all) =>
      all.map((s) => {
        if (s.id !== d.id) return s;
        if (d.kind === "move") return moved(s, p.x - d.sx, p.y - d.sy);
        if (s.type === "draw")
          return {
            ...s,
            points: [...s.points, [p.x, p.y] as [number, number]],
          };
        if (s.type === "line" || s.type === "arrow")
          return { ...s, x2: p.x, y2: p.y };
        if (s.type === "rect" || s.type === "ellipse")
          return {
            ...s,
            x: Math.min(d.sx, p.x),
            y: Math.min(d.sy, p.y),
            w: Math.abs(p.x - d.sx),
            h: Math.abs(p.y - d.sy),
          };
        return s;
      }),
    );
    if (d.kind === "move") drag.current = { ...d, sx: p.x, sy: p.y };
  }

  function onUp() {
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind === "pan") return;
    // Drop shapes too small to mean anything (a click with a shape tool).
    const next = shapes.filter((s) => {
      if (s.id !== d.id || d.kind !== "new") return true;
      const b = bounds(s);
      return s.type === "draw" ? s.points.length > 2 : b.w + b.h > 6;
    });
    setShapes(next);
    save(next);
  }

  function zoomBy(f: number) {
    setView((v) => ({
      ...v,
      zoom: Math.min(4, Math.max(0.2, +(v.zoom * f).toFixed(2))),
    }));
  }

  /** Render the drawing (or one frame of it) to a PNG. */
  async function renderPng(region?: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) {
    const all = shapes.map(bounds);
    const pad = region ? 8 : 40;
    const minX = (region ? region.x : Math.min(...all.map((b) => b.x))) - pad;
    const minY = (region ? region.y : Math.min(...all.map((b) => b.y))) - pad;
    const w =
      (region ? region.x + region.w : Math.max(...all.map((b) => b.x + b.w))) -
      minX +
      pad;
    const h =
      (region ? region.y + region.h : Math.max(...all.map((b) => b.y + b.h))) -
      minY +
      pad;
    const clone = svgRef.current!.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("viewBox", `${minX} ${minY} ${w} ${h}`);
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    clone.querySelector("g[data-view]")?.removeAttribute("transform");
    clone
      .querySelectorAll("rect[stroke-dasharray], [data-mockup-label]")
      .forEach((n) => n.remove());
    const svg = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    await new Promise((ok, bad) => {
      img.onload = ok;
      img.onerror = bad;
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    const c = document.createElement("canvas");
    c.width = w * 2;
    c.height = h * 2;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) =>
      c.toBlob(r, "image/png"),
    );
    if (!blob) throw new Error("Couldn't render the canvas.");
    return blob;
  }

  /** Render the drawing to a PNG and start an app project from it. */
  async function buildThis() {
    if (!shapes.length) return;
    setBuilding(true);
    try {
      const blob = await renderPng();

      const created = await (
        await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `${projectName} app`, force: true }),
        })
      ).json();
      const pid = created.project.id as string;
      const form = new FormData();
      form.append(
        "file",
        new File([blob], "canvas-mockup.png", { type: "image/png" }),
      );
      const up = await (
        await fetch(`/api/projects/${pid}/uploads`, {
          method: "POST",
          body: form,
        })
      ).json();
      await fetch(`/api/projects/${pid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content:
            "Build this app from the attached canvas mockup. Follow its layout and flow, and turn the sketch into a polished, working design.",
          mode: "build",
          attachmentIds: up.attachments?.map((a: { id: string }) => a.id) ?? [],
        }),
      });
      router.push(`/projects/${pid}`);
    } catch {
      setBuilding(false);
      alert("Couldn't start a project from this canvas.");
    }
  }

  /** Link the selected frame to a component file in one of the workspace's apps. */
  async function startLink() {
    const list = await fetch("/api/projects?view=all")
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) =>
        (
          (d.projects ?? []) as { id: string; name: string; kind?: string }[]
        ).filter((p) => p.id !== projectId && (!p.kind || p.kind === "app")),
      );
    setLinking({ apps: list, projectId: "", files: [], path: "" });
  }
  async function pickApp(id: string) {
    const files = id
      ? await fetch(`/api/projects/${id}/files`)
          .then((r) => (r.ok ? r.json() : { files: [] }))
          .then((d) =>
            ((d.files ?? []) as string[]).filter(
              (f) =>
                /^src\/.*\.(tsx|jsx)$/.test(f) &&
                !f.startsWith("src/components/ui/") &&
                // Entry files aren't components.
                !/^src\/(main|index)\.(tsx|jsx)$/.test(f),
            ),
          )
      : [];
    setLinking((l) =>
      l
        ? {
            ...l,
            projectId: id,
            files,
            path:
              files.find((f) => /pages\/Index\./.test(f)) ??
              files.find((f) => f === "src/App.tsx") ??
              files[0] ??
              "",
          }
        : l,
    );
  }
  function saveLink() {
    if (!linking?.projectId || !linking.path || !sel || sel.type !== "rect")
      return;
    const mockup = { projectId: linking.projectId, path: linking.path };
    commit(
      shapes.map((s) =>
        s.id === sel.id && s.type === "rect" ? { ...s, mockup } : s,
      ),
    );
    setLinking(null);
  }
  /** Send this frame to the linked app's agent as the new look for that component. */
  async function updateComponent(frame: Extract<Shape, { w: number }>) {
    if (!frame.mockup) return;
    setSent(null);
    setBuilding(true);
    try {
      const blob = await renderPng(bounds(frame));
      const pid = frame.mockup.projectId;
      const form = new FormData();
      form.append(
        "file",
        new File([blob], "component-mockup.png", { type: "image/png" }),
      );
      const up = await (
        await fetch(`/api/projects/${pid}/uploads`, {
          method: "POST",
          body: form,
        })
      ).json();
      const res = await fetch(`/api/projects/${pid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: `Update ${frame.mockup.path} so it matches the attached mockup, a sketch of this component from my canvas "${projectName}". Follow its layout and content; keep the component's data, props and behaviour working, and keep the app's design system.`,
          mode: "build",
          attachmentIds: up.attachments?.map((a: { id: string }) => a.id) ?? [],
        }),
      });
      setSent(res.ok ? { projectId: pid, path: frame.mockup.path } : null);
      if (!res.ok)
        alert(
          (await res.json().catch(() => ({}))).error ??
            "Couldn't send the mockup.",
        );
    } catch {
      alert("Couldn't render this frame.");
    } finally {
      setBuilding(false);
    }
  }

  const sel = shapes.find((s) => s.id === selected);
  return (
    <div className="flex h-full flex-col">
      <div
        className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5"
        role="toolbar"
        aria-label="Canvas tools"
      >
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            aria-pressed={tool === t.id}
            aria-label={t.label}
            title={`${t.label} (${t.key.toUpperCase()})`}
            className={`rounded-md p-1.5 ${tool === t.id ? "bg-black/[.08] dark:bg-white/[.12]" : "hover:bg-black/[.04]"}`}
          >
            <t.icon className="h-4 w-4" />
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-black/10" />
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            aria-label={`Colour ${c}`}
            aria-pressed={color === c}
            className={`h-5 w-5 rounded-full border-2 ${color === c ? "border-[#6d4aff]" : "border-transparent"}`}
            style={{ background: c }}
          />
        ))}
        {sel && (sel.type === "rect" || sel.type === "ellipse") && (
          <button
            onClick={() =>
              commit(
                shapes.map((s) =>
                  s.id === sel.id && (s.type === "rect" || s.type === "ellipse")
                    ? { ...s, fill: s.fill === "none" ? `${color}22` : "none" }
                    : s,
                ),
              )
            }
            className="ml-1 rounded-md border px-2 py-0.5 text-xs"
          >
            {sel.fill === "none" ? "Fill" : "No fill"}
          </button>
        )}
        {sel?.type === "rect" && (
          <>
            <button
              onClick={() => void startLink()}
              className="ml-1 rounded-md border px-2 py-0.5 text-xs"
              title="Link this frame to a component in one of your apps"
            >
              {sel.mockup ? "Change link" : "Link to component"}
            </button>
            {sel.mockup && (
              <button
                onClick={() => void updateComponent(sel)}
                disabled={building}
                className="rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
                title={`Ask the app's agent to make ${sel.mockup.path} match this frame`}
              >
                Update component
              </button>
            )}
          </>
        )}
        {sel && (
          <button
            onClick={() => {
              commit(shapes.filter((s) => s.id !== sel.id));
              setSelected(null);
            }}
            aria-label="Delete shape"
            className="rounded-md p-1.5 text-red-500 hover:bg-red-500/[.08]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={undo}
          aria-label="Undo"
          className="rounded-md p-1.5 hover:bg-black/[.04]"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <span className="ml-auto flex items-center gap-1 text-xs">
          <span style={{ color: "var(--muted)" }}>
            {status === "saving"
              ? "Saving…"
              : status === "error"
                ? "Not saved"
                : "Saved"}
          </span>
          <button
            onClick={() => zoomBy(1 / 1.2)}
            aria-label="Zoom out"
            className="rounded-md p-1 hover:bg-black/[.04]"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setView({ x: 0, y: 0, zoom: 1 })}
            className="w-12 tabular-nums"
            aria-label="Reset zoom"
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <button
            onClick={() => zoomBy(1.2)}
            aria-label="Zoom in"
            className="rounded-md p-1 hover:bg-black/[.04]"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={buildThis}
            disabled={building || !shapes.length}
            className="ml-2 flex items-center gap-1 rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            <Hammer className="h-3.5 w-3.5" />{" "}
            {building ? "Starting…" : "Build this"}
          </button>
        </span>
      </div>
      {linking && (
        <div
          className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs"
          role="group"
          aria-label="Link frame to component"
        >
          <span style={{ color: "var(--muted)" }}>Link this frame to</span>
          <select
            aria-label="App"
            value={linking.projectId}
            onChange={(e) => void pickApp(e.target.value)}
            className="rounded-md border bg-transparent px-1.5 py-0.5"
          >
            <option value="">Choose an app…</option>
            {linking.apps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {linking.projectId && (
            <select
              aria-label="Component"
              value={linking.path}
              onChange={(e) => setLinking({ ...linking, path: e.target.value })}
              className="max-w-[260px] rounded-md border bg-transparent px-1.5 py-0.5 font-mono"
            >
              {linking.files.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={saveLink}
            disabled={!linking.path}
            className="rounded-md px-2 py-0.5 font-medium text-white disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            Link
          </button>
          <button
            onClick={() => setLinking(null)}
            style={{ color: "var(--muted)" }}
          >
            Cancel
          </button>
        </div>
      )}
      {sent && (
        <p className="border-b px-3 py-1.5 text-xs" role="status">
          Sent to the app&apos;s agent: it&apos;s updating{" "}
          <code>{sent.path}</code>.{" "}
          <a href={`/projects/${sent.projectId}`} className="underline">
            Open the app
          </a>
        </p>
      )}
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Canvas"
        className={`min-h-0 flex-1 touch-none bg-[radial-gradient(#d4d4d8_1px,transparent_1px)] [background-size:20px_20px] ${tool === "hand" ? "cursor-grab" : tool === "select" ? "cursor-default" : "cursor-crosshair"}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
          else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
        }}
      >
        <defs>
          <marker
            id="forge-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
          </marker>
        </defs>
        <g
          data-view
          transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}
        >
          {shapes.map((s) => (
            <ShapeEl key={s.id} s={s} selected={s.id === selected} />
          ))}
        </g>
        {loaded && shapes.length === 0 && (
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            fill="#a1a1aa"
            fontSize="14"
            fontFamily="ui-sans-serif, system-ui"
          >
            Sketch a screen or a flow, then press Build this.
          </text>
        )}
      </svg>
    </div>
  );
}
