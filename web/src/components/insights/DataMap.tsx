"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ECharts } from "echarts";
import { Link2, Plus, Unlink } from "lucide-react";
import { PALETTE } from "./chart-options";
import { readTheme } from "./Chart";

type Col = { name: string; type: string };
type Table = { name: string; source: string; part?: string; rows: number; columns: Col[]; derived?: boolean };
type End = { table: string; column: string };
export type MapLink = { id: string; from: End; to: End; match: number; shared: number; kind: string; by: string; off?: boolean; note?: string };

/**
 * The data map: every table as a node (sized by rows, coloured by file) and every link between
 * columns that hold the same values. People can turn a link off, back on, or add one; links drive
 * the analyst's joins and make board filters reach every linked table.
 */
export default function DataMap({ tables, links, onLink }: { tables: Table[]; links: MapLink[]; onLink: (l: { from: End; to: End; off?: boolean }) => Promise<void> }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ ft: string; fc: string; tt: string; tc: string }>({ ft: "", fc: "", tt: "", tc: "" });
  const active = links.filter((l) => !l.off);
  // One edge per table pair (the strongest), so the picture stays readable.
  const pairs = useMemo(() => {
    const m = new Map<string, MapLink[]>();
    for (const l of active) {
      const k = [l.from.table, l.to.table].sort().join("\u0001");
      m.set(k, [...(m.get(k) ?? []), l]);
    }
    return [...m.values()];
  }, [active]);
  const files = useMemo(() => [...new Set(tables.map((t) => t.source))], [tables]);
  const connected = useMemo(() => new Set(active.flatMap((l) => [l.from.table, l.to.table])), [active]);

  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let dead = false;
    void import("echarts").then((echarts) => {
      if (dead || !box.current) return;
      const t = readTheme(box.current);
      const c = chart.current ?? echarts.init(box.current);
      chart.current = c;
      const maxRows = Math.max(1, ...tables.map((x) => x.rows));
      c.setOption(
        {
          color: PALETTE,
          tooltip: {
            backgroundColor: t.panel,
            borderColor: t.line,
            textStyle: { color: t.ink, fontSize: 12 },
            formatter: (p: unknown) => {
              const x = p as { dataType: string; data: { name?: string; info?: Table; links?: MapLink[] } };
              if (x.dataType === "edge")
                return (x.data.links ?? [])
                  .slice(0, 6)
                  .map((l) => `${l.from.table}.<b>${l.from.column}</b> = ${l.to.table}.<b>${l.to.column}</b><br/><span style="opacity:.7">${Math.round(l.match * 100)}% match · ${l.shared} shared · ${l.kind}</span>`)
                  .join("<br/>");
              const tb = x.data.info!;
              return `<b>${tb.name}</b><br/>${tb.rows.toLocaleString()} rows · ${tb.columns.length} columns<br/><span style="opacity:.7">${tb.source}${tb.part ? `, ${tb.part}` : ""}</span>`;
            },
          },
          legend: { type: "scroll", top: 0, textStyle: { color: t.muted, fontSize: 11 }, data: files },
          series: [
            {
              type: "graph",
              layout: "force",
              roam: true,
              draggable: true,
              top: 30,
              categories: files.map((f) => ({ name: f })),
              force: { repulsion: tables.length > 40 ? 120 : 260, edgeLength: [60, 180], gravity: 0.06 },
              emphasis: { focus: "adjacency", lineStyle: { width: 5 } },
              labelLayout: { hideOverlap: true },
              data: tables.map((tb) => ({
                name: tb.name,
                info: tb,
                category: files.indexOf(tb.source),
                symbolSize: 14 + 34 * Math.sqrt(tb.rows / maxRows),
                itemStyle: { opacity: connected.has(tb.name) ? 1 : 0.35, borderColor: focus === tb.name ? t.ink : t.panel, borderWidth: focus === tb.name ? 3 : 1.5 },
                label: { show: true, position: "right", color: t.ink, fontSize: 11, textBorderColor: t.panel, textBorderWidth: 2, width: 160, overflow: "truncate" },
              })),
              links: pairs.map((ls) => {
                const best = ls.reduce((p, l) => (l.match * l.shared > p.match * p.shared ? l : p));
                return {
                  source: best.from.table,
                  target: best.to.table,
                  links: ls,
                  lineStyle: { width: 1 + 4 * best.match, color: best.by !== "auto" ? t.accent : t.muted, opacity: 0.6, curveness: 0.08 },
                  label: { show: ls.length <= 2 && pairs.length <= 40, formatter: best.from.column === best.to.column ? best.from.column : `${best.from.column} = ${best.to.column}`, fontSize: 10, color: t.muted },
                };
              }),
            },
          ],
        },
        true,
      );
      c.off("click");
      c.on("click", (p) => {
        const x = p as { dataType: string; name: string };
        if (x.dataType === "node") setFocus((f) => (f === x.name ? null : x.name));
      });
      ro = new ResizeObserver(() => c.resize());
      ro.observe(box.current);
    });
    return () => {
      dead = true;
      ro?.disconnect();
    };
  }, [tables, pairs, files, connected, focus]);

  useEffect(() => () => chart.current?.dispose(), []);

  const shown = (focus ? links.filter((l) => l.from.table === focus || l.to.table === focus) : links)
    .slice()
    .sort((a, b) => Number(!!a.off) - Number(!!b.off) || b.match * b.shared - a.match * a.shared);
  const cols = (t: string) => tables.find((x) => x.name === t)?.columns ?? [];
  const act = async (key: string, l: { from: End; to: End; off?: boolean }) => {
    setBusy(key);
    try {
      await onLink(l);
    } finally {
      setBusy(null);
    }
  };

  if (tables.length < 2)
    return (
      <div className="ins-empty">
        <div className="ins-building">
          <Link2 size={24} className="ins-muted" />
          <b>Add a second table to see how they connect</b>
          <span className="ins-muted">The map links sheets and files by columns that hold the same values, like an employee code.</span>
        </div>
      </div>
    );

  return (
    <div className="ins-map">
      <div className="ins-map-graph">
        <div ref={box} style={{ width: "100%", height: "100%" }} />
        <div className="ins-map-hint">
          {active.length} links between {connected.size} of {tables.length} tables. Click a table to see its links. Faded tables aren&apos;t linked to anything.
        </div>
      </div>
      <aside className="ins-map-side">
        <div className="ins-map-head">
          <b>{focus ? focus : "All links"}</b>
          {focus && (
            <button className="ins-link" onClick={() => setFocus(null)}>
              Show all
            </button>
          )}
        </div>
        <div className="ins-map-list">
          {!shown.length && <p className="ins-muted ins-small">No links found{focus ? " for this table" : ""}. Add one below if two columns hold the same values.</p>}
          {shown.slice(0, 200).map((l) => (
            <div key={l.id} className={`ins-map-link${l.off ? " off" : ""}`}>
              <div>
                <span>
                  {l.from.table}.<b>{l.from.column}</b>
                </span>
                <span className="ins-muted"> = </span>
                <span>
                  {l.to.table}.<b>{l.to.column}</b>
                </span>
                <small className="ins-muted">
                  {l.match ? `${Math.round(l.match * 100)}% match · ` : ""}
                  {l.shared} shared · {l.kind}
                  {l.by !== "auto" ? ` · set by ${l.by === "ai" ? "the analyst" : "you"}` : ""}
                  {l.note ? ` · ${l.note}` : ""}
                </small>
              </div>
              <button className="ins-icon-btn" title={l.off ? "Turn this link back on" : "Not a real link: turn it off"} disabled={busy === l.id} onClick={() => act(l.id, { from: l.from, to: l.to, off: !l.off })}>
                {l.off ? <Link2 size={15} /> : <Unlink size={15} />}
              </button>
            </div>
          ))}
        </div>
        <div className="ins-map-add">
          <b>Link two columns</b>
          <div className="ins-map-row">
            <select value={draft.ft} onChange={(e) => setDraft({ ...draft, ft: e.target.value, fc: "" })}>
              <option value="">Table…</option>
              {tables.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
            <select value={draft.fc} onChange={(e) => setDraft({ ...draft, fc: e.target.value })} disabled={!draft.ft}>
              <option value="">Column…</option>
              {cols(draft.ft).map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
          <span className="ins-muted ins-small">holds the same values as</span>
          <div className="ins-map-row">
            <select value={draft.tt} onChange={(e) => setDraft({ ...draft, tt: e.target.value, tc: "" })}>
              <option value="">Table…</option>
              {tables.filter((t) => t.name !== draft.ft).map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
            <select value={draft.tc} onChange={(e) => setDraft({ ...draft, tc: e.target.value })} disabled={!draft.tt}>
              <option value="">Column…</option>
              {cols(draft.tt).map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            className="ix-btn primary"
            disabled={!draft.ft || !draft.fc || !draft.tt || !draft.tc || busy === "new"}
            onClick={async () => {
              await act("new", { from: { table: draft.ft, column: draft.fc }, to: { table: draft.tt, column: draft.tc } });
              setDraft({ ft: "", fc: "", tt: "", tc: "" });
            }}
          >
            <Plus size={14} /> Add link
          </button>
        </div>
      </aside>
    </div>
  );
}
