"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDataChannel } from "@livekit/components-react";
import { ArrowUpRight, Circle, Download, Eraser, Minus, Pen, Square, Type, Undo2 } from "lucide-react";
import { meetApi } from "./api";
import type { Ctx } from "./Panels";

/**
 * The shared whiteboard. Items go out live over the data channel and are
 * saved by the server, so the board is still there on the notes page after
 * the meeting. Coordinates are 0..1 of a 16:9 board.
 */
export type BoardItem = {
  id: string; kind: "pen" | "rect" | "ellipse" | "line" | "arrow" | "text"; color: string; size: number; erase?: boolean;
  points?: number[]; x1?: number; y1?: number; x2?: number; y2?: number; x?: number; y?: number; text?: string; by?: string;
};
type Tool = BoardItem["kind"] | "eraser";

const COLORS = ["#111111", "#e5484d", "#2563eb", "#16a34a", "#d97706", "#7c3aed"];
const SIZES = [2, 4, 8];
const dec = new TextDecoder();

/** Draw items on a canvas of w×h (shared by the live board and the notes page). */
export function drawBoard(c: CanvasRenderingContext2D, items: BoardItem[], w: number, h: number) {
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, w, h);
  const k = w / 1600;
  for (const s of items) {
    c.strokeStyle = c.fillStyle = s.erase ? "#ffffff" : s.color;
    c.lineWidth = (s.erase ? s.size * 4 : s.size) * k;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    if (s.kind === "pen" && s.points) {
      for (let i = 0; i < s.points.length; i += 2) {
        const x = s.points[i] * w, y = s.points[i + 1] * h;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      if (s.points.length === 2) c.lineTo(s.points[0] * w + 0.1, s.points[1] * h);
      c.stroke();
    } else if (s.kind === "text" && s.text) {
      c.font = `${Math.round(Math.max(14, s.size * 7) * k)}px system-ui, sans-serif`;
      c.textBaseline = "top";
      c.fillText(s.text, (s.x ?? 0) * w, (s.y ?? 0) * h);
    } else if (s.x1 !== undefined) {
      const x1 = s.x1 * w, y1 = s.y1! * h, x2 = s.x2! * w, y2 = s.y2! * h;
      if (s.kind === "rect") c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      else if (s.kind === "ellipse") {
        c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
        c.stroke();
      } else {
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        if (s.kind === "arrow") {
          const a = Math.atan2(y2 - y1, x2 - x1), len = Math.max(12 * k, c.lineWidth * 4);
          c.moveTo(x2, y2);
          c.lineTo(x2 - len * Math.cos(a - Math.PI / 7), y2 - len * Math.sin(a - Math.PI / 7));
          c.moveTo(x2, y2);
          c.lineTo(x2 - len * Math.cos(a + Math.PI / 7), y2 - len * Math.sin(a + Math.PI / 7));
        }
        c.stroke();
      }
    }
  }
}

/** A PNG of the board (1920×1080). */
export function downloadBoard(items: BoardItem[], name: string) {
  const cv = document.createElement("canvas");
  cv.width = 1920;
  cv.height = 1080;
  drawBoard(cv.getContext("2d")!, items, cv.width, cv.height);
  cv.toBlob((b) => {
    if (!b) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `${name.replace(/[^\w.-]+/g, "_")}-whiteboard.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/png");
}

/** Read-only board (notes page). */
export function BoardView({ items }: { items: BoardItem[] }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const w = el.clientWidth || 800;
    el.width = Math.round(w * devicePixelRatio);
    el.height = Math.round(((w * 9) / 16) * devicePixelRatio);
    drawBoard(el.getContext("2d")!, items, el.width, el.height);
  }, [items]);
  return <canvas ref={cv} style={{ width: "100%", aspectRatio: "16 / 9", borderRadius: 10, border: "1px solid var(--ix-border, #ddd)", background: "#fff" }} aria-label="Whiteboard from the meeting" />;
}

export function Whiteboard({ ctx, onClose, canDraw = true, title = "meeting" }: { ctx: Ctx; onClose: () => void; canDraw?: boolean; title?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const items = useRef<BoardItem[]>([]);
  const cur = useRef<BoardItem | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(4);
  const [typing, setTyping] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const [text, setText] = useState("");
  const draw = useCallback(() => {
    const c = cv.current?.getContext("2d");
    if (!c || !cv.current) return;
    drawBoard(c, [...items.current, ...(cur.current ? [cur.current] : [])], cv.current.width, cv.current.height);
  }, []);
  useEffect(() => {
    meetApi<{ strokes: BoardItem[] }>(`/${ctx.code}/board`, { guest: ctx.guest }).then((d) => { items.current = d.strokes; draw(); }).catch(() => {});
    const fit = () => {
      const el = cv.current;
      if (!el?.parentElement) return;
      const r = el.parentElement.getBoundingClientRect();
      const w = Math.min(r.width, (r.height - 8) * (16 / 9));
      el.width = Math.round(w * devicePixelRatio);
      el.height = Math.round(((w * 9) / 16) * devicePixelRatio);
      el.style.width = `${w}px`;
      el.style.height = `${(w * 9) / 16}px`;
      draw();
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ctx.code, ctx.guest, draw]);
  const { send } = useDataChannel("iotx.board", (msg) => {
    let d: Record<string, any> = {};
    try {
      d = JSON.parse(dec.decode(msg.payload));
    } catch {}
    if ((d.type === "stroke" || d.type === "item") && (d.stroke || d.item)) {
      const it = (d.item ?? d.stroke) as BoardItem;
      if (!items.current.some((x) => x.id === it.id)) items.current.push({ ...it, kind: it.kind ?? "pen" });
    }
    if (d.type === "remove") items.current = items.current.filter((x) => x.id !== d.id);
    if (d.type === "clear") items.current = [];
    draw();
  });
  const commit = async (it: BoardItem) => {
    items.current.push({ ...it, by: ctx.identity });
    draw();
    await send(new TextEncoder().encode(JSON.stringify({ type: "item", item: it })), { reliable: true }).catch(() => {});
    await meetApi(`/${ctx.code}/board`, { body: { item: it }, guest: ctx.guest }).catch((e) => {
      items.current = items.current.filter((x) => x.id !== it.id);
      draw();
      ctx.toast((e as Error).message);
    });
  };
  const undo = async () => {
    try {
      const r = await meetApi<{ id: string | null }>(`/${ctx.code}/board`, { body: { action: "undo" }, guest: ctx.guest });
      if (r.id) {
        items.current = items.current.filter((x) => x.id !== r.id);
        draw();
      }
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !(e.target as HTMLElement).closest("input, textarea")) {
        e.preventDefault();
        void undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const pt = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const q = (v: number) => Math.min(1, Math.max(0, Math.round(v * 10000) / 10000));
    return [q((e.clientX - r.left) / r.width), q((e.clientY - r.top) / r.height)];
  };
  const down = (e: React.PointerEvent) => {
    if (!canDraw) return;
    const [x, y] = pt(e);
    if (tool === "text") {
      const r = cv.current!.getBoundingClientRect();
      setTyping({ x, y, left: e.clientX - r.left, top: e.clientY - r.top });
      setText("");
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const id = crypto.randomUUID();
    cur.current = tool === "pen" || tool === "eraser"
      ? { id, kind: "pen", color, size, points: [x, y], ...(tool === "eraser" ? { erase: true } : {}) }
      : { id, kind: tool, color, size, x1: x, y1: y, x2: x, y2: y };
  };
  const move = (e: React.PointerEvent) => {
    const c = cur.current;
    if (!c) return;
    const [x, y] = pt(e);
    if (c.kind === "pen") c.points!.push(x, y);
    else {
      c.x2 = x;
      c.y2 = y;
    }
    draw();
  };
  const up = () => {
    const c = cur.current;
    cur.current = null;
    if (!c) return;
    const tiny = c.kind === "pen" ? c.points!.length < 2 : Math.abs(c.x2! - c.x1!) + Math.abs(c.y2! - c.y1!) < 0.004;
    if (tiny) return draw();
    void commit(c);
  };
  const putText = () => {
    const t = text.trim();
    if (typing && t) void commit({ id: crypto.randomUUID(), kind: "text", color, size, x: typing.x, y: typing.y, text: t.slice(0, 300) });
    setTyping(null);
    setText("");
  };
  const tools: [Tool, React.ReactNode, string][] = [
    ["pen", <Pen key="p" size={16} />, "Pen"],
    ["line", <Minus key="l" size={16} />, "Line"],
    ["arrow", <ArrowUpRight key="a" size={16} />, "Arrow"],
    ["rect", <Square key="r" size={16} />, "Rectangle"],
    ["ellipse", <Circle key="e" size={16} />, "Ellipse"],
    ["text", <Type key="t" size={16} />, "Text"],
    ["eraser", <Eraser key="x" size={16} />, "Eraser"],
  ];
  return (
    <div className="mt-board">
      <div className="mt-board-bar">
        {canDraw && (
          <>
            {tools.map(([t, icon, label]) => (
              <button key={t} className={`mt-iconbtn${tool === t ? " on" : ""}`} onClick={() => setTool(t)} aria-label={label} title={label} aria-pressed={tool === t}>{icon}</button>
            ))}
            <span className="mt-board-sep" />
            {COLORS.map((c) => <button key={c} className={`mt-swatch${color === c && tool !== "eraser" ? " on" : ""}`} style={{ background: c }} onClick={() => { setColor(c); if (tool === "eraser") setTool("pen"); }} aria-label={`Colour ${c}`} />)}
            <span className="mt-board-sep" />
            {SIZES.map((s) => (
              <button key={s} className={`mt-iconbtn${size === s ? " on" : ""}`} onClick={() => setSize(s)} aria-label={`Size ${s}`} title={`Size ${s}`}>
                <span style={{ display: "block", width: s + 4, height: s + 4, borderRadius: "50%", background: "currentColor" }} />
              </button>
            ))}
            <span className="mt-board-sep" />
            <button className="mt-iconbtn" onClick={undo} aria-label="Undo" title="Undo my last (Ctrl+Z)"><Undo2 size={16} /></button>
            {ctx.hostLike && <button className="mt-btn sm" onClick={async () => { await meetApi(`/${ctx.code}/board`, { body: { action: "clear" }, guest: ctx.guest }).then(() => { items.current = []; draw(); }).catch((e) => ctx.toast(e.message)); }}>Clear</button>}
          </>
        )}
        {!canDraw && <span className="mt-note">Only people on stage can draw.</span>}
        <span style={{ flex: 1 }} />
        <button className="mt-iconbtn" onClick={() => downloadBoard(items.current, title)} aria-label="Download PNG" title="Download as PNG"><Download size={16} /></button>
        <button className="mt-btn sm" onClick={onClose}>Back to video</button>
      </div>
      <div className="mt-board-canvas" style={{ position: "relative" }}>
        <canvas ref={cv} style={{ touchAction: "none", cursor: canDraw ? (tool === "text" ? "text" : "crosshair") : "default" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="Whiteboard" />
        {typing && (
          <input
            className="mt-input mt-board-text"
            autoFocus
            value={text}
            maxLength={300}
            placeholder="Type, then Enter"
            style={{ position: "absolute", left: `calc(50% - ${(cv.current?.clientWidth ?? 0) / 2}px + ${typing.left}px)`, top: `calc(50% - ${(cv.current?.clientHeight ?? 0) / 2}px + ${typing.top}px)`, color }}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") putText(); if (e.key === "Escape") setTyping(null); }}
            onBlur={putText}
            aria-label="Text for the whiteboard"
          />
        )}
      </div>
    </div>
  );
}
