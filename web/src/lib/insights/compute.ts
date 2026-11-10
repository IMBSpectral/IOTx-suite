/**
 * Board items computed from their query's rows on the server: forecasts, key drivers,
 * what-if models and correlation matrices. They re-run with the board's filters like
 * any chart, so a forecast for "Pune only" is one click away.
 */
import { correlations, drivers, forecast, type DriverModel } from "./stats";
import type { Result } from "./engine";
import type { Widget } from "./store";

export const MODEL_KINDS = new Set(["forecast", "drivers", "whatif", "correlation"]);

export type Computed = Result & { meta?: Record<string, unknown> };

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL.*)$/i;
const opt = (w: Widget, k: string) => (w.options ?? {})[k];

function rowsAsObjects(r: Result) {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
}

/** Turn a model item's query result into what the board draws (and the AI reads). */
export function compute(w: Widget, r: Result): Computed {
  if (w.kind === "forecast") {
    const xi = Math.max(0, r.columns.findIndex((c) => c.name === w.x));
    const yi = r.columns.findIndex((c) => c.name === (w.y?.[0] ?? ""));
    const vi = yi >= 0 ? yi : r.columns.findIndex((c, i) => i !== xi && NUMERIC.test(c.type));
    if (vi < 0) throw new Error("A forecast needs a number column (y) and a date or order column (x).");
    const pts = r.rows.map((row) => [row[xi], Number(row[vi])] as const).filter(([x, v]) => x !== null && Number.isFinite(v));
    pts.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    const f = forecast(
      pts.map((p) => (typeof p[0] === "number" ? p[0] : String(p[0]))),
      pts.map((p) => p[1]),
      { horizon: Number(opt(w, "horizon")) || undefined, period: Number(opt(w, "period")) || undefined },
    );
    const name = r.columns[vi].name;
    return {
      columns: [
        { name: r.columns[xi].name, type: "VARCHAR" },
        { name, type: "DOUBLE" },
        { name: "Forecast", type: "DOUBLE" },
        { name: "Low 80%", type: "DOUBLE" },
        { name: "High 80%", type: "DOUBLE" },
        { name: "Low 95%", type: "DOUBLE" },
        { name: "High 95%", type: "DOUBLE" },
      ],
      rows: f.x.map((x, i) => [x, f.actual[i] ?? null, f.forecast[i] ?? null, f.lo80[i] ?? null, f.hi80[i] ?? null, f.lo95[i] ?? null, f.hi95[i] ?? null]),
      meta: { method: f.method, mape: f.mape, mae: f.mae, step: f.step, horizon: f.horizon, note: f.note },
    };
  }

  if (w.kind === "drivers" || w.kind === "whatif") {
    const target = String(opt(w, "target") ?? w.y?.[0] ?? "");
    if (!r.columns.some((c) => c.name === target)) throw new Error(`Set options.target to a column the query returns (got "${target}").`);
    const given = opt(w, "features");
    const features = Array.isArray(given) ? given.map(String) : r.columns.map((c) => c.name).filter((c) => c !== target);
    const m = drivers(rowsAsObjects(r), target, features);
    return {
      columns: [
        { name: "Factor", type: "VARCHAR" },
        { name: "Importance", type: "DOUBLE" },
        { name: "Effect", type: "VARCHAR" },
      ],
      rows: m.factors.map((f) => [f.name, +f.importance.toFixed(4), effectText(f, m)]),
      meta: { model: m },
    };
  }

  if (w.kind === "correlation") {
    const cols = (w.y?.length ? w.y : r.columns.filter((c) => NUMERIC.test(c.type)).map((c) => c.name)).slice(0, 20);
    const method = opt(w, "method") === "spearman" ? "spearman" : "pearson";
    const c = correlations(rowsAsObjects(r), cols, method);
    return {
      columns: [
        { name: "Column", type: "VARCHAR" },
        { name: "With", type: "VARCHAR" },
        { name: "Correlation", type: "DOUBLE" },
        { name: "Rows", type: "BIGINT" },
      ],
      rows: c.map((x) => [x.a, x.b, x.r, x.n]),
      meta: { method, columns: cols },
    };
  }
  return r;
}

const f2 = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-IN") : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
const signed = (v: number, binary: boolean) => (binary ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)} pts` : `${v >= 0 ? "+" : ""}${f2(v)}`);

function effectText(f: DriverModel["factors"][number], m: DriverModel) {
  if (f.kind === "number") return `${signed(f.perSd ?? 0, m.binary)} per +1 SD (${f2(f.sd ?? 0)}); correlation ${f.correlation?.toFixed(2)}`;
  const lv = f.levels ?? [];
  const top = lv[0];
  const bottom = lv[lv.length - 1];
  return `vs ${f.baseline}: highest ${top?.value} ${signed(top?.effect ?? 0, m.binary)}, lowest ${bottom?.value} ${signed(bottom?.effect ?? 0, m.binary)}`;
}

/** What the AI reads back after adding a model item, so its insight uses the real results. */
export function describe(w: Widget, c: Computed) {
  if (w.kind === "forecast") {
    const meta = c.meta as { method: string; mape: number | null; mae: number | null; horizon: number; note?: string };
    const hist = c.rows.filter((r) => r[1] !== null);
    const fut = c.rows.filter((r) => r[1] === null);
    const last = hist[hist.length - 1];
    const end = fut[fut.length - 1];
    const sum = fut.reduce((s, r) => s + Number(r[2] ?? 0), 0);
    return [
      `Forecast by ${meta.method}. Backtest error: ${meta.mape !== null ? `${(meta.mape * 100).toFixed(1)}% MAPE, ` : ""}MAE ${meta.mae?.toFixed(2)}.${meta.note ? ` ${meta.note}` : ""}`,
      `Last actual ${last?.[0]}: ${last?.[1]}. Next ${meta.horizon} periods total ${sum.toFixed(2)}; at ${end?.[0]}: ${Number(end?.[2]).toFixed(2)} (80% range ${Number(end?.[3]).toFixed(2)}–${Number(end?.[4]).toFixed(2)}).`,
      `Forecast rows:\n${fut.slice(0, 24).map((r) => `${r[0]}\t${Number(r[2]).toFixed(2)}\t[${Number(r[3]).toFixed(2)}, ${Number(r[4]).toFixed(2)}]`).join("\n")}`,
    ].join("\n");
  }
  if (w.kind === "drivers" || w.kind === "whatif") {
    const m = (c.meta as { model: DriverModel }).model;
    const detail = m.factors.slice(0, 10).map((f) => {
      const head = `- ${f.name}: ${(f.importance * 100).toFixed(1)}% of explained variation`;
      if (f.kind === "number") return `${head}; ${signed(f.perUnit ?? 0, m.binary)} per 1 unit, ${signed(f.perSd ?? 0, m.binary)} per SD; r=${f.correlation?.toFixed(2)}`;
      return `${head}; vs ${f.baseline}: ${(f.levels ?? []).map((l) => `${l.value} ${signed(l.effect, m.binary)} (avg ${f2(l.mean)}, n=${l.count})`).join(", ")}`;
    });
    const combos = m.interactions.map(
      (x) => `- ${x.factors[0]} = ${x.values[0]} with ${x.factors[1]} = ${x.values[1]}: ${signed(x.extra, m.binary)} beyond their separate effects (avg ${f2(x.mean)}, n=${x.count})`,
    );
    return (
      `Model of "${m.target}"${m.binary ? " (yes/no, effects in percentage points)" : ""}: R² ${(m.r2 * 100).toFixed(1)}% of variation explained, ${m.n} rows, average ${f2(m.targetMean)}.\n${detail.join("\n")}` +
      (combos.length ? `\nCombinations that matter more than their parts:\n${combos.join("\n")}` : "")
    );
  }
  if (w.kind === "correlation") {
    const strong = c.rows.filter((r) => String(r[0]) < String(r[1])).sort((a, b) => Math.abs(Number(b[2])) - Math.abs(Number(a[2]))).slice(0, 12);
    return `Strongest correlations:\n${strong.map((r) => `${r[0]} ~ ${r[1]}: ${r[2]} (n=${r[3]})`).join("\n")}`;
  }
  return "";
}
