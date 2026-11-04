import { requireUser, requireProject } from "@/lib/workspace";
import { getConfig } from "@/lib/security";
import { route } from "@/lib/route";

/** Export the last dependency audit as CSV or JSON. */
async function GET_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  const audit = (await getConfig(id)).audit;
  if (!audit) return Response.json({ error: "Run a scan first." }, { status: 404 });

  const format = new URL(req.url).searchParams.get("format") === "csv" ? "csv" : "json";
  const name = `${project.slug}-dependencies.${format}`;
  if (format === "json") {
    return new Response(JSON.stringify(audit, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${name}"` },
    });
  }
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [["package", "severity", "affected", "fix available", "advisory", "title", "url"].join(",")];
  for (const p of audit.packages) {
    const advisories = p.advisories.length ? p.advisories : [{ id: "", title: "", url: "", severity: p.severity }];
    for (const a of advisories) {
      rows.push([p.name, p.severity, p.range, p.fixAvailable ? "yes" : "no", a.id, a.title, a.url ?? ""].map(q).join(","));
    }
  }
  return new Response(rows.join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
  });
}

export const GET = route(GET_);
