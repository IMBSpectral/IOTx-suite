"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import { useTabTitle } from "./tabs";

type Row = {
  id: string;
  at: string;
  user: { name: string | null; email: string | null } | null;
  project: { id: string; name: string } | null;
  workspace: string | null;
  app: string;
  feature: string;
  model: string;
  status: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  searches: number;
  cost: number;
  ms: number;
  requestId: string | null;
};
type Data = {
  rows: Row[];
  total: number;
  page: number;
  size: number;
  canAll: boolean;
  totals: { calls: number; input: number; output: number; cacheWrite: number; cacheRead: number; searches: number; cost: number };
  byFeature: { feature: string; calls: number; cost: number; input: number; output: number }[];
  byModel: { model: string; calls: number; cost: number }[];
};

const num = (n: number) => n.toLocaleString("en-IN");
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : num(n));
const money = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const modelName = (m: string) => m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1").replace(/^\w/, (c) => c.toUpperCase());

const RANGES = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "All time" },
];

/**
 * Admin → AI usage: every Claude call across the suite and Workspace, with
 * the tokens Claude reported and the cost at Anthropic's list prices.
 */
export default function AiUsage() {
  useTabTitle("AI usage");
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [days, setDays] = useState(30);
  const [app, setApp] = useState("");
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const params = useCallback(
    (extra: Record<string, string> = {}) =>
      new URLSearchParams({ q, days: String(days), page: String(page), size: String(size), ...(app ? { app } : {}), ...(all ? { scope: "all" } : {}), ...extra }).toString(),
    [q, days, page, size, app, all],
  );

  useEffect(() => {
    let live = true;
    fetch(`/api/ai-usage?${params()}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!live) return;
        if (!r.ok) setError(d.error ?? "Couldn't load AI usage.");
        else {
          setError(null);
          setData(d);
        }
      })
      .catch(() => live && setError("Couldn't load AI usage."));
    return () => {
      live = false;
    };
  }, [params]);

  // Search as they type, a moment after they stop.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(typed.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const t = data?.totals;
  const top = data?.byFeature[0]?.cost || 1;

  return (
    <div className="ix-usage">
      <header className="ix-usage-head">
        <div>
          <h1>AI usage</h1>
          <p>Every Claude call in the suite and Workspace, with the tokens Claude reported and the cost at Anthropic&apos;s list prices.</p>
        </div>
        <a className="ix-btn" href={`/api/ai-usage?${params({ format: "csv" })}`} download>
          <Icon name="insert" size={14} /> Export CSV
        </a>
      </header>

      <div className="ix-usage-filters">
        <div className="ix-usage-search">
          <Icon name="search" size={15} />
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search person, project, feature, model or request id" aria-label="Search AI usage" />
        </div>
        <div className="ix-seg" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => (setDays(r.days), setPage(1))}>
              {r.label}
            </button>
          ))}
        </div>
        <select className="ix-usage-select" value={app} onChange={(e) => (setApp(e.target.value), setPage(1))} aria-label="App">
          <option value="">Suite and Workspace</option>
          <option value="suite">Suite (Builder, AI Chat, Mail…)</option>
          <option value="workspace">Workspace (Calendar, Chat, Meet)</option>
        </select>
        {data?.canAll && (
          <label className="ix-usage-all">
            <input type="checkbox" checked={all} onChange={(e) => (setAll(e.target.checked), setPage(1))} /> All workspaces
          </label>
        )}
      </div>

      {error && <p className="ix-error">{error}</p>}

      <div className="ix-usage-cards">
        <div className="ix-usage-card hero">
          <span>Cost</span>
          <b>{t ? money(t.cost) : "…"}</b>
          <small>{t ? `${num(t.calls)} Claude calls` : ""}</small>
        </div>
        <div className="ix-usage-card">
          <span>Input tokens</span>
          <b>{t ? tok(t.input) : "…"}</b>
          <small>{t ? `+ ${tok(t.cacheWrite)} written to cache` : ""}</small>
        </div>
        <div className="ix-usage-card">
          <span>Cache reads</span>
          <b>{t ? tok(t.cacheRead) : "…"}</b>
          <small>billed at a tenth of input or less</small>
        </div>
        <div className="ix-usage-card">
          <span>Output tokens</span>
          <b>{t ? tok(t.output) : "…"}</b>
          <small>{t ? `${num(t.searches)} web searches` : ""}</small>
        </div>
      </div>

      {data && data.byFeature.length > 0 && (
        <div className="ix-usage-split">
          <section className="ix-card">
            <h2>By feature</h2>
            {data.byFeature.map((f) => (
              <button key={f.feature} type="button" className="ix-usage-bar" onClick={() => setTyped(f.feature)} title={`Show only ${f.feature}`}>
                <span className="name">{f.feature}</span>
                <span className="track">
                  <i style={{ width: `${Math.max(2, (f.cost / top) * 100)}%` }} />
                </span>
                <span className="val">{money(f.cost)}</span>
                <span className="sub">{num(f.calls)} calls</span>
              </button>
            ))}
          </section>
          <section className="ix-card">
            <h2>By model</h2>
            {data.byModel.map((m) => (
              <button key={m.model} type="button" className="ix-usage-model" onClick={() => setTyped(m.model)} title={`Show only ${m.model}`}>
                <b>{modelName(m.model)}</b>
                <span>{money(m.cost)}</span>
                <small>{num(m.calls)} calls</small>
              </button>
            ))}
          </section>
        </div>
      )}

      <section className="ix-card ix-usage-tablecard">
        <div className="ix-usage-tablewrap">
          <table className="ix-usage-table">
            <thead>
              <tr>
                <th>Time</th>
                {all && <th>Workspace</th>}
                <th>Person</th>
                <th>Feature</th>
                <th>Model</th>
                <th className="r">Input</th>
                <th className="r">Cache read</th>
                <th className="r">Output</th>
                <th className="r">Cost</th>
                <th className="r">Time taken</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className={open === r.id ? "on" : ""} onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="nowrap">{when(r.at)}</td>
                    {all && <td>{r.workspace ?? "—"}</td>}
                    <td>
                      <div className="who">{r.user?.name || r.user?.email || <span className="dim">System</span>}</div>
                      {r.project && <div className="dim small">{r.project.name}</div>}
                    </td>
                    <td>
                      <span className={`ix-usage-tag ${r.app}`}>{r.feature}</span>
                      {r.status >= 400 && <span className="ix-usage-err">failed {r.status}</span>}
                    </td>
                    <td className="nowrap">{modelName(r.model)}</td>
                    <td className="r mono">{tok(r.input + r.cacheWrite)}</td>
                    <td className="r mono">{tok(r.cacheRead)}</td>
                    <td className="r mono">{tok(r.output)}</td>
                    <td className="r mono strong">{money(r.cost)}</td>
                    <td className="r mono dim">{(r.ms / 1000).toFixed(1)}s</td>
                  </tr>
                  {open === r.id && (
                    <tr className="detail">
                      <td colSpan={all ? 10 : 9}>
                        <span>Input {num(r.input)}</span>
                        <span>Cache write {num(r.cacheWrite)}</span>
                        <span>Cache read {num(r.cacheRead)}</span>
                        <span>Output {num(r.output)}</span>
                        <span>Web searches {r.searches}</span>
                        <span>Model {r.model}</span>
                        <span>App {r.app}</span>
                        {r.requestId && <span className="mono">Request {r.requestId}</span>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {data && !data.rows.length && (
                <tr>
                  <td colSpan={all ? 10 : 9} className="empty">
                    {q ? `Nothing matches "${q}".` : "No Claude calls in this period yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <footer className="ix-usage-pager">
          <span className="dim">{data ? `${num(data.total)} calls · page ${data.page} of ${num(pages)}` : "Loading…"}</span>
          <select className="ix-usage-select" value={size} onChange={(e) => (setSize(Number(e.target.value)), setPage(1))} aria-label="Rows per page">
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} per page
              </option>
            ))}
          </select>
          <button type="button" className="ix-btn" disabled={page <= 1} onClick={() => setPage(1)}>
            First
          </button>
          <button type="button" className="ix-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <button type="button" className="ix-btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </footer>
      </section>
      <p className="ix-usage-note">
        Costs use Anthropic&apos;s list prices per million tokens (for example Opus 5.5: $4 input, $20 output, $0.20 cache read; Sonnet 5.5: $2 / $10; Haiku 5.5: $0.10 / $0.50),
        cache writes at 1.25× input and $10 per 1,000 web searches. Your Anthropic invoice is the final figure; discounts or batch pricing aren&apos;t reflected here.
      </p>
    </div>
  );
}
