/**
 * Insights statistics, in plain TypeScript (no Python on the servers):
 *
 * - forecast(): exponential smoothing (simple, damped trend, Holt-Winters additive and
 *   multiplicative) and a linear trend; the method is picked by how well each predicts the
 *   most recent part of the history it didn't see (a backtest), then refit on all of it.
 *   Prediction intervals come from the backtest errors.
 * - drivers(): what moves a number. A ridge regression over numeric and category columns;
 *   each factor's importance is the share of the explained variation lost without it, and its
 *   effect is in the target's own units ("Pune adds 2.9 days").
 * - correlations(): Pearson and Spearman for every pair of numeric columns.
 */

// ─── Forecast ──────────────────────────────────────────────────────────────

export type Step = "day" | "week" | "month" | "quarter" | "year" | "index";

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

function addStep(t: number, step: Step, n: number) {
  const d = new Date(t);
  if (step === "day") return t + n * DAY;
  if (step === "week") return t + n * 7 * DAY;
  if (step === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), 28));
  if (step === "quarter") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3 * n, Math.min(d.getUTCDate(), 28));
  if (step === "year") return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate());
  return t + n;
}

/** The spacing of a date series (its most common gap). */
export function detectStep(times: number[]): Step {
  if (times.length < 2) return "day";
  const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) / DAY));
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  const g = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (g <= 1) return "day";
  if (g <= 8) return "week";
  if (g <= 31) return "month";
  if (g <= 92) return "quarter";
  return "year";
}

const SEASON: Record<Step, number> = { day: 7, week: 52, month: 12, quarter: 4, year: 0, index: 0 };

type Fit = { name: string; level: number; trend: number; season: number[]; phi: number; sse: number; n: number; fitted: number[] };
type Params = { alpha: number; beta: number | null; gamma: number | null; phi: number; m: number; mult: boolean };

/** One pass of exponential smoothing; returns the state at the end and one-step-ahead fits. */
function smooth(y: number[], p: Params): Fit {
  const { alpha, beta, gamma, phi, m, mult } = p;
  const seasonal = gamma !== null && m > 1;
  let level = y[0];
  let trend = beta !== null ? (y.length > m && seasonal ? (avg(y.slice(m, 2 * m)) - avg(y.slice(0, m))) / m : y.length > 1 ? y[1] - y[0] : 0) : 0;
  let season: number[] = [];
  if (seasonal) {
    const base = avg(y.slice(0, m));
    level = base;
    season = y.slice(0, m).map((v) => (mult ? (base ? v / base : 1) : v - base));
  }
  const fitted: number[] = [];
  let sse = 0;
  for (let t = 0; t < y.length; t++) {
    const s = seasonal ? season[t % m] : mult ? 1 : 0;
    const f = mult ? (level + phi * trend) * s : level + phi * trend + s;
    fitted.push(f);
    if (t >= (seasonal ? m : 1)) sse += (y[t] - f) ** 2;
    const prevLevel = level;
    const deseason = mult ? (s ? y[t] / s : y[t]) : y[t] - s;
    level = alpha * deseason + (1 - alpha) * (prevLevel + phi * trend);
    if (beta !== null) trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
    if (seasonal) season[t % m] = gamma! * (mult ? (level ? y[t] / level : 1) : y[t] - level) + (1 - gamma!) * s;
  }
  return { name: "", level, trend, season, phi, sse, n: y.length, fitted };
}

function forecastFrom(f: Fit, p: Params, h: number, start: number) {
  const out: number[] = [];
  let damp = 0;
  for (let k = 1; k <= h; k++) {
    damp += Math.pow(p.phi, k);
    const tr = p.beta !== null ? damp * f.trend : 0;
    const s = p.gamma !== null && p.m > 1 ? f.season[(start + k - 1) % p.m] : p.mult ? 1 : 0;
    out.push(p.mult ? (f.level + tr) * s : f.level + tr + s);
  }
  return out;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Method = { name: string; label: string; fit: (y: number[]) => { p: Params; f: Fit } | null; predict: (y: number[], h: number) => number[] };

/** Best smoothing parameters by grid search on one-step error. */
function tune(y: number[], base: Omit<Params, "alpha" | "beta" | "gamma" | "phi">, useTrend: boolean, useSeason: boolean, damped: boolean) {
  let best: { p: Params; f: Fit } | null = null;
  const alphas = [0.05, 0.15, 0.3, 0.5, 0.7, 0.9];
  const betas = useTrend ? [0.01, 0.05, 0.15, 0.3] : [null];
  const gammas = useSeason ? [0.05, 0.15, 0.3, 0.5] : [null];
  const phis = damped ? [0.85, 0.92, 0.98] : [1];
  for (const alpha of alphas)
    for (const beta of betas)
      for (const gamma of gammas)
        for (const phi of phis) {
          const p: Params = { ...base, alpha, beta, gamma, phi };
          const f = smooth(y, p);
          if (Number.isFinite(f.sse) && (!best || f.sse < best.f.sse)) best = { p, f };
        }
  return best;
}

function methods(m: number, positive: boolean): Method[] {
  const es = (name: string, label: string, trend: boolean, season: boolean, damped: boolean, mult = false): Method => ({
    name,
    label,
    fit: (y) => (season && y.length < 2 * m + 2 ? null : tune(y, { m, mult }, trend, season, damped)),
    predict: (y, h) => {
      const r = es(name, label, trend, season, damped, mult).fit(y);
      return r ? forecastFrom(r.f, r.p, h, y.length) : [];
    },
  });
  const list: Method[] = [
    es("ses", "steady level (simple exponential smoothing)", false, false, false),
    es("damped", "trend that levels off (damped Holt)", true, false, true),
    es("holt", "straight-line trend (Holt)", true, false, false),
  ];
  if (m > 1) {
    list.push(es("hw-add", `trend with a ${m}-step seasonal pattern (Holt-Winters)`, true, true, true));
    if (positive) list.push(es("hw-mult", `trend with a ${m}-step seasonal pattern that scales with the level (Holt-Winters, multiplicative)`, true, true, true, true));
  }
  list.push({
    name: "linear",
    label: "linear trend (least squares)",
    fit: () => null,
    predict: (y, h) => {
      const n = y.length;
      const xs = y.map((_, i) => i);
      const mx = avg(xs);
      const my = avg(y);
      const b = xs.reduce((s, x, i) => s + (x - mx) * (y[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
      return Array.from({ length: h }, (_, k) => my + b * (n + k - mx));
    },
  });
  return list;
}

export type ForecastResult = {
  x: string[];
  actual: (number | null)[];
  forecast: (number | null)[];
  lo80: (number | null)[];
  hi80: (number | null)[];
  lo95: (number | null)[];
  hi95: (number | null)[];
  method: string;
  step: Step;
  /** Mean absolute percentage error on the held-back period (lower is better). */
  mape: number | null;
  /** Mean absolute error in the series' units. */
  mae: number | null;
  horizon: number;
  note?: string;
};

/**
 * Forecast a series. x are dates (YYYY-MM-DD…) or ordered numbers; gaps in a date series
 * are filled by interpolation so the spacing is even.
 */
export function forecast(xs: (string | number)[], ys: number[], o: { horizon?: number; period?: number; method?: string } = {}): ForecastResult {
  const dated = xs.every((x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x));
  let times = dated ? xs.map((x) => Date.parse(String(x).slice(0, 10))) : xs.map((_, i) => i);
  let y = [...ys];
  const step: Step = dated ? detectStep(times) : "index";
  let filled = 0;
  if (dated && times.length > 2) {
    // Even spacing: walk the calendar, interpolating any missing period.
    const grid: number[] = [];
    for (let t = times[0], i = 0; t <= times[times.length - 1] && i < 5000; t = addStep(times[0], step, ++i)) grid.push(t);
    const at = new Map(times.map((t, i) => [isoDay(t), y[i]]));
    const near = (t: number) => {
      // Month/quarter grids land on the same day of month; match by period instead of exact day.
      const k = isoDay(t);
      if (at.has(k)) return at.get(k)!;
      if (step === "month" || step === "quarter" || step === "year") {
        const ym = k.slice(0, 7);
        for (const [d, v] of at) if (d.slice(0, 7) === ym) return v;
      }
      return undefined;
    };
    const gy = grid.map(near);
    if (gy.filter((v) => v !== undefined).length >= y.length * 0.9) {
      for (let i = 0; i < gy.length; i++)
        if (gy[i] === undefined) {
          filled++;
          let a = i - 1;
          while (a >= 0 && gy[a] === undefined) a--;
          let b = i + 1;
          while (b < gy.length && gy[b] === undefined) b++;
          gy[i] = a >= 0 && b < gy.length ? gy[a]! + ((gy[b]! - gy[a]!) * (i - a)) / (b - a) : (gy[a] ?? gy[b] ?? 0);
        }
      times = grid;
      y = gy as number[];
    }
  }
  const n = y.length;
  const m = o.period ?? (SEASON[step] && n >= 2 * SEASON[step] + 2 ? SEASON[step] : 0);
  const horizon = Math.max(1, Math.min(o.horizon ?? (m || Math.max(3, Math.round(n / 4))), 365, n * 2));
  const label = (t: number) => (dated ? isoDay(t) : String(t));

  if (n < 4) {
    return { x: times.map(label), actual: y, forecast: y.map(() => null), lo80: [], hi80: [], lo95: [], hi95: [], method: "not enough history", step, mape: null, mae: null, horizon: 0, note: "At least 4 points are needed to forecast." };
  }

  // Backtest: hold back the most recent stretch, predict it, compare.
  const test = Math.max(1, Math.min(horizon, Math.floor(n * 0.2)));
  const train = y.slice(0, n - test);
  const actualTest = y.slice(n - test);
  const positive = y.every((v) => v > 0);
  let best: { m: Method; mae: number; mape: number | null; errs: number[] } | null = null;
  for (const meth of methods(m, positive).filter((x) => !o.method || x.name === o.method)) {
    if (train.length < 3) break;
    const p = meth.predict(train, test);
    if (p.length !== test || p.some((v) => !Number.isFinite(v))) continue;
    const errs = p.map((v, i) => actualTest[i] - v);
    const mae = avg(errs.map(Math.abs));
    const pct = actualTest.every((v) => v !== 0) ? avg(errs.map((e, i) => Math.abs(e / actualTest[i]))) : null;
    if (!best || mae < best.mae) best = { m: meth, mae, mape: pct, errs };
  }
  if (!best) best = { m: methods(0, false)[0], mae: 0, mape: null, errs: [0] };

  const fc = best.m.predict(y, horizon);
  // Interval: spread of backtest errors (at least the in-sample spread), widening with distance.
  const inSample = (() => {
    const r = best.m.fit(y);
    if (!r) return null;
    const skip = r.p.gamma !== null ? r.p.m : 1;
    const e = y.slice(skip).map((v, i) => v - r.f.fitted[i + skip]);
    return Math.sqrt(avg(e.map((x) => x * x)));
  })();
  const sigma = Math.max(Math.sqrt(avg(best.errs.map((e) => e * e))), inSample ?? 0, 1e-9);
  const width = (k: number) => sigma * Math.sqrt(1 + (k - 1) * 0.25);
  const future = Array.from({ length: horizon }, (_, k) => addStep(times[n - 1], step, k + 1));
  const nonNeg = y.every((v) => v >= 0);
  const clamp = (v: number) => (nonNeg ? Math.max(0, v) : v);
  const pad = (arr: number[]) => [...Array(n - 1).fill(null), y[n - 1], ...arr];
  return {
    x: [...times.map(label), ...future.map(label)],
    actual: [...y, ...Array(horizon).fill(null)],
    forecast: pad(fc.map(clamp)),
    lo80: pad(fc.map((v, k) => clamp(v - 1.2816 * width(k + 1)))),
    hi80: pad(fc.map((v, k) => clamp(v + 1.2816 * width(k + 1)))),
    lo95: pad(fc.map((v, k) => clamp(v - 1.96 * width(k + 1)))),
    hi95: pad(fc.map((v, k) => clamp(v + 1.96 * width(k + 1)))),
    method: best.m.label,
    step,
    mape: best.mape,
    mae: best.mae,
    horizon,
    note: filled ? `${filled} missing period${filled > 1 ? "s" : ""} filled by interpolation.` : undefined,
  };
}

// ─── Key drivers ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export type DriverFactor = {
  name: string;
  kind: "number" | "category";
  /** Share of the explained variation that is lost without this factor (0–1, normalised to sum to 1). */
  importance: number;
  /** Numbers: change in the target for one standard deviation more of this factor. */
  perSd?: number;
  /** Numbers: change in the target per one unit of this factor. */
  perUnit?: number;
  correlation?: number;
  /** Categories: each value's effect against the most common value (the baseline). */
  levels?: { value: string; effect: number; count: number; mean: number }[];
  baseline?: string;
  sd?: number;
  mean?: number;
  min?: number;
  max?: number;
};

export type DriverModel = {
  target: string;
  binary: boolean;
  n: number;
  r2: number;
  intercept: number;
  targetMean: number;
  factors: DriverFactor[];
  /** Coefficients for the what-if calculator (raw units; categories by value). */
  coef: Record<string, number | Record<string, number>>;
  /** Pairs of category values whose combined effect goes beyond their separate effects. */
  interactions: { factors: [string, string]; values: [string, string]; extra: number; count: number; mean: number }[];
};

const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v));

/** Solve (XᵀX + λI)β = Xᵀy by Cholesky (X has an intercept column first, not penalised). */
function ridge(X: number[][], y: number[], lambda: number) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const r = X[i];
    for (let j = 0; j < p; j++) {
      b[j] += r[j] * y[i];
      for (let k = j; k < p; k++) A[j][k] += r[j] * r[k];
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) A[j][k] = A[k][j];
    if (j > 0) A[j][j] += lambda;
  }
  // Cholesky
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++)
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) L[i][i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i][j] = s / L[j][j];
    }
  const z = new Array(p).fill(0);
  for (let i = 0; i < p; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
    z[i] = s / L[i][i];
  }
  const beta = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < p; k++) s -= L[k][i] * beta[k];
    beta[i] = s / L[i][i];
  }
  return beta;
}

function r2Of(X: number[][], y: number[], beta: number[]) {
  const my = avg(y);
  let ssr = 0;
  let sst = 0;
  for (let i = 0; i < X.length; i++) {
    const f = X[i].reduce((s, v, j) => s + v * beta[j], 0);
    ssr += (y[i] - f) ** 2;
    sst += (y[i] - my) ** 2;
  }
  return sst ? Math.max(0, 1 - ssr / sst) : 0;
}

/** What drives `target`, from rows of data. Columns are numbers or categories (auto-detected). */
export function drivers(rows: Row[], target: string, features: string[]): DriverModel {
  const yes = /^(yes|y|true|1|on time|ontime|pass|won|success)$/i;
  const tv = rows.map((r) => r[target]);
  const binaryText = tv.every((v) => v === null || v === undefined || typeof v === "boolean" || /^(yes|no|y|n|true|false|0|1)$/i.test(String(v).trim()));
  const yAll = tv.map((v) => (binaryText ? (v === null || v === undefined ? NaN : yes.test(String(v).trim()) ? 1 : 0) : num(v)));
  const binary = binaryText || new Set(yAll.filter(Number.isFinite)).size <= 2;

  // Feature kinds: numbers when ≥95% of filled values are numeric, else categories (top 12 values, rest "Other").
  type F = { name: string; kind: "number" | "category"; levels?: string[]; baseline?: string; mean?: number; sd?: number; min?: number; max?: number };
  const feats: F[] = [];
  for (const name of features) {
    if (name === target) continue;
    const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && v !== "");
    if (!vals.length) continue;
    const nums = vals.map(num).filter(Number.isFinite);
    if (nums.length >= vals.length * 0.95 && new Set(nums).size > 2) {
      const mean = avg(nums);
      const sd = Math.sqrt(avg(nums.map((v) => (v - mean) ** 2))) || 1;
      feats.push({ name, kind: "number", mean, sd, min: Math.min(...nums), max: Math.max(...nums) });
    } else {
      const counts = new Map<string, number>();
      for (const v of vals) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (top.length < 2 || top.length > rows.length * 0.5) continue; // an id-like column explains nothing
      const levels = top.slice(0, 12).map((x) => x[0]);
      if (top.length > 12) levels.push("Other");
      feats.push({ name, kind: "category", levels, baseline: levels[0] });
    }
  }

  const ok = rows.map((r, i) => Number.isFinite(yAll[i]) && feats.every((f) => f.kind === "category" || Number.isFinite(num(r[f.name]))));
  const data = rows.filter((_, i) => ok[i]);
  const y = yAll.filter((_, i) => ok[i]);
  const encode = (r: Row, use: F[]) => {
    const out = [1];
    for (const f of use) {
      if (f.kind === "number") out.push((num(r[f.name]) - f.mean!) / f.sd!);
      else {
        const raw = r[f.name] === null || r[f.name] === undefined || r[f.name] === "" ? f.baseline! : String(r[f.name]);
        const v = f.levels!.includes(raw) ? raw : "Other";
        for (const l of f.levels!.slice(1)) out.push(v === l ? 1 : 0);
      }
    }
    return out;
  };
  const fit = (use: F[]) => {
    const X = data.map((r) => encode(r, use));
    const beta = ridge(X, y, Math.max(1, data.length * 0.001));
    return { beta, r2: r2Of(X, y, beta) };
  };
  const full = fit(feats);
  const drops = feats.map((f) => Math.max(0, full.r2 - fit(feats.filter((g) => g !== f)).r2));
  // Shapley-like split of R²: unique contributions, scaled so they add up to the model's R².
  const totalDrop = drops.reduce((a, b) => a + b, 0) || 1;

  let col = 1;
  const coef: DriverModel["coef"] = {};
  let intercept = full.beta[0];
  const factors: DriverFactor[] = feats.map((f, i) => {
    if (f.kind === "number") {
      const b = full.beta[col++];
      const xs = data.map((r) => num(r[f.name]));
      const mx = avg(xs);
      const my = avg(y);
      const corr = xs.reduce((s, x, k) => s + (x - mx) * (y[k] - my), 0) / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0) || 1);
      coef[f.name] = b / f.sd!;
      intercept -= (b * f.mean!) / f.sd!;
      return { name: f.name, kind: "number", importance: drops[i] / totalDrop, perSd: b, perUnit: b / f.sd!, correlation: corr, sd: f.sd, mean: f.mean, min: f.min, max: f.max };
    }
    const levels = f.levels!.slice(1).map((l) => ({ value: l, effect: full.beta[col++] }));
    const effects: Record<string, number> = { [f.baseline!]: 0 };
    for (const l of levels) effects[l.value] = l.effect;
    coef[f.name] = effects;
    const stats = (value: string) => {
      const ys = data.map((r, k) => ({ v: f.levels!.includes(String(r[f.name] ?? f.baseline)) ? String(r[f.name] ?? f.baseline) : "Other", y: y[k] })).filter((x) => x.v === value).map((x) => x.y);
      return { count: ys.length, mean: avg(ys) };
    };
    return {
      name: f.name,
      kind: "category",
      importance: drops[i] / totalDrop,
      baseline: f.baseline,
      levels: [{ value: f.baseline!, effect: 0, ...stats(f.baseline!) }, ...levels.map((l) => ({ ...l, ...stats(l.value) }))].sort((a, b) => b.effect - a.effect),
    };
  });
  factors.sort((a, b) => b.importance - a.importance);

  // Combinations: where two categories together move the target more than each does alone
  // ("Pune × Crankshaft adds 5.8 days beyond Pune and Crankshaft separately"). Found from the
  // additive model's leftovers, per pair of the most important category factors.
  const X = data.map((r) => encode(r, feats));
  const resid = X.map((row, i) => y[i] - row.reduce((s, v, j) => s + v * full.beta[j], 0));
  const cats = factors.filter((f) => f.kind === "category").slice(0, 4).map((f) => f.name);
  const minN = Math.max(8, Math.round(data.length * 0.01));
  const interactions: DriverModel["interactions"] = [];
  for (let i = 0; i < cats.length; i++)
    for (let j = i + 1; j < cats.length; j++) {
      const cells = new Map<string, { a: string; b: string; sum: number; n: number; ys: number }>();
      data.forEach((r, k) => {
        const a = String(r[cats[i]] ?? "");
        const b = String(r[cats[j]] ?? "");
        const c = cells.get(`${a}\u0001${b}`) ?? { a, b, sum: 0, n: 0, ys: 0 };
        c.sum += resid[k];
        c.ys += y[k];
        c.n++;
        cells.set(`${a}\u0001${b}`, c);
      });
      for (const c of cells.values())
        if (c.n >= minN) interactions.push({ factors: [cats[i], cats[j]], values: [c.a, c.b], extra: c.sum / c.n, count: c.n, mean: c.ys / c.n });
    }
  const sdRes = Math.sqrt(avg(resid.map((e) => e * e))) || 1;
  const strong = interactions
    .filter((x) => Math.abs(x.extra) > 0.5 * sdRes)
    .sort((p, q) => Math.abs(q.extra) * Math.sqrt(q.count) - Math.abs(p.extra) * Math.sqrt(p.count))
    .slice(0, 6);
  return { target, binary, n: data.length, r2: full.r2, intercept, targetMean: avg(y), factors, coef, interactions: strong };
}

// ─── Correlations ───────────────────────────────────────────────────────────

function ranks(xs: number[]) {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r as number[];
}

function pearson(a: number[], b: number[]) {
  const ma = avg(a);
  const mb = avg(b);
  let s = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    s += (a[i] - ma) * (b[i] - mb);
    sa += (a[i] - ma) ** 2;
    sb += (b[i] - mb) ** 2;
  }
  return sa && sb ? s / Math.sqrt(sa * sb) : 0;
}

/** Every pair of numeric columns: Pearson r, Spearman ρ and how many rows had both. */
export function correlations(rows: Row[], columns: string[], method: "pearson" | "spearman" = "pearson") {
  const out: { a: string; b: string; r: number; n: number }[] = [];
  for (const a of columns)
    for (const b of columns) {
      const pairs = rows.map((r) => [num(r[a]), num(r[b])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      const xs = pairs.map((p) => p[0]);
      const ys = pairs.map((p) => p[1]);
      const r = a === b ? 1 : pairs.length < 3 ? 0 : method === "spearman" ? pearson(ranks(xs), ranks(ys)) : pearson(xs, ys);
      out.push({ a, b, r: +r.toFixed(3), n: pairs.length });
    }
  return out;
}
