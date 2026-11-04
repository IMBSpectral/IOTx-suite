import { readExportLink } from "@/lib/cloud-export-link";

/** A database export behind a signed, 24-hour link that was emailed to the person who asked for it. */
export async function GET(req: Request, { params }: { params: Promise<{ projectId: string; file: string }> }) {
  const { projectId, file } = await params;
  const q = new URL(req.url).searchParams;
  const bytes = await readExportLink(projectId, file, Number(q.get("exp")), q.get("sig") ?? "");
  if (!bytes) return new Response("This download link is invalid or has expired. Ask for a new one from the app's Cloud → Backups.", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": file.endsWith(".sql") ? "application/sql; charset=utf-8" : "application/vnd.sqlite3",
      "content-disposition": `attachment; filename="${file}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
