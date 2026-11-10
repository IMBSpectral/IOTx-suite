import { analysisFor, insightsRoute } from "@/lib/insights/http";
import { query, type Filter } from "@/lib/insights/engine";

type Ctx = { params: Promise<{ id: string }> };
const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

/**
 * POST { widgets?: string[], filters?: Filter[] } -> { results: { [widgetId]: { columns, rows } | { error } } }
 * POST { table, offset?, limit?, sort?, desc?, search?, filters? } -> { columns, rows, total } (the data grid)
 */
export const POST = insightsRoute(async (req: Request, { params }: Ctx) => {
  const { a } = await analysisFor((await params).id);
  const body = (await req.json().catch(() => ({}))) as {
    widgets?: string[];
    filters?: Filter[];
    table?: string;
    offset?: number;
    limit?: number;
    sort?: string;
    desc?: boolean;
    search?: string;
  };
  const filters = (Array.isArray(body.filters) ? body.filters : []).slice(0, 20);

  if (body.table) {
    const t = a.tables.find((x) => x.name === body.table);
    if (!t) return Response.json({ error: "No such table" }, { status: 404 });
    const limit = Math.min(500, Math.max(1, Number(body.limit) || 100));
    const offset = Math.max(0, Number(body.offset) || 0);
    const sortCol = t.columns.find((c) => c.name === body.sort);
    const search = body.search?.trim().slice(0, 100);
    const pattern = search ? "%" + search.replace(/[%_\\]/g, (m) => "\\" + m).replace(/'/g, "''") + "%" : "";
    const where = search ? `WHERE ${t.columns.map((c) => `CAST(${q(c.name)} AS VARCHAR) ILIKE '${pattern}' ESCAPE '\\'`).join(" OR ")}` : "";
    const base = `FROM ${q(t.name)} ${where}`;
    const order = sortCol ? `ORDER BY ${q(sortCol.name)} ${body.desc ? "DESC" : "ASC"} NULLS LAST` : "";
    const rows = await query(a, `SELECT * ${base} ${order} LIMIT ${limit} OFFSET ${offset}`, { limit, filters });
    const total = await query(a, `SELECT count(*) ${base}`, { limit: 1, filters });
    return Response.json({ columns: rows.columns, rows: rows.rows, total: Number(total.rows[0]?.[0] ?? 0) });
  }

  const want = Array.isArray(body.widgets) ? new Set(body.widgets) : null;
  const results: Record<string, unknown> = {};
  for (const w of a.board) {
    if (want && !want.has(w.id)) continue;
    if (!w.sql) continue;
    try {
      results[w.id] = await query(a, w.sql, { limit: 5000, filters });
    } catch (e) {
      results[w.id] = { error: (e as Error).message };
    }
  }
  return Response.json({ results });
});
