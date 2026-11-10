"use client";

import { useEffect, useRef } from "react";
import type { ECharts } from "echarts";
import { buildOption, label, type Data, type Theme, type Widget } from "./chart-options";

/** The suite's colours for charts, read from CSS so light and dark both work. */
export function readTheme(el?: HTMLElement | null): Theme {
  const s = getComputedStyle(el ?? document.documentElement);
  const v = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
  const panel = v("--ix-panel", "#ffffff");
  const dark = (() => {
    const m = /#([0-9a-f]{6})/i.exec(panel);
    if (!m) return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const n = parseInt(m[1], 16);
    return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 128;
  })();
  return { ink: v("--ix-ink", "#111827"), muted: v("--ix-muted", "#6b7280"), line: v("--ix-line", "#e5e7eb"), panel, accent: v("--accent", "#6366f1"), dark };
}

type Props = { w: Widget; data: Data; height: number; onPick?: (value: string) => void; chartRef?: (c: ECharts | null) => void };

/** One ECharts chart: built from the board item, resized with its box, clicks reported as the category picked. */
export default function Chart({ w, data, height, onPick, chartRef }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const latest = useRef({ w, data });
  latest.current = { w, data };

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    void import("echarts").then((echarts) => {
      if (disposed || !box.current) return;
      const c = echarts.init(box.current, undefined, { renderer: "canvas" });
      chart.current = c;
      chartRef?.(c);
      c.on("click", (p) => {
        const e = p as { name?: string; value?: unknown; componentSubType?: string; treePathInfo?: { name: string }[] };
        let v: string | undefined;
        if (e.componentSubType === "heatmap" && Array.isArray(e.value)) {
          const { w, data } = latest.current;
          const xs = [...new Set(data.rows.map((r) => label(r[Math.max(0, data.columns.findIndex((x) => x.name === w.x))])))];
          v = xs[Number(e.value[0])];
        } else if (e.componentSubType === "treemap" && e.treePathInfo && e.treePathInfo.length > 1) v = e.treePathInfo[1].name;
        else v = e.name;
        if (v !== undefined && v !== "") pick.current?.(v);
      });
      ro = new ResizeObserver(() => c.resize());
      ro.observe(box.current);
      c.setOption(buildOption(w, data, readTheme(box.current)), true);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.dispose();
      chart.current = null;
      chartRef?.(null);
    };
    // The chart is made once; updates below set its option.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (chart.current && box.current) chart.current.setOption(buildOption(w, data, readTheme(box.current)), true);
  }, [w, data]);

  return <div ref={box} style={{ width: "100%", height, cursor: onPick ? "pointer" : undefined }} />;
}
