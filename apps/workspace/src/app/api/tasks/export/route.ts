import { requireMe } from "@/lib/auth";
import { queryFromParams } from "@/lib/tasks";
import { exportCsv } from "@/lib/tasks-plan";
import { route } from "@/lib/http";

/** GET (same filters as /api/tasks) -> a CSV file of the matching issues, subtasks included */
async function GET_(req: Request) {
  const me = await requireMe("tasks.open");
  const csv = await exportCsv(me, queryFromParams(new URL(req.url).searchParams));
  return new Response(`﻿${csv}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="issues-${new Date().toISOString().slice(0, 10)}.csv"` } });
}

export const GET = route(GET_);
