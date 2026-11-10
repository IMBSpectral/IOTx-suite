/**
 * Insights relational models, in plain TypeScript:
 * - network(): nodes and links from rows (who works with whom, what flows where), with each
 *   node's connections, weight, how often it sits on the paths between others (betweenness:
 *   the connectors and choke points) and clusters (label propagation).
 * - processMap(): from an event log (case, step, time): the flow between steps, how long each
 *   hand-over takes, where cases wait longest (bottlenecks) and the most common paths.
 * - anomalies(): values far from their group's typical range (robust z-score on the median
 *   and median absolute deviation, so outliers don't hide themselves).
 */

export type Net = {
  nodes: { id: string; type?: string; weight: number; degree: number; betweenness: number; cluster: number }[];
  edges: [string, string, number][];
  clusters: number;
};

export function network(edgesIn: { s: string; t: string; w: number; st?: string; tt?: string }[]): Net {
  const w = new Map<string, number>();
  const types = new Map<string, string>();
  const adj = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, x: number) => {
    if (!adj.has(a)) adj.set(a, new Map());
    adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + x);
  };
  const edgeMap = new Map<string, [string, string, number]>();
  for (const e of edgesIn) {
    if (!e.s || !e.t || e.s === e.t) continue;
    const k = e.s < e.t ? `${e.s}\u0001${e.t}` : `${e.t}\u0001${e.s}`;
    const cur = edgeMap.get(k);
    if (cur) cur[2] += e.w;
    else edgeMap.set(k, [e.s, e.t, e.w]);
    add(e.s, e.t, e.w);
    add(e.t, e.s, e.w);
    w.set(e.s, (w.get(e.s) ?? 0) + e.w);
    w.set(e.t, (w.get(e.t) ?? 0) + e.w);
    if (e.st) types.set(e.s, e.st);
    if (e.tt) types.set(e.t, e.tt);
  }
  const ids = [...adj.keys()];
  // Betweenness (Brandes, unweighted), normalised 0–1; skipped for very large graphs.
  const bc = new Map<string, number>(ids.map((v) => [v, 0]));
  if (ids.length <= 1500) {
    for (const s of ids) {
      const stack: string[] = [];
      const pred = new Map<string, string[]>();
      const sigma = new Map<string, number>([[s, 1]]);
      const dist = new Map<string, number>([[s, 0]]);
      const queue = [s];
      for (let qi = 0; qi < queue.length; qi++) {
        const v = queue[qi];
        stack.push(v);
        for (const u of adj.get(v)!.keys()) {
          if (!dist.has(u)) {
            dist.set(u, dist.get(v)! + 1);
            queue.push(u);
          }
          if (dist.get(u) === dist.get(v)! + 1) {
            sigma.set(u, (sigma.get(u) ?? 0) + sigma.get(v)!);
            pred.set(u, [...(pred.get(u) ?? []), v]);
          }
        }
      }
      const delta = new Map<string, number>();
      while (stack.length) {
        const x = stack.pop()!;
        for (const v of pred.get(x) ?? []) delta.set(v, (delta.get(v) ?? 0) + (sigma.get(v)! / sigma.get(x)!) * (1 + (delta.get(x) ?? 0)));
        if (x !== s) bc.set(x, bc.get(x)! + (delta.get(x) ?? 0));
      }
    }
    const n = ids.length;
    const norm = n > 2 ? (n - 1) * (n - 2) : 1;
    for (const v of ids) bc.set(v, bc.get(v)! / norm);
  }
  // Clusters: weighted label propagation (deterministic order).
  const label = new Map(ids.map((v, i) => [v, i]));
  for (let it = 0; it < 20; it++) {
    let changed = false;
    for (const v of ids) {
      const score = new Map<number, number>();
      for (const [u, x] of adj.get(v)!) score.set(label.get(u)!, (score.get(label.get(u)!) ?? 0) + x);
      let best = label.get(v)!;
      let bs = -1;
      for (const [l, s] of score) if (s > bs || (s === bs && l < best)) [best, bs] = [l, s];
      if (best !== label.get(v)) {
        label.set(v, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const renum = new Map<number, number>();
  const sizes = new Map<number, number>();
  for (const v of ids) sizes.set(label.get(v)!, (sizes.get(label.get(v)!) ?? 0) + 1);
  [...sizes.entries()].sort((a, b) => b[1] - a[1]).forEach(([l], i) => renum.set(l, i));
  return {
    nodes: ids
      .map((id) => ({ id, type: types.get(id), weight: w.get(id) ?? 0, degree: adj.get(id)!.size, betweenness: +(bc.get(id) ?? 0).toFixed(4), cluster: renum.get(label.get(id)!)! }))
      .sort((a, b) => b.weight - a.weight),
    edges: [...edgeMap.values()],
    clusters: renum.size,
  };
}

const parseTime = (v: unknown) => {
  if (v === null || v === undefined || v === "") return NaN;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(" ", "T") + (/[zZ+]/.test(s.slice(19)) ? "" : "Z") : s);
  return Number.isFinite(t) ? t : Number(s);
};
const med = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export type ProcessMap = {
  steps: { name: string; cases: number; events: number; position: number; avgStay: number | null }[];
  transitions: { from: string; to: string; cases: number; avg: number; median: number; total: number }[];
  starts: Record<string, number>;
  ends: Record<string, number>;
  variants: { path: string[]; cases: number; avg: number }[];
  cases: number;
  avgCase: number;
  medianCase: number;
  unit: "hours" | "days" | "units";
};

/** A process map from events: one row per (case, step, time). Times are dates, timestamps or plain numbers. */
export function processMap(events: { c: string; a: string; t: unknown }[]): ProcessMap {
  const byCase = new Map<string, { a: string; t: number }[]>();
  for (const e of events) {
    const t = parseTime(e.t);
    if (!e.c || !e.a || !Number.isFinite(t)) continue;
    if (!byCase.has(e.c)) byCase.set(e.c, []);
    byCase.get(e.c)!.push({ a: e.a, t });
  }
  const dated = events.some((e) => typeof e.t === "string" && /^\d{4}-\d{2}-\d{2}/.test(String(e.t)));
  const toH = (ms: number) => (dated ? ms / 3_600_000 : ms);
  const steps = new Map<string, { cases: Set<string>; events: number; pos: number[]; stay: number[] }>();
  const trans = new Map<string, { from: string; to: string; cases: Set<string>; durs: number[] }>();
  const starts: Record<string, number> = {};
  const ends: Record<string, number> = {};
  const variants = new Map<string, { path: string[]; cases: number; durs: number[] }>();
  const caseDur: number[] = [];
  for (const [c, evs] of byCase) {
    evs.sort((x, y) => x.t - y.t);
    evs.forEach((e, i) => {
      const s = steps.get(e.a) ?? { cases: new Set<string>(), events: 0, pos: [], stay: [] };
      s.cases.add(c);
      s.events++;
      s.pos.push(evs.length > 1 ? i / (evs.length - 1) : 0);
      if (i + 1 < evs.length) s.stay.push(toH(evs[i + 1].t - e.t));
      steps.set(e.a, s);
      if (i + 1 < evs.length) {
        const n = evs[i + 1];
        const k = `${e.a}\u0001${n.a}`;
        const tr = trans.get(k) ?? { from: e.a, to: n.a, cases: new Set<string>(), durs: [] };
        tr.cases.add(c);
        tr.durs.push(toH(n.t - e.t));
        trans.set(k, tr);
      }
    });
    starts[evs[0].a] = (starts[evs[0].a] ?? 0) + 1;
    ends[evs[evs.length - 1].a] = (ends[evs[evs.length - 1].a] ?? 0) + 1;
    const d = toH(evs[evs.length - 1].t - evs[0].t);
    caseDur.push(d);
    const path = evs.map((e) => e.a);
    const vk = path.join("\u0001");
    const v = variants.get(vk) ?? { path, cases: 0, durs: [] };
    v.cases++;
    v.durs.push(d);
    variants.set(vk, v);
  }
  const avgCase = mean(caseDur);
  // Long processes read better in days.
  const unit: ProcessMap["unit"] = !dated ? "units" : avgCase > 72 ? "days" : "hours";
  const u = (h: number) => +(unit === "days" ? h / 24 : h).toFixed(2);
  return {
    steps: [...steps.entries()]
      .map(([name, s]) => ({ name, cases: s.cases.size, events: s.events, position: +mean(s.pos).toFixed(3), avgStay: s.stay.length ? u(mean(s.stay)) : null }))
      .sort((a, b) => a.position - b.position),
    transitions: [...trans.values()]
      .map((t) => ({ from: t.from, to: t.to, cases: t.cases.size, avg: u(mean(t.durs)), median: u(med(t.durs)), total: u(t.durs.reduce((a, b) => a + b, 0)) }))
      .sort((a, b) => b.total - a.total),
    starts,
    ends,
    variants: [...variants.values()].sort((a, b) => b.cases - a.cases).slice(0, 8).map((v) => ({ path: v.path, cases: v.cases, avg: u(mean(v.durs)) })),
    cases: byCase.size,
    avgCase: u(avgCase),
    medianCase: u(med(caseDur)),
    unit,
  };
}

/** Values far from their group's usual range: robust z = 0.6745 × (value − median) / MAD. */
export function anomalies(points: { x: string; g: string; v: number }[], threshold = 3.5) {
  const groups = new Map<string, number[]>();
  for (const p of points) if (Number.isFinite(p.v)) groups.set(p.g, [...(groups.get(p.g) ?? []), p.v]);
  const stats = new Map<string, { m: number; mad: number; sd: number }>();
  for (const [g, vs] of groups) {
    const m = med(vs);
    const mad = med(vs.map((v) => Math.abs(v - m)));
    const mu = mean(vs);
    stats.set(g, { m, mad, sd: Math.sqrt(mean(vs.map((v) => (v - mu) ** 2))) });
  }
  return points.map((p) => {
    const s = stats.get(p.g);
    const z = !s ? 0 : s.mad > 0 ? (0.6745 * (p.v - s.m)) / s.mad : s.sd > 0 ? (p.v - s.m) / (1.2533 * s.sd) : 0;
    return { ...p, median: s?.m ?? 0, z: +z.toFixed(2), flag: Math.abs(z) >= threshold };
  });
}
