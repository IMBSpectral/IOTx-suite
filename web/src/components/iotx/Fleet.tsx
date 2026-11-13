"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTabTitle } from "./tabs";
import type { FleetServer, ServerUsage } from "@/lib/fleet";

type Log = { markdown: string | null; updatedAt: string | null; servers: FleetServer[] };

const num = (n: number) => n.toLocaleString("en-IN");
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : num(n));
const money = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const modelName = (m: string) => m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1").replace(/^\w/, (c) => c.toUpperCase());
const RANGES = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "All time" },
];
// One colour per server, in server order (readable on light and dark).
const COLORS = ["#6d4aff", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#a855f7", "#14b8a6", "#f97316"];

/**
 * Admin → Deployments (control server): every server the suite runs on, who it's for, its
 * deploy history, and its AI usage, side by side.
 */
export default function Fleet() {
  useTabTitle("Deployments");
  const [tab, setTab] = useState<"log" | "usage">("log");
  return (
    <div className="ix-usage">
      <header className="ix-usage-head">
        <div>
          <h1>Deployments</h1>
          <p>Every server the suite runs on: who it&apos;s for, what has been deployed there, and how much AI it uses.</p>
        </div>
      </header>
      <div className="ix-seg" role="group" aria-label="View" style={{ marginBottom: 16 }}>
        <button type="button" aria-pressed={tab === "log"} onClick={() => setTab("log")}>
          Deployment log
        </button>
        <button type="button" aria-pressed={tab === "usage"} onClick={() => setTab("usage")}>
          AI usage, all servers
        </button>
      </div>
      {tab === "log" ? <LogView /> : <UsageView />}
    </div>
  );
}

function LogView() {
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/fleet/overview?view=log", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) setError(d.error ?? "Couldn't load the deployment log.");
        else setLog(d);
      })
      .catch(() => setError("Couldn't load the deployment log."));
  }, []);
  // The servers table is shown as cards above, so it's taken out of the history below.
  const history = useMemo(() => (log?.markdown ?? "").replace(/^# Deployments[\s\S]*?(?=^## (?!Servers))/m, ""), [log]);
  if (error) return <p className="ix-error">{error}</p>;
  if (!log) return <p className="dim">Loading…</p>;
  if (!log.markdown) return <p className="dim">No deployment log yet. It arrives with the next deploy (or run deploy/ship.sh log).</p>;
  return (
    <>
      <div className="ix-fleet-servers">
        {log.servers.map((s) => (
          <section key={s.name} className="ix-card ix-fleet-server">
            <h2>{s.client || s.name}</h2>
            <a href={s.url} target="_blank" rel="noreferrer" className="ix-fleet-domain">
              {s.domain || s.url}
            </a>
            <dl>
              <dt>Server</dt>
              <dd>{s.name}</dd>
              <dt>Droplet</dt>
              <dd>{s.droplet || s.host}</dd>
              <dt>Region</dt>
              <dd>{s.region}</dd>
              <dt>Size</dt>
              <dd>{s.size}</dd>
              <dt>Switched off</dt>
              <dd>{s.off || "none"}</dd>
              <dt>Live since</dt>
              <dd>{s.since}</dd>
            </dl>
            {s.notes && <p className="dim small">{s.notes}</p>}
          </section>
        ))}
      </div>
      <section className="ix-card ix-fleet-md">
        <p className="dim small">Updated after every deploy{log.updatedAt ? `; last on ${new Date(log.updatedAt).toLocaleString()}` : ""}.</p>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{history}</ReactMarkdown>
      </section>
    </>
  );
}

function UsageView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ days: number; servers: ServerUsage[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/fleet/overview?view=usage&days=${days}`, { cache: "no-store" })
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
  }, [days]);

  const ok = useMemo(() => (data?.servers ?? []).filter((s) => s.usage), [data]);
  const total = ok.reduce(
    (a, s) => {
      const t = s.usage!.totals;
      return { cost: a.cost + t.cost, calls: a.calls + t.calls, failed: a.failed + t.failed, input: a.input + t.input + t.cacheWrite, output: a.output + t.output, cacheRead: a.cacheRead + t.cacheRead };
    },
    { cost: 0, calls: 0, failed: 0, input: 0, output: 0, cacheRead: 0 },
  );
  const color = (name: string) => COLORS[(data?.servers ?? []).findIndex((s) => s.server.name === name) % COLORS.length];

  // Daily cost, one stacked bar per day, a segment per server.
  const days_ = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const s of ok) for (const d of s.usage!.byDay) {
      if (!m.has(d.day)) m.set(d.day, new Map());
      m.get(d.day)!.set(s.server.name, d.cost);
    }
    const list = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-90);
    const max = Math.max(0.0001, ...list.map(([, v]) => [...v.values()].reduce((a, b) => a + b, 0)));
    return { list, max };
  }, [ok]);

  return (
    <>
      <div className="ix-usage-filters">
        <div className="ix-seg" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="ix-error">{error}</p>}

      <div className="ix-usage-cards">
        <div className="ix-usage-card hero">
          <span>Cost, all servers</span>
          <b>{data ? money(total.cost) : "…"}</b>
          <small>{data ? `${num(total.calls)} Claude calls${total.failed ? `, ${num(total.failed)} failed` : ""}` : ""}</small>
        </div>
        <div className="ix-usage-card">
          <span>Input tokens</span>
          <b>{data ? tok(total.input) : "…"}</b>
          <small>{data ? `+ ${tok(total.cacheRead)} read from cache` : ""}</small>
        </div>
        <div className="ix-usage-card">
          <span>Output tokens</span>
          <b>{data ? tok(total.output) : "…"}</b>
          <small>&nbsp;</small>
        </div>
        <div className="ix-usage-card">
          <span>Servers reporting</span>
          <b>{data ? `${ok.length} of ${data.servers.length}` : "…"}</b>
          <small>{data && ok.length < data.servers.length ? "see the cards below" : " "}</small>
        </div>
      </div>

      <div className="ix-fleet-servers">
        {(data?.servers ?? []).map((s) => {
          const t = s.usage?.totals;
          const share = t && total.cost > 0 ? (t.cost / total.cost) * 100 : 0;
          return (
            <section key={s.server.name} className="ix-card ix-fleet-server">
              <h2>
                <i className="ix-fleet-dot" style={{ background: color(s.server.name) }} aria-hidden /> {s.server.client || s.server.name}
              </h2>
              <span className="ix-fleet-domain">{s.server.domain || s.server.url}</span>
              {s.error ? (
                <p className="ix-error small">{s.error}</p>
              ) : t ? (
                <>
                  <b className="ix-fleet-cost">{money(t.cost)}</b>
                  <div className="ix-usage-bar static">
                    <span className="track">
                      <i style={{ width: `${Math.max(1, share)}%`, background: color(s.server.name) }} />
                    </span>
                    <span className="sub">{share.toFixed(0)}% of all</span>
                  </div>
                  <dl>
                    <dt>Claude calls</dt>
                    <dd>
                      {num(t.calls)}
                      {t.failed ? ` (${num(t.failed)} failed)` : ""}
                    </dd>
                    <dt>Input / output</dt>
                    <dd>
                      {tok(t.input + t.cacheWrite)} / {tok(t.output)}
                    </dd>
                    <dt>Top model</dt>
                    <dd>{s.usage!.byModel[0] ? modelName(s.usage!.byModel[0].model) : "—"}</dd>
                  </dl>
                  <button type="button" className="ix-btn" onClick={() => setOpen(open === s.server.name ? null : s.server.name)}>
                    {open === s.server.name ? "Hide details" : "Details"}
                  </button>
                </>
              ) : (
                <p className="dim">Loading…</p>
              )}
            </section>
          );
        })}
      </div>

      {days_.list.length > 0 && (
        <section className="ix-card ix-fleet-chart">
          <h2>Cost per day</h2>
          <div className="ix-fleet-bars" role="img" aria-label="Daily AI cost per server">
            {days_.list.map(([day, v]) => {
              const sum = [...v.values()].reduce((a, b) => a + b, 0);
              return (
                <div key={day} className="col" title={`${day}: ${money(sum)}\n${[...v.entries()].map(([n, c]) => `${n} ${money(c)}`).join("\n")}`}>
                  <div className="stack" style={{ height: `${(sum / days_.max) * 100}%` }}>
                    {[...v.entries()].map(([n, c]) => (
                      <i key={n} style={{ flexGrow: c, background: color(n) }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="ix-fleet-legend">
            {ok.map((s) => (
              <span key={s.server.name}>
                <i className="ix-fleet-dot" style={{ background: color(s.server.name) }} /> {s.server.client || s.server.name}
              </span>
            ))}
            <span className="dim">
              {days_.list[0]?.[0]} to {days_.list[days_.list.length - 1]?.[0]}
            </span>
          </div>
        </section>
      )}

      {open &&
        (() => {
          const s = ok.find((x) => x.server.name === open);
          if (!s) return null;
          const u = s.usage!;
          const lists: [string, { name: string; calls: number; cost: number }[]][] = [
            ["By workspace", u.byWorkspace],
            ["By person", u.byPerson],
            ["By feature", u.byFeature.map((f) => ({ name: f.feature, calls: f.calls, cost: f.cost }))],
            ["By model", u.byModel.map((m) => ({ name: modelName(m.model), calls: m.calls, cost: m.cost }))],
            ["By app", u.byApp.map((a) => ({ name: a.app === "suite" ? "Suite (Builder, AI Chat, Insights…)" : a.app === "workspace" ? "Workspace" : a.app, calls: a.calls, cost: a.cost }))],
          ];
          return (
            <section className="ix-card">
              <h2>{s.server.client || s.server.name}: where the AI goes</h2>
              <div className="ix-fleet-detail">
                {lists.map(([title, rows]) => {
                  const top = rows[0]?.cost || 1;
                  return (
                    <div key={title}>
                      <h3>{title}</h3>
                      {rows.length === 0 && <p className="dim small">Nothing in this period.</p>}
                      {rows.map((r) => (
                        <div key={r.name} className="ix-usage-bar static">
                          <span className="name">{r.name}</span>
                          <span className="track">
                            <i style={{ width: `${Math.max(2, (r.cost / top) * 100)}%`, background: color(s.server.name) }} />
                          </span>
                          <span className="val">{money(r.cost)}</span>
                          <span className="sub">{num(r.calls)} calls</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })()}

      <p className="ix-usage-note">
        Each server reports its own totals; prompts and replies never leave a server. Costs use Anthropic&apos;s list prices, so your Anthropic invoice is the final figure.
        Servers that share your AI keys all bill to your Anthropic account.
      </p>
    </>
  );
}
