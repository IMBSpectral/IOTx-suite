import { requireMe } from "@/lib/auth";
import { importCsv } from "@/lib/tasks-plan";
import { bad, route } from "@/lib/http";

/** POST text/csv (or multipart "file") -> { created, errors }: up to 1000 rows */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe(["tasks.open", "tasks.create"]);
  let text = "";
  if ((req.headers.get("content-type") ?? "").includes("multipart")) {
    const f = (await req.formData().catch(() => null))?.get("file");
    if (f instanceof File) text = await f.text();
  } else text = await req.text();
  if (!text.trim()) bad("Choose a CSV file.");
  if (text.length > 5_000_000) bad("The file is too big (5 MB at most).");
  return Response.json(await importCsv(me, (await ctx.params).id, text.replace(/^﻿/, "")));
}

export const POST = route(POST_);
