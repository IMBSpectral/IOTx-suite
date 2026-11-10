/**
 * Insights analyst: Claude with the analysis's data behind tools.
 *
 * The AI decides what to look at; DuckDB computes every number and ECharts draws it.
 * It never invents a figure: each chart is a SQL query the server runs, so the board
 * stays live (filters re-run it) and every number can be traced to its query.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { meteredFetch } from "../ai-meter";
import { assertCredits, charge, creditsForUsage } from "../credits";
import { discoverLinks, linksText, profile, query, freeName, tableFromQuery, rowCount } from "./engine";
import { scan } from "./scan";
import { readDoc } from "./ingest";
import { compute, describe as describeModel, MODEL_KINDS } from "./compute";
import { saveAnalysis, withLock, type Analysis, type Widget } from "./store";

const MODEL = process.env.INSIGHTS_MODEL?.trim() || "claude-opus-5-5";
const workspaceHeader = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceHeader ? { defaultHeaders: { "anthropic-workspace-id": workspaceHeader } } : {}), fetch: meteredFetch("Insights") });

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thought"; delta: string }
  | { type: "step"; label: string }
  | { type: "board"; board: Widget[] }
  | { type: "tables"; tables: Analysis["tables"] }
  | { type: "questions"; questions: string[] }
  | { type: "name"; name: string };

export const CHART_KINDS = [
  "kpi", "insight", "bar", "hbar", "stacked", "line", "area", "combo", "pie", "donut", "scatter", "bubble",
  "heatmap", "treemap", "sunburst", "funnel", "histogram", "boxplot", "sankey", "radar", "gauge", "calendar",
  "waterfall", "pareto", "table", "bullet", "forecast", "drivers", "whatif", "correlation", "network", "process", "anomalies",
] as const;

const KIND_GUIDE = `Chart kinds and the columns each needs (x, y, series name columns your SQL returns):
- kpi: one row; y[0] the value, optional y[1] the comparison value (previous period) to show the change; format/unit.
- insight: a finding card, no SQL needed: title + insight text, tone good|bad|watch|neutral. Optional sql returning one number as y[0].
- bar / hbar (horizontal, best for long labels or rankings) / stacked: x category, y one or more measures, or series to split.
- line / area: x date or ordered value, y measures, optional series. Time charts get a zoom slider and a draggable range filter.
- combo: x, y[0] bars, y[1] line on a second axis (e.g. revenue and margin %).
- pie / donut: x category, y[0] value (keep to <= 8 slices; group the rest as Other in SQL).
- scatter / bubble: x and y[0] numeric, optional y[1] bubble size, optional series for colour. Good for relationships.
- heatmap: x category, series the second category, y[0] value (e.g. department × month). Also a correlation matrix.
- treemap / sunburst: x the top level, series the second level (optional), y[0] value. Composition at a glance.
- funnel: x stage, y[0] count, in stage order.
- histogram: bin the numbers in SQL (x the bin label in order, y[0] count). Distributions.
- boxplot: x group, y = [min, q1, median, q3, max] computed in SQL (quantile_cont). Spread and outliers by group.
- sankey: x from, series to, y[0] flow value. Flows between stages, places or categories (where work or money goes).
- radar: x the measure name, series the item, y[0] value (scaled 0–100 works best). Comparing profiles.
- gauge: one row, y[0] value, options.max the target.
- calendar: x date, y[0] value. Daily patterns over a year.
- waterfall: x step, y[0] change (positive or negative), in order. How a total builds up or what moved it.
- pareto: x category, y[0] value sorted descending; shows the cumulative % line (the vital few).
- table: any columns; for detail lists (top 20, exceptions).
- bullet: x category, y[0] actual, y[1] target; horizontal bars with the target marked, coloured by whether each meets it. For actual vs plan, budget, quota or norm.

Models (computed on the server from the query's rows, re-run when the board is filtered; try them with run_model first):
- forecast: SQL returns one row per period (x = the period start date, y[0] = the value), ordered; aggregate to day, week or month first. options.horizon = periods ahead (default one season). Draws history, forecast and 80%/95% ranges, picking the method (steady, trend, damped trend, seasonal Holt-Winters, linear) that best predicted the most recent stretch of history. Say how accurate the backtest was.
- drivers: SQL returns one row per record (order, employee, day…) with options.target (a number, or a yes/no column) and the candidate factors as other columns (or list them in options.features). Ranks factors by how much of the variation each explains on its own, with effects in the target's units (yes/no targets: percentage points). Leave out ids, names and columns that are part of the target (a total's own components); bucket dates into month or weekday first if useful. Associations, not proof of cause: say so when it matters.
- whatif: the same inputs as drivers; shows a live calculator where people move each factor and see the predicted target. Add one after a drivers chart when people will want to test scenarios ("what if machining took 2 days less?").
- correlation: SQL returns numeric columns (or list them in y); a matrix of correlations (-1 to 1). options.method 'spearman' for ranks (robust to outliers). For finding which measures move together.
- network: a relationship graph. SQL returns one row per connection: x = from, series = to, y[0] = strength (optional; count or amount). options.sourceType / targetType name the two kinds of node (e.g. "Welder", "Contractor") so they get different colours. The app finds clusters (groups that work together) and connectors (nodes on the most paths between others: key people, single points of failure). Good for people × teams, suppliers × parts, customers × products, who-reports-to-whom, co-occurrence (two things in the same order/shift). Keep it readable: at most ~300 links; filter to the strongest.
- process: a process map from an event log. SQL returns one row per event: x = case id (order, ticket, employee…), series = step name, options.time = the column with when it happened (date or timestamp). Shows the flow between steps, how long each hand-over takes and where cases wait longest (bottlenecks, in red), plus the most common paths. Wide data with one date column per stage (Ordered date, Cut date, Shipped date…) must be unpivoted into events in SQL first (UNION ALL of one SELECT per stage).
- anomalies: SQL returns x (a label or date), y[0] the value, optional series to judge each group against its own normal range. Flags values far from typical (robust score ≥ options.threshold, default 3.5) and lists them. For catching data errors, fraud, breakdowns and exceptional days.`;

const SYSTEM = `You are the analyst inside Insights, a data analysis app. People bring spreadsheets, CSVs, Word, PDF and PowerPoint files; you read all of it, find what matters and build a live, interactive board of charts with plain-English findings, then discuss it with them.

How you work
- Every number comes from the data through SQL (DuckDB dialect). Never estimate, round loosely or invent a figure. Check a number with run_sql before you state it.
- Look before you chart: profile the tables, check how they join, check for blanks, duplicates, totals rows mixed with detail rows, and units. Mention data problems you find and how you handled them.
- Build charts with add_chart. Each chart is a SQL query the app re-runs when people click to filter, so query the base tables by name (quote names with double quotes) and keep the query self-contained. Name result columns readably ("Total pay", not sum_pay).
- Set filter on a chart to the source column its x axis represents ("Department" or "Table.Column") so a click on a bar filters the whole board by it.
- Every chart gets an insight: one or two sentences with the actual numbers that say what it shows and why it matters ("HR's overtime is 2.4× the company average, 61% of it in March"). The title says what the reader learns, not just what is plotted.
- Pick the chart that answers the question best, not just bars and lines. Use rankings, distributions, composition, flows, relationships and change over time where they fit. Use KPI cards for the 3–5 numbers that matter most, at the top.
- Insight cards (kind "insight") carry the findings: drivers, risks, anomalies, opportunities, bottlenecks. Lead with the most important one.
- Board layout: size is the width out of 12 (KPI 3, insight 4–6, most charts 6, wide time series and tables 12). Order: KPIs, key findings, then charts from most to least important.
- For documents (Word, PDF, slides, notes): read them with read_document. If they contain tables or figures worth analysing, turn them into a table with save_table, then chart them like any other data. Use document context (targets, policies, notes) to judge what the numbers mean.
- You may create cleaned or joined tables with save_table (from a SELECT) when it makes later charts simpler and more correct.
- Statistics are welcome when they help: correlation (corr), regression slope (regr_slope, regr_r2), percentiles, growth rates, moving averages (window functions), shares of total, z-scores for outliers. Explain them in plain words.
- Talk like a sharp, friendly analyst: short paragraphs, the key numbers, what to do about it. No jargon without explaining it. Don't list the tool calls you made.
- End each reply with suggest_next: 3–5 specific follow-up questions this data can answer.
- When the data has just been added and there's no board yet: give it a short descriptive name (rename), then build a rich first board with add_charts (several items per call): 3–5 KPIs, 3–5 finding cards, and 8–14 charts that cover the data from different angles: rankings, composition, trends, distributions, relationships between measures, and, wherever the data has them, a network of how things connect (people, teams, suppliers, products), a process map for step-by-step records, anomalies, and a forecast or drivers chart. Start from the "Notable facts" scan, check each before using it. Summarise the most important findings in a few sentences, then ask what decisions they want to make so you can go deeper.
- Use the data map ("How tables link"): join tables on those columns to combine sheets (for example attendance with the salary sheet by employee code). If you find a link that's missing or wrong, fix it with set_link, because links also make board filters reach every linked sheet.
- When asked to change the board (remove, resize, change a chart type), do it with the tools; you can see each chart's id in the board list.

${KIND_GUIDE}`;

function boardText(board: Widget[]) {
  if (!board.length) return "The board is empty.";
  return board.map((w, i) => `${i + 1}. [${w.id}] ${w.kind} "${w.title}" size ${w.size ?? 6}${w.filter ? ` filter ${w.filter}` : ""}${w.sql ? `\n   SQL: ${w.sql.replace(/\s+/g, " ").slice(0, 400)}` : ""}`).join("\n");
}

const preview = (r: Awaited<ReturnType<typeof query>>, n = 30) =>
  [r.columns.map((c) => `${c.name} (${c.type})`).join("\t"), ...r.rows.slice(0, n).map((row) => row.map((v) => (v === null ? "∅" : String(v))).join("\t"))].join("\n") +
  (r.rows.length > n ? `\n… ${r.rows.length - n} more rows` : "");

/** One turn of the conversation. Updates and saves the analysis as it goes. */
export async function runAgent(a: Analysis, userId: string, text: string, on: (e: AgentEvent) => void) {
  await assertCredits(a.workspaceId, { userId });
  const save = () => withLock(a.id, () => saveAnalysis(a));
  const step = (label: string) => on({ type: "step", label });
  const steps: string[] = [];
  const note = (label: string) => {
    steps.push(label);
    step(label);
  };
  let questions: string[] = [];

  const checkChart = async (w: Widget) => {
    if (!w.sql) return w.kind === "insight" ? "ok" : "This chart needs sql.";
    const model = MODEL_KINDS.has(w.kind);
    const r = await query(a, w.sql, { limit: model ? 50_000 : 2000 });
    const names = r.columns.map((c) => c.name);
    for (const c of [w.x, w.series, ...(w.y ?? [])].filter(Boolean) as string[])
      if (!names.includes(c)) return `The query returns ${names.join(", ")}; there's no column "${c}". Fix x/y/series or the SQL.`;
    if (!r.rows.length) return `The query returned no rows. Check it before charting:\n${preview(r)}`;
    if (model) {
      try {
        return `Model result:\n${describeModel(w, compute(w, r))}`;
      } catch (e) {
        return `The query returns ${names.join(", ")}; the model couldn't run: ${(e as Error).message}`;
      }
    }
    return `Chart data (${r.rows.length} rows${r.truncated ? ", more cut off" : ""}):\n${preview(r)}`;
  };

  /** Check one item against the data and put it on the board; the result tells the AI what it shows. */
  const addOne = async (w: Omit<Widget, "id">, after?: string) => {
    const widget = { id: randomUUID().slice(0, 8), ...w, size: w.size ?? (w.kind === "kpi" ? 3 : w.kind === "insight" ? 6 : ["network", "process"].includes(w.kind) ? 12 : 6) } as Widget;
    let check: string;
    try {
      check = await checkChart(widget);
    } catch (e) {
      return `Not added. SQL error: ${(e as Error).message}`;
    }
    if (check.startsWith("The query") || check.startsWith("This chart")) return `Not added. ${check}`;
    const at = after ? a.board.findIndex((x) => x.id === after) : -1;
    if (at >= 0) a.board.splice(at + 1, 0, widget);
    else a.board.push(widget);
    on({ type: "board", board: a.board });
    note(`Added ${widget.kind === "kpi" ? "KPI" : widget.kind === "insight" ? "finding" : "chart"}: ${widget.title}`);
    await save();
    return `Added [${widget.id}]. ${check}`;
  };

  const chartShape = {
    kind: z.enum(CHART_KINDS),
    title: z.string().max(140).describe("What the reader learns"),
    subtitle: z.string().max(200).optional(),
    insight: z.string().max(900).optional().describe("1–2 sentences with real numbers: what it shows and why it matters"),
    sql: z.string().max(12000).optional().describe("DuckDB SELECT over the tables; result columns named readably"),
    x: z.string().optional(),
    y: z.array(z.string()).max(6).optional(),
    series: z.string().optional(),
    size: z.number().int().min(2).max(12).optional().describe("Width out of 12"),
    filter: z.string().optional().describe("Source column a click filters by: Column or Table.Column"),
    tone: z.enum(["good", "bad", "neutral", "watch"]).optional(),
    format: z.enum(["number", "percent", "currency", "duration"]).optional().describe("percent expects 0.25 for 25%"),
    unit: z.string().max(12).optional().describe("Currency symbol or unit, e.g. ₹, $, hrs"),
    options: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Extras: max (gauge target), stack (true), smooth (true), average (true). forecast: horizon, period. drivers/whatif: target, features. correlation: method ('pearson'|'spearman')"),
  };

  const tools = [
    betaZodTool({
      name: "run_model",
      description:
        "Run a statistical model on a query's rows and read the result before charting it: forecast (x date, y value; options.horizon), " +
        "drivers (what moves options.target; options.features or every other column), correlation (numeric columns, or y). " +
        "Same inputs as add_chart with kind forecast / drivers / correlation.",
      inputSchema: z.object({
        kind: z.enum(["forecast", "drivers", "correlation"]),
        sql: z.string().max(12000),
        x: z.string().optional(),
        y: z.array(z.string()).max(20).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
        why: z.string().max(120).optional(),
      }),
      run: async ({ kind, sql, x, y, options, why }) => {
        note(why || (kind === "forecast" ? "Ran a forecast" : kind === "drivers" ? "Found what drives it" : "Measured correlations"));
        try {
          const w = { id: "probe", kind, title: "", sql, x, y, options } as Widget;
          const r = await query(a, sql, { limit: 50_000 });
          if (!r.rows.length) return "The query returned no rows.";
          return describeModel(w, compute(w, r));
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    }),
    betaZodTool({
      name: "run_sql",
      description: "Run one DuckDB SELECT (WITH, SUMMARIZE and DESCRIBE allowed) over the analysis's tables and see the result. Up to 200 rows shown.",
      inputSchema: z.object({ sql: z.string().max(12000), why: z.string().max(120).optional().describe("A few words shown to the user, e.g. 'Checking overtime by department'") }),
      run: async ({ sql, why }) => {
        note(why || "Queried the data");
        try {
          return preview(await query(a, sql, { limit: 5000 }), 200);
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    }),
    betaZodTool({
      name: "profile_table",
      description: "Every column of a table: type, blanks, range or most common values, and sample rows (all rows when small).",
      inputSchema: z.object({ table: z.string() }),
      run: async ({ table }) => {
        note(`Profiled ${table}`);
        if (!a.tables.some((t) => t.name === table)) return `No table "${table}". Tables: ${a.tables.map((t) => t.name).join(", ")}`;
        return profile(a, { table, sampleRows: 25, wholeUnder: 200 });
      },
    }),
    betaZodTool({
      name: "read_document",
      description: "Read a document's text (Word, PDF, slides, notes): a range of characters, or the passages around a search term.",
      inputSchema: z.object({ file: z.string().describe("File id or name"), from: z.number().int().min(0).optional(), find: z.string().max(200).optional() }),
      run: async ({ file, from, find }) => {
        note(`Read ${a.sources.find((s) => s.id === file || s.name === file)?.name ?? file}`);
        try {
          return await readDoc(a, file, { from, find });
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    }),
    betaZodTool({
      name: "save_table",
      description:
        "Create a table: from a SELECT over existing tables (cleaned, joined or reshaped data), or from rows you read in a document (columns + rows). Then chart it like any table.",
      inputSchema: z.object({
        name: z.string().max(60),
        sql: z.string().max(12000).optional(),
        columns: z.array(z.string()).max(60).optional(),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(5000).optional(),
        source: z.string().max(200).optional().describe("Where the data came from, e.g. the document name and page"),
      }),
      run: async ({ name, sql, columns, rows, source }) => {
        const { cleanHeadings, loadRows } = await import("./engine");
        const old = a.tables.find((t) => t.name.toLowerCase() === name.toLowerCase() && t.derived);
        const t = old ? old.name : freeName(a, name);
        try {
          let cols;
          if (sql) cols = await tableFromQuery(a, t, sql);
          else if (columns?.length && rows?.length) {
            const heads = cleanHeadings(columns, columns.length);
            cols = await loadRows(a, t, heads, rows.map((r) => heads.map((_, i) => (r[i] === null || r[i] === undefined ? "" : String(r[i])))));
          } else return "Give sql, or columns and rows.";
          const n = await rowCount(a, t);
          a.tables = [...a.tables.filter((x) => x.name !== t), { name: t, source: source || (sql ? "made from a query" : "made from a document"), rows: n, columns: cols, derived: true }];
          a.dataVersion = (a.dataVersion ?? 0) + 1;
          a.links = await discoverLinks(a).catch(() => a.links ?? []);
          on({ type: "tables", tables: a.tables });
          note(`Made table ${t}`);
          await save();
          return `Saved table "${t}": ${n} rows, columns ${cols.map((c) => `${c.name} ${c.type}`).join(", ")}`;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    }),
    betaZodTool({
      name: "add_chart",
      description: "Add a chart, KPI, insight card or table to the board (after: id of the chart to place it after; leave out for the end). Returns the data it shows, so check it.",
      inputSchema: z.object({ ...chartShape, after: z.string().optional() }),
      run: async ({ after, ...w }) => addOne(w as Omit<Widget, "id">, after),
    }),
    betaZodTool({
      name: "add_charts",
      description:
        "Add several board items in one go (up to 12), in order: faster than one call each. Each is checked like add_chart; items that fail are reported and the rest are still added.",
      inputSchema: z.object({ items: z.array(z.object(chartShape)).min(1).max(12) }),
      run: async ({ items }) => {
        const out: string[] = [];
        for (const [i, w] of items.entries()) out.push(`${i + 1}. ${w.title}: ${await addOne(w as Omit<Widget, "id">)}`);
        return out.join("\n\n");
      },
    }),
    betaZodTool({
      name: "set_link",
      description:
        "Fix the data map: link two columns that hold the same values (e.g. salary sheet 'Emp. Code' = attendance 'PayCode'), or turn off a wrong link (off: true). Links drive joins and make board filters reach linked tables.",
      inputSchema: z.object({
        from_table: z.string(),
        from_column: z.string(),
        to_table: z.string(),
        to_column: z.string(),
        off: z.boolean().optional(),
        note: z.string().max(200).optional(),
      }),
      run: async ({ from_table, from_column, to_table, to_column, off, note: why }) => {
        const has = (t: string, c: string) => a.tables.some((x) => x.name === t && x.columns.some((y) => y.name === c));
        if (!has(from_table, from_column) || !has(to_table, to_column)) return "One of those columns doesn't exist; check the table and column names.";
        const same = (l: { from: { table: string; column: string }; to: { table: string; column: string } }) =>
          (l.from.table === from_table && l.from.column === from_column && l.to.table === to_table && l.to.column === to_column) ||
          (l.to.table === from_table && l.to.column === from_column && l.from.table === to_table && l.from.column === to_column);
        const old = (a.links ?? []).find(same);
        const r = await query(
          a,
          `SELECT count(DISTINCT x.v) FROM (SELECT lower(trim(CAST("${from_column.replace(/"/g, '""')}" AS VARCHAR))) v FROM "${from_table.replace(/"/g, '""')}") x JOIN (SELECT lower(trim(CAST("${to_column.replace(/"/g, '""')}" AS VARCHAR))) v FROM "${to_table.replace(/"/g, '""')}") y USING (v)`,
          { limit: 1 },
        ).catch(() => null);
        const shared = Number(r?.rows[0]?.[0] ?? 0);
        const link = {
          id: old?.id ?? randomUUID().slice(0, 8),
          from: { table: from_table, column: from_column },
          to: { table: to_table, column: to_column },
          match: old?.match ?? 0,
          shared,
          kind: old?.kind ?? ("n:n" as const),
          by: "ai" as const,
          off: !!off,
          note: why,
        };
        a.links = [...(a.links ?? []).filter((l) => !same(l)), link];
        note(off ? `Removed link ${from_table}.${from_column} ↔ ${to_table}.${to_column}` : `Linked ${from_table}.${from_column} ↔ ${to_table}.${to_column}`);
        await save();
        return off ? "Link turned off." : `Linked (${shared} shared values).`;
      },
    }),
    betaZodTool({
      name: "update_chart",
      description: "Change a board item: any of its fields (kind, title, insight, sql, x, y, size…). Fields left out stay as they are.",
      inputSchema: z.object({ id: z.string(), ...Object.fromEntries(Object.entries(chartShape).map(([k, v]) => [k, (v as z.ZodType).optional()])) }),
      run: async ({ id, ...patch }) => {
        const i = a.board.findIndex((x) => x.id === id);
        if (i < 0) return `No board item ${id}.`;
        const next = { ...a.board[i], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Widget;
        try {
          const check = await checkChart(next);
          if (check.startsWith("The query") || check.startsWith("This chart")) return `Not changed. ${check}`;
          a.board[i] = next;
          on({ type: "board", board: a.board });
          note(`Updated ${next.title}`);
          await save();
          return `Updated. ${check}`;
        } catch (e) {
          return `Not changed. SQL error: ${(e as Error).message}`;
        }
      },
    }),
    betaZodTool({
      name: "remove_chart",
      description: "Remove items from the board.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
      run: async ({ ids }) => {
        a.board = a.board.filter((w) => !ids.includes(w.id));
        on({ type: "board", board: a.board });
        note(`Removed ${ids.length} item${ids.length > 1 ? "s" : ""}`);
        await save();
        return "Removed.";
      },
    }),
    betaZodTool({
      name: "arrange_board",
      description: "Put the board in this order (ids, first to last). Items left out keep their place at the end.",
      inputSchema: z.object({ ids: z.array(z.string()) }),
      run: async ({ ids }) => {
        const rank = (w: Widget) => {
          const i = ids.indexOf(w.id);
          return i < 0 ? ids.length + a.board.indexOf(w) : i;
        };
        a.board = [...a.board].sort((x, y) => rank(x) - rank(y));
        on({ type: "board", board: a.board });
        await save();
        return "Arranged.";
      },
    }),
    betaZodTool({
      name: "rename",
      description: "Give the analysis a short descriptive name (e.g. 'HR attendance & payroll, FY25').",
      inputSchema: z.object({ name: z.string().min(2).max(80) }),
      run: async ({ name }) => {
        a.name = name.replace(/\s+/g, " ").trim();
        on({ type: "name", name: a.name });
        await save();
        return "Renamed.";
      },
    }),
    betaZodTool({
      name: "suggest_next",
      description: "Offer 3–5 specific follow-up questions as buttons under your reply.",
      inputSchema: z.object({ questions: z.array(z.string().max(160)).min(1).max(6) }),
      run: async ({ questions: qs }) => {
        questions = qs;
        on({ type: "questions", questions: qs });
        return "Shown.";
      },
    }),
  ];

  // What the AI knows going in: every table profiled (small ones whole), how they link, documents, the board.
  step("Reading the data");
  // The profile and the scan only change with the data: reuse them across turns (much faster, fewer tokens).
  const version = a.dataVersion ?? 0;
  if (a.cache?.version !== version) a.cache = { version };
  const cache = a.cache!;
  if (cache.profile === undefined) cache.profile = a.tables.length ? await profile(a, { sampleRows: a.tables.length > 8 ? 3 : 8, wholeUnder: 60, budget: 70_000 }) : "No tables yet.";
  if (cache.scan === undefined && a.tables.length) {
    step("Scanning for what stands out");
    cache.scan = await scan(a).catch(() => "");
  }
  if (a.tables.length > 1 && !a.links) a.links = await discoverLinks(a).catch(() => []);
  const prof = cache.profile;
  const joins = linksText(a);
  const docs = a.sources.filter((s) => s.textChars).map((s) => `- [${s.id}] ${s.name}: ${s.kind}, ${s.textChars!.toLocaleString()} characters of text${s.tables.length ? `, tables: ${s.tables.join(", ")}` : ""}`);
  const context = [
    `# Analysis: ${a.name}`,
    `## Files\n${a.sources.map((s) => `- ${s.name} (${s.kind}${s.tables.length ? `; tables: ${s.tables.map((t) => `"${t}"`).join(", ")}` : ""}${s.note ? `; ${s.note}` : ""})`).join("\n") || "None yet."}`,
    `## Tables\n${prof}`,
    joins ? `## How tables link (data map: columns holding the same values)\n${joins}` : "",
    cache.scan ? `## Notable facts (an automatic scan; verify before stating)\n${cache.scan}` : "",
    docs.length ? `## Documents to read with read_document\n${docs.join("\n")}` : "",
    `## Board now\n${boardText(a.board)}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 180_000);

  const history = a.chat.slice(-16).map((m) => ({ role: m.role, content: m.text || "(no text)" }));
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive", display: "summarized" },
    cache_control: { type: "ephemeral" },
    stream: true,
    max_iterations: 60,
    system: SYSTEM,
    tools,
    messages: [...history, { role: "user", content: `${context}\n\n---\n\n${text}` }],
  });

  let input = 0;
  let output = 0;
  let reply = "";
  for await (const stream of runner) {
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") on({ type: "thought", delta: ev.delta.thinking });
      else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        reply += ev.delta.text;
        on({ type: "text", delta: ev.delta.text });
      } else if (ev.type === "content_block_start" && ev.content_block.type === "text" && reply && !reply.endsWith("\n")) {
        reply += "\n\n";
        on({ type: "text", delta: "\n\n" });
      }
    }
    const m = await stream.finalMessage();
    input += m.usage.input_tokens + (m.usage.cache_read_input_tokens ?? 0) / 10 + (m.usage.cache_creation_input_tokens ?? 0);
    output += m.usage.output_tokens;
    if (m.stop_reason === "pause_turn") runner.pushMessages({ role: "assistant", content: m.content });
  }
  await charge(a.workspaceId, creditsForUsage(input, output), "GENERATION", undefined, { category: "chat", userId });
  const now = new Date().toISOString();
  a.chat.push({ role: "user", text, at: now }, { role: "assistant", text: reply.trim() || "Done.", at: now, steps, questions });
  a.questions = questions;
  await save();
  return { reply: reply.trim(), questions, steps };
}
