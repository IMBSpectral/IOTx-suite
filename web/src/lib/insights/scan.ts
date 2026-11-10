/**
 * Insights scan: notable facts found by brute force before the AI looks, so it starts from
 * what stands out instead of guessing where to dig. All computed in DuckDB:
 * - concentration: one group holding a large share of a total ("Ramjan's crew: 33% of deposition")
 * - gaps: groups far above or below the average
 * - outliers: values far from the column's usual range (robust: median and MAD)
 * - trends: the latest periods against the ones before
 * - gaps in the data: mostly-blank columns
 */
import { query } from "./engine";
import type { Analysis, Table } from "./store";

const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
const NUM = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL.*)$/i;
const ID = /(^|\b|_)(id|code|no\.?|number|num|phone|mobile|account|a\/c|pin|zip|year|uan|esic|pan|aadhaar|adhaar|s\.?\s?no\.?|sr\.?\s?no\.?|sl\.?\s?no\.?|sheet)(\b|_|$)/i;
const fmt = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-IN") : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

type Fact = { score: number; text: string };

async function scanTable(a: Analysis, t: Table, facts: Fact[]) {
  if (t.rows < 8) return;
  const T = q(t.name);
  const prof = await query(a, `SUMMARIZE ${T}`, { limit: 500 }).catch(() => null);
  if (!prof) return;
  const ix = (n: string) => prof.columns.findIndex((c) => c.name === n);
  const info = prof.rows.map((r) => ({ name: String(r[0]), type: String(r[1]), uniq: Number(r[ix("approx_unique")]), nulls: Number(String(r[ix("null_percentage")]).replace("%", "")) }));
  const measures = info.filter((c) => NUM.test(c.type) && !ID.test(c.name) && c.uniq > 5).slice(0, 5);
  const dims = info.filter((c) => /VARCHAR|BOOLEAN/i.test(c.type) && c.uniq >= 2 && c.uniq <= 30 && c.nulls < 50 && !ID.test(c.name)).slice(0, 5);
  const dates = info.filter((c) => /^(DATE|TIMESTAMP)/i.test(c.type) && c.uniq >= 6).slice(0, 2);

  for (const c of info) if (c.nulls >= 30 && c.nulls < 100) facts.push({ score: 0.3, text: `${T}.${q(c.name)} is ${c.nulls.toFixed(0)}% blank.` });

  for (const d of dims)
    for (const m of measures) {
      const r = await query(
        a,
        `SELECT CAST(${q(d.name)} AS VARCHAR) g, sum(${q(m.name)}) s, avg(${q(m.name)}) av, count(*) n FROM ${T} WHERE ${q(m.name)} IS NOT NULL GROUP BY 1 ORDER BY s DESC NULLS LAST`,
        { limit: 40 },
      ).catch(() => null);
      if (!r || r.rows.length < 2) continue;
      const rows = r.rows.map((x) => ({ g: String(x[0] ?? "(blank)"), s: Number(x[1]), av: Number(x[2]), n: Number(x[3]) }));
      const total = rows.reduce((s, x) => s + x.s, 0);
      const n = rows.reduce((s, x) => s + x.n, 0);
      const avgAll = rows.reduce((s, x) => s + x.av * x.n, 0) / (n || 1);
      const top = rows[0];
      const share = total ? top.s / total : 0;
      const fair = 1 / rows.length;
      if (total > 0 && share >= Math.max(0.35, 2 * fair))
        facts.push({ score: share - fair, text: `${q(top.g)} holds ${(share * 100).toFixed(0)}% of total ${m.name} in ${T} (${rows.length} ${d.name} values; an even split would be ${(fair * 100).toFixed(0)}%).` });
      const big = rows.filter((x) => x.n >= Math.max(3, n * 0.03));
      if (big.length >= 2 && avgAll) {
        const hi = big.reduce((p, x) => (x.av > p.av ? x : p));
        const lo = big.reduce((p, x) => (x.av < p.av ? x : p));
        const ratio = lo.av ? hi.av / lo.av : 0;
        if (ratio >= 1.4 && lo.av > 0)
          facts.push({
            score: Math.min(1, (ratio - 1) / 3),
            text: `Average ${m.name} by ${d.name} in ${T}: highest ${q(hi.g)} ${fmt(hi.av)} vs lowest ${q(lo.g)} ${fmt(lo.av)} (${ratio.toFixed(1)}×; overall ${fmt(avgAll)}, n=${hi.n}/${lo.n}).`,
          });
      }
    }

  for (const m of measures) {
    const r = await query(
      a,
      `WITH s AS (SELECT median(${q(m.name)}) med FROM ${T}), d AS (SELECT median(abs(${q(m.name)} - s.med)) mad FROM ${T}, s)
       SELECT s.med, d.mad, count(*) FILTER (WHERE d.mad > 0 AND abs(0.6745 * (${q(m.name)} - s.med) / d.mad) >= 3.5) n, max(${q(m.name)}) mx, min(${q(m.name)}) mn
       FROM ${T}, s, d GROUP BY s.med, d.mad`,
      { limit: 1 },
    ).catch(() => null);
    const row = r?.rows[0];
    if (!row) continue;
    const k = Number(row[2]);
    if (k > 0 && k <= t.rows * 0.1) facts.push({ score: 0.45, text: `${k} unusual ${m.name} values in ${T} (typical ${fmt(Number(row[0]))}; range ${fmt(Number(row[4]))} to ${fmt(Number(row[3]))}). Worth checking for errors or special cases.` });
  }

  for (const dt of dates)
    for (const m of measures.slice(0, 3)) {
      const r = await query(a, `SELECT date_trunc('month', ${q(dt.name)}) p, sum(${q(m.name)}) s, count(*) n FROM ${T} WHERE ${q(dt.name)} IS NOT NULL GROUP BY 1 ORDER BY 1`, { limit: 400 }).catch(() => null);
      if (!r || r.rows.length < 6) continue;
      const pts = r.rows.map((x) => ({ p: String(x[0]).slice(0, 7), s: Number(x[1]), n: Number(x[2]) }));
      // Leave out a last period with far fewer rows (probably partial).
      const medN = [...pts.map((x) => x.n)].sort((x, y) => x - y)[pts.length >> 1];
      if (pts[pts.length - 1].n < medN * 0.4) pts.pop();
      if (pts.length < 6) continue;
      const k = Math.min(3, Math.floor(pts.length / 2));
      const recent = pts.slice(-k).reduce((s, x) => s + x.s, 0) / k;
      const before = pts.slice(-2 * k, -k).reduce((s, x) => s + x.s, 0) / k;
      if (!before) continue;
      const ch = recent / before - 1;
      if (Math.abs(ch) >= 0.1)
        facts.push({
          score: Math.min(1, Math.abs(ch)),
          text: `Monthly ${m.name} in ${T} ${ch > 0 ? "rose" : "fell"} ${Math.abs(ch * 100).toFixed(0)}%: last ${k} months (${pts.slice(-k)[0].p} to ${pts[pts.length - 1].p}) average ${fmt(recent)} vs ${fmt(before)} the ${k} before.`,
        });
    }
}

/** The most notable facts across the analysis's tables (visible sheets first), as lines for the AI. */
export async function scan(a: Analysis, limit = 30) {
  const facts: Fact[] = [];
  const tables = [...a.tables].sort((x, y) => Number(/hidden/.test(x.part ?? "")) - Number(/hidden/.test(y.part ?? "")) || y.rows - x.rows).slice(0, 12);
  const started = Date.now();
  for (const t of tables) {
    if (Date.now() - started > 45_000) break;
    await scanTable(a, t, facts).catch(() => {});
  }
  return facts
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((f) => `- ${f.text}`)
    .join("\n");
}
