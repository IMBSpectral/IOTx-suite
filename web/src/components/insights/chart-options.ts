/**
 * Insights: a board item + its query result -> an ECharts option.
 * Plain functions (no React) so every chart kind is built the same way.
 */
import type { EChartsOption } from "echarts";

export type Col = { name: string; type: string };
export type Data = { columns: Col[]; rows: unknown[][] };
export type Widget = {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  insight?: string;
  sql?: string;
  x?: string;
  y?: string[];
  series?: string;
  size?: number;
  filter?: string;
  tone?: "good" | "bad" | "neutral" | "watch";
  format?: "number" | "percent" | "currency" | "duration";
  unit?: string;
  options?: Record<string, unknown>;
};
export type Theme = { ink: string; muted: string; line: string; panel: string; accent: string; dark: boolean };

export const PALETTE = ["#6366f1", "#06b6d4", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#64748b", "#84cc16", "#0ea5e9"];

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL.*)$/i;
export const isNumType = (t: string) => NUMERIC.test(t);

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** A number as people read it: 12.4K, 38%, ₹1.2M, 3.5 hrs. */
export function fmt(v: unknown, w?: Pick<Widget, "format" | "unit">, long = false): string {
  if (v === null || v === undefined || v === "") return "–";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const f = w?.format;
  if (f === "percent") return `${(n * 100).toFixed(Math.abs(n) < 0.1 ? 1 : 0)}%`;
  const body = long || Math.abs(n) < 10_000 ? full.format(Math.abs(n) < 10 && !Number.isInteger(n) ? +n.toFixed(2) : n) : compact.format(n);
  const unit = w?.unit ?? "";
  if (f === "currency" || /^[₹$€£¥]$/.test(unit)) return `${n < 0 ? "-" : ""}${unit || ""}${body.replace(/^-/, "")}`;
  return unit ? `${body} ${unit}` : body;
}

/** A cell value for an axis label: dates shortened, long text clipped. */
export function label(v: unknown) {
  if (v === null || v === undefined) return "(blank)";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}( 00:00:00)?$/.test(s)) return s.slice(0, 10);
  return s;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Axis labels for dates: "Jan 2025" when every date is the 1st of a month, "12 Jan" within one year, else as is. */
function dateLabeler(cats: string[]) {
  if (!cats.length || !cats.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c))) return (v: string) => v;
  if (cats.every((c) => c.endsWith("-01"))) return (v: string) => `${MONTHS[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}`;
  const oneYear = new Set(cats.map((c) => c.slice(0, 4))).size === 1;
  return (v: string) => (oneYear ? `${Number(v.slice(8, 10))} ${MONTHS[Number(v.slice(5, 7)) - 1]}` : v);
}

/** Columns holding codes rather than quantities (employee codes, phone and account numbers, years). */
export const isIdName = (name: string) => /(^|\b|_)(id|code|no\.?|number|num|phone|mobile|account|a\/c|pin|zip|year|uan|esic|pan|aadhaar|adhaar|s\.?\s?no\.?|sr\.?\s?no\.?|sl\.?\s?no\.?)(\b|_|$)/i.test(name);

function idx(d: Data, name?: string) {
  if (!name) return -1;
  return d.columns.findIndex((c) => c.name === name);
}

/** Measures to plot: the y columns, or every numeric column but x and series. */
function measures(d: Data, w: Widget) {
  const ys = (w.y ?? []).filter((y) => idx(d, y) >= 0);
  if (ys.length) return ys;
  return d.columns.filter((c) => c.name !== w.x && c.name !== w.series && isNumType(c.type)).map((c) => c.name);
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export function buildOption(w: Widget, d: Data, t: Theme): EChartsOption {
  const kind = w.kind;
  const xi = idx(d, w.x) >= 0 ? idx(d, w.x) : 0;
  const si = idx(d, w.series);
  const ys = measures(d, w);
  const o = w.options ?? {};
  const axisText = { color: t.muted, fontSize: 11 };
  const split = { lineStyle: { color: t.line, type: "dashed" as const } };
  const tooltipBase = {
    backgroundColor: t.panel,
    borderColor: t.line,
    textStyle: { color: t.ink, fontSize: 12 },
    extraCssText: "box-shadow:0 8px 24px rgba(0,0,0,.12);border-radius:10px;",
    valueFormatter: (v: unknown) => fmt(v, w, true),
  };
  const base: EChartsOption = {
    color: PALETTE,
    textStyle: { fontFamily: "inherit" },
    animationDuration: 500,
    tooltip: { ...tooltipBase, trigger: "item" },
  };
  const legend = (show: boolean) => (show ? { legend: { type: "scroll" as const, top: 0, textStyle: { color: t.muted, fontSize: 11 }, icon: "roundRect", itemWidth: 10, itemHeight: 10 } } : {});
  const grid = (top = 28, right = 16) => ({ grid: { left: 8, right, top, bottom: 8, containLabel: true } });

  // ---- Category charts: bar, hbar, stacked, line, area, combo, histogram -------------
  if (["bar", "hbar", "stacked", "line", "area", "combo", "histogram"].includes(kind)) {
    const cats = uniq(d.rows.map((r) => label(r[xi])));
    const xType = d.columns[xi]?.type ?? "";
    const timey = /DATE|TIME/i.test(xType) || kind === "line" || kind === "area";
    let series: { name: string; data: (number | null)[] }[];
    if (si >= 0 && ys.length) {
      const names = uniq(d.rows.map((r) => label(r[si])));
      const yi = idx(d, ys[0]);
      series = names.map((n) => {
        const m = new Map(d.rows.filter((r) => label(r[si]) === n).map((r) => [label(r[xi]), num(r[yi])]));
        return { name: n, data: cats.map((c) => m.get(c) ?? null) };
      });
    } else {
      series = ys.map((y) => {
        const yi = idx(d, y);
        const m = new Map(d.rows.map((r) => [label(r[xi]), num(r[yi])]));
        return { name: y, data: cats.map((c) => m.get(c) ?? null) };
      });
    }
    const horizontal = kind === "hbar";
    const stack = kind === "stacked" || o.stack === true || (kind === "area" && series.length > 1 && o.stack !== false);
    const many = cats.length > 24;
    const dl = dateLabeler(cats);
    const catAxis = {
      type: "category" as const,
      data: horizontal ? [...cats].reverse() : cats,
      axisLabel: { ...axisText, formatter: (v: string) => dl(v), hideOverlap: true, width: horizontal ? 140 : 90, overflow: "truncate" as const, rotate: !horizontal && !timey && cats.length > 8 ? 30 : 0 },
      axisLine: { lineStyle: { color: t.line } },
      axisTick: { show: false },
      boundaryGap: kind === "line" || kind === "area" ? false : true,
    };
    const valAxis = (i = 0) => ({
      type: "value" as const,
      axisLabel: { ...axisText, formatter: (v: number) => fmt(v, i === 1 && kind === "combo" ? { format: undefined } : w) },
      splitLine: i === 0 ? split : { show: false },
      scale: kind === "line" && o.zero !== true,
    });
    const s = series.map((sr, i) => {
      const isLine = kind === "line" || kind === "area" || (kind === "combo" && i > 0);
      return {
        name: sr.name,
        type: isLine ? ("line" as const) : ("bar" as const),
        data: horizontal ? [...sr.data].reverse() : sr.data,
        yAxisIndex: kind === "combo" && i > 0 ? 1 : 0,
        stack: stack && !isLine ? "s" : stack && kind === "area" ? "s" : undefined,
        smooth: isLine && o.smooth !== false ? 0.25 : undefined,
        showSymbol: isLine && cats.length <= 40,
        symbolSize: 6,
        areaStyle: kind === "area" ? { opacity: series.length > 1 ? 0.55 : 0.18 } : undefined,
        lineStyle: isLine ? { width: 2.5 } : undefined,
        barMaxWidth: 44,
        barCategoryGap: kind === "histogram" ? "4%" : undefined,
        itemStyle: !isLine ? { borderRadius: horizontal ? [0, 6, 6, 0] : stack ? 0 : [6, 6, 0, 0] } : undefined,
        emphasis: { focus: "series" as const },
        label:
          !isLine && cats.length <= 12 && series.length === 1
            ? { show: true, position: horizontal ? ("right" as const) : ("top" as const), color: t.muted, fontSize: 11, formatter: (p: { value: unknown }) => fmt(p.value, w) }
            : undefined,
        markLine:
          o.average === true && i === 0
            ? { symbol: "none", label: { color: t.muted, formatter: (p: { value: unknown }) => `avg ${fmt(p.value, w)}` }, lineStyle: { color: t.muted, type: "dashed" as const }, data: [{ type: "average" as const }] }
            : undefined,
      };
    });
    return {
      ...base,
      ...legend(series.length > 1),
      ...grid(series.length > 1 ? 30 : 14, kind === "combo" ? 8 : 16),
      tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: kind === "line" || kind === "area" ? "line" : "shadow" } },
      xAxis: horizontal ? valAxis() : catAxis,
      yAxis: horizontal ? catAxis : kind === "combo" ? [valAxis(0), valAxis(1)] : valAxis(),
      dataZoom: (timey && cats.length > 20) || many ? [{ type: "inside" }, { type: "slider", height: 18, bottom: 0, borderColor: "transparent", textStyle: axisText }] : undefined,
      series: s,
      ...(timey && cats.length > 20 ? { grid: { left: 8, right: 16, top: series.length > 1 ? 30 : 14, bottom: 30, containLabel: true } } : {}),
    } as EChartsOption;
  }

  // ---- Forecast: history, forecast and 80% / 95% ranges ----------------------------------
  if (kind === "forecast") {
    const cats = d.rows.map((r) => label(r[0]));
    const col = (i: number) => d.rows.map((r) => num(r[i]));
    const [act, fc, lo80, hi80, lo95, hi95] = [1, 2, 3, 4, 5, 6].map(col);
    const diff = (hi: (number | null)[], lo: (number | null)[]) => hi.map((h, i) => (h === null || lo[i] === null ? null : h - lo[i]!));
    const dl = dateLabeler(cats);
    const firstFc = d.rows.findIndex((r) => r[1] === null);
    const band = (name: string, lo: (number | null)[], width: (number | null)[], opacity: number, stack: string) => [
      { name: `${name} low`, type: "line" as const, data: lo, stack, lineStyle: { opacity: 0 }, symbol: "none", silent: true, tooltip: { show: false } },
      { name, type: "line" as const, data: width, stack, lineStyle: { opacity: 0 }, symbol: "none", itemStyle: { color: t.accent, opacity: opacity * 3 }, areaStyle: { color: t.accent, opacity }, silent: true, tooltip: { show: false } },
    ];
    return {
      ...base,
      legend: { top: 0, textStyle: { color: t.muted, fontSize: 11 }, data: [d.columns[1].name, "Forecast", "80% range", "95% range"], icon: "roundRect", itemWidth: 10, itemHeight: 10 },
      grid: { left: 8, right: 16, top: 30, bottom: cats.length > 30 ? 30 : 8, containLabel: true },
      tooltip: {
        ...tooltipBase,
        trigger: "axis",
        formatter: (ps: unknown) => {
          const i = (ps as { dataIndex: number }[])[0]?.dataIndex ?? 0;
          const r = d.rows[i];
          const v = (k: number) => fmt(r[k], w, true);
          return r[1] !== null
            ? `${dl(String(r[0]))}<br/><b>${v(1)}</b>`
            : `${dl(String(r[0]))} (forecast)<br/><b>${v(2)}</b><br/><span style="opacity:.7">80%: ${v(3)} – ${v(4)}<br/>95%: ${v(5)} – ${v(6)}</span>`;
        },
      },
      xAxis: { type: "category", data: cats, boundaryGap: false, axisLabel: { ...axisText, formatter: (v: string) => dl(v), hideOverlap: true }, axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false } },
      yAxis: { type: "value", scale: true, axisLabel: { ...axisText, formatter: (v: number) => fmt(v, w) }, splitLine: split },
      dataZoom: cats.length > 30 ? [{ type: "inside" }, { type: "slider", height: 18, bottom: 0, borderColor: "transparent", textStyle: axisText }] : undefined,
      series: [
        ...band("95% range", lo95, diff(hi95, lo95), 0.1, "b95"),
        ...band("80% range", lo80, diff(hi80, lo80), 0.18, "b80"),
        {
          name: d.columns[1].name,
          type: "line",
          data: act,
          symbolSize: 5,
          showSymbol: cats.length <= 40,
          lineStyle: { width: 2.5, color: t.ink },
          itemStyle: { color: t.ink },
          markLine: firstFc > 0 ? { symbol: "none", silent: true, label: { formatter: "Forecast →", color: t.muted, position: "insideEndTop" }, lineStyle: { color: t.muted, type: "dashed" }, data: [{ xAxis: firstFc - 1 }] } : undefined,
        },
        { name: "Forecast", type: "line", data: fc, symbolSize: 5, showSymbol: cats.length <= 40, lineStyle: { width: 2.5, type: "dashed", color: t.accent }, itemStyle: { color: t.accent } },
      ],
    } as EChartsOption;
  }

  // ---- Key drivers: importance of each factor ----------------------------------------------
  if (kind === "drivers") {
    const rows = [...d.rows].reverse();
    return {
      ...base,
      grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
      tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow" }, formatter: (ps: unknown) => {
        const i = (ps as { dataIndex: number }[])[0]?.dataIndex ?? 0;
        const r = rows[i];
        return `<b>${r[0]}</b>: ${(Number(r[1]) * 100).toFixed(1)}% of what the model explains<br/><span style="opacity:.75">${r[2]}</span>`;
      } },
      xAxis: { type: "value", max: 1, axisLabel: { ...axisText, formatter: (v: number) => `${Math.round(v * 100)}%` }, splitLine: split },
      yAxis: { type: "category", data: rows.map((r) => String(r[0])), axisLabel: { ...axisText, width: 150, overflow: "truncate" }, axisTick: { show: false }, axisLine: { show: false } },
      series: [
        {
          type: "bar",
          data: rows.map((r, i) => ({ value: Number(r[1]), itemStyle: { color: PALETTE[(rows.length - 1 - i) % PALETTE.length] } })),
          barMaxWidth: 26,
          itemStyle: { borderRadius: [0, 6, 6, 0] },
          label: { show: true, position: "right", color: t.muted, fontSize: 11, formatter: (p: { value: unknown }) => `${(Number(p.value) * 100).toFixed(0)}%` },
          showBackground: true,
          backgroundStyle: { color: t.dark ? "rgba(255,255,255,.03)" : "rgba(15,23,42,.03)", borderRadius: [0, 6, 6, 0] },
        },
      ],
    } as EChartsOption;
  }

  // ---- Correlation matrix --------------------------------------------------------------------
  if (kind === "correlation") {
    const names = uniq(d.rows.map((r) => String(r[0])));
    return {
      ...base,
      grid: { left: 8, right: 8, top: 8, bottom: 44, containLabel: true },
      tooltip: { ...tooltipBase, formatter: (p: unknown) => {
        const { value } = p as { value: [number, number, number, number] };
        const r = value[2];
        const s = Math.abs(r) >= 0.7 ? "strong" : Math.abs(r) >= 0.4 ? "moderate" : Math.abs(r) >= 0.2 ? "weak" : "no real";
        return `${names[value[0]]} × ${names[value[1]]}<br/><b>${r.toFixed(2)}</b>: ${s} ${r >= 0 ? "positive" : "negative"} link<br/><span style="opacity:.7">${value[3]} rows</span>`;
      } },
      xAxis: { type: "category", data: names, axisLabel: { ...axisText, rotate: names.length > 5 ? 35 : 0, width: 100, overflow: "truncate", interval: 0 }, axisTick: { show: false } },
      yAxis: { type: "category", data: names, inverse: true, axisLabel: { ...axisText, width: 120, overflow: "truncate", interval: 0 }, axisTick: { show: false } },
      visualMap: {
        min: -1,
        max: 1,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemHeight: 140,
        itemWidth: 10,
        textStyle: axisText,
        inRange: { color: ["#ef4444", t.dark ? "#1f2937" : "#f8fafc", "#6366f1"] },
      },
      series: [
        {
          type: "heatmap",
          data: d.rows.map((r) => [names.indexOf(String(r[0])), names.indexOf(String(r[1])), Number(r[2]), Number(r[3])]),
          label: { show: names.length <= 9, color: "#fff", textBorderColor: "rgba(15,23,42,.55)", textBorderWidth: 2, fontSize: 11, fontWeight: 600, formatter: (p: { value: number[] }) => p.value[2].toFixed(2) },
          itemStyle: { borderColor: t.panel, borderWidth: 2, borderRadius: 4 },
        },
      ],
    } as EChartsOption;
  }

  // ---- Pareto: sorted bars + cumulative share line ------------------------------------
  if (kind === "pareto") {
    const yi = idx(d, ys[0]);
    const rows = [...d.rows].sort((a, b) => (num(b[yi]) ?? 0) - (num(a[yi]) ?? 0));
    const total = rows.reduce((s, r) => s + (num(r[yi]) ?? 0), 0) || 1;
    let run = 0;
    const cum = rows.map((r) => ((run += num(r[yi]) ?? 0), run / total));
    return {
      ...base,
      ...grid(30, 8),
      ...legend(true),
      tooltip: { ...tooltipBase, trigger: "axis", valueFormatter: undefined },
      xAxis: { type: "category", data: rows.map((r) => label(r[xi])), axisLabel: { ...axisText, rotate: rows.length > 8 ? 30 : 0, hideOverlap: true, width: 90, overflow: "truncate" }, axisTick: { show: false } },
      yAxis: [
        { type: "value", axisLabel: { ...axisText, formatter: (v: number) => fmt(v, w) }, splitLine: split },
        { type: "value", max: 1, axisLabel: { ...axisText, formatter: (v: number) => `${Math.round(v * 100)}%` }, splitLine: { show: false } },
      ],
      series: [
        { name: ys[0] ?? "Value", type: "bar", data: rows.map((r) => num(r[yi])), barMaxWidth: 40, itemStyle: { borderRadius: [6, 6, 0, 0] }, tooltip: { valueFormatter: (v) => fmt(v, w, true) } },
        {
          name: "Cumulative share",
          type: "line",
          yAxisIndex: 1,
          data: cum,
          smooth: 0.2,
          symbolSize: 5,
          lineStyle: { width: 2.5 },
          tooltip: { valueFormatter: (v) => `${(Number(v) * 100).toFixed(1)}%` },
          markLine: { symbol: "none", silent: true, lineStyle: { color: t.muted, type: "dashed" }, label: { color: t.muted, formatter: "80%" }, data: [{ yAxis: 0.8 }] },
        },
      ],
    } as EChartsOption;
  }

  // ---- Waterfall ------------------------------------------------------------------------
  if (kind === "waterfall") {
    const yi = idx(d, ys[0]);
    let run = 0;
    const help: number[] = [];
    const up: (number | string)[] = [];
    const down: (number | string)[] = [];
    for (const r of d.rows) {
      const v = num(r[yi]) ?? 0;
      if (v >= 0) {
        help.push(run);
        up.push(v);
        down.push("-");
      } else {
        help.push(run + v);
        up.push("-");
        down.push(-v);
      }
      run += v;
    }
    return {
      ...base,
      ...grid(14),
      tooltip: { ...tooltipBase, trigger: "axis", formatter: (ps: unknown) => {
        const p = (ps as { dataIndex: number; name: string }[])[0];
        const r = d.rows[p.dataIndex];
        return `${p.name}<br/><b>${fmt(num(r[yi]), w, true)}</b>`;
      } },
      xAxis: { type: "category", data: d.rows.map((r) => label(r[xi])), axisLabel: { ...axisText, rotate: d.rows.length > 8 ? 30 : 0, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", axisLabel: { ...axisText, formatter: (v: number) => fmt(v, w) }, splitLine: split },
      series: [
        { type: "bar", stack: "w", data: help, itemStyle: { color: "transparent" }, emphasis: { disabled: true }, tooltip: { show: false } },
        { name: "Increase", type: "bar", stack: "w", data: up, itemStyle: { color: "#10b981", borderRadius: 4 }, barMaxWidth: 44 },
        { name: "Decrease", type: "bar", stack: "w", data: down, itemStyle: { color: "#ef4444", borderRadius: 4 }, barMaxWidth: 44 },
      ],
    } as EChartsOption;
  }

  // ---- Pie / donut ------------------------------------------------------------------------
  if (kind === "pie" || kind === "donut") {
    const yi = idx(d, ys[0]);
    return {
      ...base,
      ...legend(d.rows.length <= 10),
      series: [
        {
          type: "pie",
          radius: kind === "donut" ? ["48%", "74%"] : ["0%", "72%"],
          center: ["50%", d.rows.length <= 10 ? "56%" : "50%"],
          itemStyle: { borderColor: t.panel, borderWidth: 2, borderRadius: 6 },
          label: { color: t.ink, fontSize: 11, formatter: "{b}\n{d}%" },
          labelLine: { length: 8, length2: 8 },
          data: d.rows.map((r) => ({ name: label(r[xi]), value: num(r[yi]) })),
          emphasis: { scaleSize: 6 },
        },
      ],
    } as EChartsOption;
  }

  // ---- Scatter / bubble ---------------------------------------------------------------------
  if (kind === "scatter" || kind === "bubble") {
    const yi = idx(d, ys[0]);
    const zi = idx(d, ys[1]);
    const zs = zi >= 0 ? d.rows.map((r) => num(r[zi]) ?? 0) : [];
    const zmax = Math.max(1, ...zs);
    const groups = si >= 0 ? uniq(d.rows.map((r) => label(r[si]))) : [""];
    const labelCol = d.columns.findIndex((c, i) => i !== xi && i !== yi && i !== zi && i !== si && !isNumType(c.type));
    return {
      ...base,
      ...legend(groups.length > 1),
      ...grid(groups.length > 1 ? 30 : 14),
      tooltip: {
        ...tooltipBase,
        formatter: (p: unknown) => {
          const { data, seriesName } = p as { data: { value: unknown[]; name?: string }; seriesName: string };
          const v = data.value;
          return `${data.name ? `<b>${data.name}</b><br/>` : seriesName ? `<b>${seriesName}</b><br/>` : ""}${w.x}: ${fmt(v[0])}<br/>${ys[0]}: ${fmt(v[1], w)}${zi >= 0 ? `<br/>${ys[1]}: ${fmt(v[2])}` : ""}`;
        },
      },
      xAxis: { type: "value", name: w.x, nameLocation: "middle", nameGap: 26, nameTextStyle: axisText, scale: true, axisLabel: { ...axisText, formatter: (v: number) => fmt(v) }, splitLine: split },
      yAxis: { type: "value", name: ys[0], nameTextStyle: axisText, scale: true, axisLabel: { ...axisText, formatter: (v: number) => fmt(v, w) }, splitLine: split },
      series: groups.map((g) => ({
        name: g || ys[0],
        type: "scatter" as const,
        symbolSize: zi >= 0 ? (v: unknown[]) => 6 + 34 * Math.sqrt(Math.max(0, Number(v[2])) / zmax) : 9,
        itemStyle: { opacity: 0.8 },
        emphasis: { focus: "series" as const },
        data: d.rows
          .filter((r) => si < 0 || label(r[si]) === g)
          .map((r) => ({ value: [num(r[xi]), num(r[yi]), zi >= 0 ? num(r[zi]) : undefined], name: labelCol >= 0 ? label(r[labelCol]) : undefined })),
      })),
    } as EChartsOption;
  }

  // ---- Heatmap --------------------------------------------------------------------------------
  if (kind === "heatmap") {
    const yi = idx(d, ys[0]);
    const xs = uniq(d.rows.map((r) => label(r[xi])));
    const ss = uniq(d.rows.map((r) => label(r[si >= 0 ? si : 1])));
    const vals = d.rows.map((r) => num(r[yi]) ?? 0);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const diverging = min < 0 && max > 0;
    const m = Math.max(Math.abs(min), Math.abs(max));
    return {
      ...base,
      grid: { left: 8, right: 8, top: 8, bottom: 44, containLabel: true },
      tooltip: { ...tooltipBase, formatter: (p: unknown) => {
        const { value } = p as { value: [number, number, number] };
        return `${xs[value[0]]} · ${ss[value[1]]}<br/><b>${fmt(value[2], w, true)}</b>`;
      } },
      xAxis: { type: "category", data: xs, splitArea: { show: false }, axisLabel: { ...axisText, rotate: xs.length > 8 ? 30 : 0, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "category", data: ss, axisLabel: { ...axisText, width: 120, overflow: "truncate" }, axisTick: { show: false } },
      visualMap: {
        min: diverging ? -m : min,
        max: diverging ? m : max,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemHeight: 120,
        itemWidth: 10,
        textStyle: axisText,
        formatter: (v: unknown) => fmt(v, w),
        inRange: { color: diverging ? ["#ef4444", t.dark ? "#1f2937" : "#f8fafc", "#6366f1"] : [t.dark ? "#1e1b4b" : "#eef2ff", "#818cf8", "#4338ca"] },
      },
      series: [
        {
          type: "heatmap",
          data: d.rows.map((r) => [xs.indexOf(label(r[xi])), ss.indexOf(label(r[si >= 0 ? si : 1])), num(r[yi])]),
          label: { show: xs.length * ss.length <= 80, color: "#fff", textBorderColor: "rgba(15,23,42,.55)", textBorderWidth: 2, fontSize: 11, fontWeight: 600, formatter: (p: { value: unknown[] }) => fmt(p.value[2], w) },
          itemStyle: { borderColor: t.panel, borderWidth: 2, borderRadius: 4 },
        },
      ],
    } as EChartsOption;
  }

  // ---- Treemap / sunburst -------------------------------------------------------------------------
  if (kind === "treemap" || kind === "sunburst") {
    const yi = idx(d, ys[0]);
    type Node = { name: string; value: number; children?: Node[] };
    const top = new Map<string, Node>();
    for (const r of d.rows) {
      const k = label(r[xi]);
      const v = num(r[yi]) ?? 0;
      const n = top.get(k) ?? { name: k, value: 0, children: si >= 0 ? [] : undefined };
      n.value += v;
      if (si >= 0) n.children!.push({ name: label(r[si]), value: v });
      top.set(k, n);
    }
    const data = [...top.values()];
    if (kind === "sunburst")
      return {
        ...base,
        series: [{ type: "sunburst", data, radius: ["12%", "92%"], itemStyle: { borderColor: t.panel, borderWidth: 2, borderRadius: 4 }, label: { color: "#fff", fontSize: 11, minAngle: 8 }, emphasis: { focus: "ancestor" } }],
      } as EChartsOption;
    return {
      ...base,
      tooltip: { ...tooltipBase, formatter: (p: unknown) => {
        const { name, value, treePathInfo } = p as { name: string; value: number; treePathInfo: { name: string }[] };
        return `${treePathInfo.map((x) => x.name).filter(Boolean).join(" › ") || name}<br/><b>${fmt(value, w, true)}</b>`;
      } },
      series: [
        {
          type: "treemap",
          data,
          roam: false,
          nodeClick: si >= 0 ? "zoomToNode" : false,
          breadcrumb: { show: si >= 0, bottom: 0, itemStyle: { color: t.panel, borderColor: t.line, textStyle: { color: t.ink } } },
          top: 4,
          left: 4,
          right: 4,
          bottom: si >= 0 ? 28 : 4,
          label: { show: true, formatter: (p: { name: string; value: unknown }) => `${p.name}\n${fmt(p.value, w)}`, fontSize: 12, lineHeight: 16 },
          upperLabel: { show: si >= 0, height: 22, color: "#fff", fontWeight: 600 },
          itemStyle: { borderColor: t.panel, borderWidth: 2, gapWidth: 2, borderRadius: 6 },
          levels: [{ itemStyle: { borderWidth: 0, gapWidth: 4 } }, { colorSaturation: [0.35, 0.6], itemStyle: { gapWidth: 2, borderColorSaturation: 0.6 } }],
        },
      ],
    } as EChartsOption;
  }

  // ---- Funnel -------------------------------------------------------------------------------------
  if (kind === "funnel") {
    const yi = idx(d, ys[0]);
    const first = num(d.rows[0]?.[yi]) || 1;
    return {
      ...base,
      tooltip: { ...tooltipBase, formatter: (p: unknown) => {
        const { name, value } = p as { name: string; value: number };
        return `${name}<br/><b>${fmt(value, w, true)}</b> · ${((value / first) * 100).toFixed(1)}% of first stage`;
      } },
      series: [
        {
          type: "funnel",
          sort: "none",
          left: "8%",
          right: "8%",
          top: 8,
          bottom: 8,
          gap: 3,
          label: { color: "#fff", fontSize: 12, formatter: (p: { name: string; value: unknown }) => `${p.name}  ${fmt(p.value, w)}` },
          itemStyle: { borderColor: t.panel, borderWidth: 1 },
          data: d.rows.map((r) => ({ name: label(r[xi]), value: num(r[yi]) })),
        },
      ],
    } as EChartsOption;
  }

  // ---- Boxplot -------------------------------------------------------------------------------------
  if (kind === "boxplot") {
    const five = (w.y ?? []).map((y) => idx(d, y));
    return {
      ...base,
      ...grid(14),
      tooltip: { ...tooltipBase, formatter: (p: unknown) => {
        const { name, value } = p as { name: string; value: number[] };
        const v = value.slice(-5);
        return `<b>${name}</b><br/>max ${fmt(v[4], w)}<br/>75% ${fmt(v[3], w)}<br/>median ${fmt(v[2], w)}<br/>25% ${fmt(v[1], w)}<br/>min ${fmt(v[0], w)}`;
      } },
      xAxis: { type: "category", data: d.rows.map((r) => label(r[xi])), axisLabel: { ...axisText, rotate: d.rows.length > 8 ? 30 : 0, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", axisLabel: { ...axisText, formatter: (v: number) => fmt(v, w) }, splitLine: split, scale: true },
      series: [{ type: "boxplot", data: d.rows.map((r) => five.map((i) => num(r[i]))), itemStyle: { color: "rgba(99,102,241,.18)", borderColor: "#6366f1", borderWidth: 1.5 } }],
    } as EChartsOption;
  }

  // ---- Sankey ----------------------------------------------------------------------------------------
  if (kind === "sankey") {
    const yi = idx(d, ys[0]);
    const ti = si >= 0 ? si : 1;
    const links = d.rows
      .map((r) => ({ source: label(r[xi]), target: label(r[ti]), value: num(r[yi]) ?? 0 }))
      .filter((l) => l.source !== l.target && l.value > 0);
    // Sankey can't draw cycles: a name used as both a source and a later target gets a marker on the target side.
    const sources = new Set(links.map((l) => l.source));
    for (const l of links) if (sources.has(l.target) && links.some((k) => k.source === l.target && k.target === l.source)) l.target = `${l.target} ›`;
    const nodes = uniq(links.flatMap((l) => [l.source, l.target])).map((name) => ({ name }));
    return {
      ...base,
      tooltip: { ...tooltipBase, trigger: "item" },
      series: [
        {
          type: "sankey",
          data: nodes,
          links,
          left: 8,
          right: 120,
          top: 8,
          bottom: 8,
          nodeGap: 10,
          nodeWidth: 14,
          draggable: true,
          emphasis: { focus: "adjacency" },
          lineStyle: { color: "gradient", opacity: 0.35, curveness: 0.5 },
          label: { color: t.ink, fontSize: 11 },
          itemStyle: { borderWidth: 0, borderRadius: 3 },
        },
      ],
    } as EChartsOption;
  }

  // ---- Radar ------------------------------------------------------------------------------------------
  if (kind === "radar") {
    const yi = idx(d, ys[0]);
    const indicators = uniq(d.rows.map((r) => label(r[xi])));
    const items = si >= 0 ? uniq(d.rows.map((r) => label(r[si]))) : [ys[0] ?? "Value"];
    const max = Math.max(...d.rows.map((r) => num(r[yi]) ?? 0)) * 1.1 || 1;
    return {
      ...base,
      ...legend(items.length > 1),
      radar: { indicator: indicators.map((name) => ({ name, max })), radius: "66%", center: ["50%", "56%"], axisName: { color: t.muted, fontSize: 11 }, splitLine: { lineStyle: { color: t.line } }, splitArea: { show: false }, axisLine: { lineStyle: { color: t.line } } },
      series: [
        {
          type: "radar",
          data: items.map((it) => ({
            name: it,
            value: indicators.map((ind) => num(d.rows.find((r) => label(r[xi]) === ind && (si < 0 || label(r[si]) === it))?.[yi]) ?? 0),
            areaStyle: { opacity: 0.15 },
          })),
          symbolSize: 5,
          lineStyle: { width: 2 },
        },
      ],
    } as EChartsOption;
  }

  // ---- Gauge -------------------------------------------------------------------------------------------
  if (kind === "gauge") {
    const v = num(d.rows[0]?.[idx(d, ys[0])]) ?? 0;
    const max = Number(o.max) || (w.format === "percent" ? 1 : Math.pow(10, Math.ceil(Math.log10(Math.abs(v) || 1))));
    return {
      ...base,
      series: [
        {
          type: "gauge",
          min: 0,
          max,
          radius: "92%",
          center: ["50%", "60%"],
          startAngle: 200,
          endAngle: -20,
          progress: { show: true, width: 14, roundCap: true, itemStyle: { color: t.accent } },
          axisLine: { lineStyle: { width: 14, color: [[1, t.line]] }, roundCap: true },
          pointer: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          anchor: { show: false },
          title: { show: false },
          detail: { valueAnimation: true, offsetCenter: [0, "0%"], fontSize: 28, fontWeight: 700, color: t.ink, formatter: (x: number) => fmt(x, w) },
          data: [{ value: v }],
        },
      ],
    } as EChartsOption;
  }

  // ---- Calendar ------------------------------------------------------------------------------------------
  if (kind === "calendar") {
    const yi = idx(d, ys[0]);
    const pts = d.rows.map((r) => [label(r[xi]).slice(0, 10), num(r[yi]) ?? 0] as [string, number]).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p[0]));
    const years = uniq(pts.map((p) => p[0].slice(0, 4))).sort().slice(-3);
    const vals = pts.map((p) => p[1]);
    return {
      ...base,
      tooltip: { ...tooltipBase, formatter: (p: unknown) => {
        const { value } = p as { value: [string, number] };
        return `${value[0]}<br/><b>${fmt(value[1], w, true)}</b>`;
      } },
      visualMap: { min: Math.min(0, ...vals), max: Math.max(1, ...vals), show: false, inRange: { color: [t.dark ? "#1e1b4b" : "#eef2ff", "#818cf8", "#4338ca"] } },
      calendar: years.map((y, i) => ({
        range: y,
        top: 24 + i * 150,
        left: 40,
        right: 8,
        cellSize: ["auto", 14],
        itemStyle: { borderColor: t.panel, borderWidth: 2, color: t.dark ? "#111827" : "#f8fafc" },
        splitLine: { show: false },
        yearLabel: { color: t.muted, fontSize: 12 },
        monthLabel: { color: t.muted, fontSize: 10 },
        dayLabel: { color: t.muted, fontSize: 9, firstDay: 1 },
      })),
      series: years.map((y, i) => ({ type: "heatmap" as const, coordinateSystem: "calendar" as const, calendarIndex: i, data: pts.filter((p) => p[0].startsWith(y)) })),
    } as EChartsOption;
  }

  return { ...base };
}

/** Height a chart wants in the board, by kind. */
export function chartHeight(w: Widget, data?: Data | null) {
  if (w.kind === "calendar") {
    const years = data ? new Set(data.rows.map((r) => String(r[0]).slice(0, 4))).size : 1;
    return 40 + Math.min(3, years) * 150;
  }
  if (w.kind === "hbar") return Math.max(240, Math.min(620, 28 * (data?.rows.length ?? 8) + 40));
  if (w.kind === "gauge") return 220;
  if (w.kind === "drivers") return Math.max(200, Math.min(520, 34 * (data?.rows.length ?? 6) + 30));
  if (w.kind === "correlation") {
    const n = data ? new Set(data.rows.map((r) => r[0])).size : 6;
    return Math.max(300, Math.min(640, 46 * n + 80));
  }
  if (w.kind === "forecast") return 340;
  if (w.kind === "sankey" || w.kind === "treemap" || w.kind === "sunburst" || w.kind === "heatmap") return 360;
  return 300;
}
