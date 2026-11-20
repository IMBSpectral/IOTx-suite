import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { requirePerm } from "@/lib/iotx/permissions";
import { driveContent, fileMeta, GoogleError } from "@/lib/google";

/** Download a file from the person's Google Drive (Google Docs, Sheets and Slides as Markdown, CSV and text). */
async function GET_(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requirePerm(user.id, ws.id, "gdrive.open", "gdrive.download");
  const { id } = await params;
  try {
    const meta = await fileMeta(user.id, id);
    const f = await driveContent(user.id, { id, name: meta.name, mimeType: meta.mimeType, modifiedTime: meta.modifiedTime ?? "", size: meta.size });
    return new Response(new Uint8Array(f.data), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof GoogleError) return new Response(e.message, { status: e.code && e.code < 500 ? e.code : 502 });
    throw e;
  }
}

export const GET = route(GET_);
