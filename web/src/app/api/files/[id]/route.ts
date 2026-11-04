import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError } from "@/lib/iotx/permissions";
import { download } from "@/lib/files";

/** GET a file's contents: a download, or ?inline=1 to show it (images, PDF, video, audio, plain text). */
async function GET_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const { id } = await params;
  try {
    return await download(user.id, ws.id, id, new URL(req.url).searchParams.get("inline") === "1");
  } catch (e) {
    if (e instanceof PermissionError) return new Response(e.message, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
